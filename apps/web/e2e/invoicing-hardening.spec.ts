import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../test-support/streamed";
import { cleanupCompanies } from "../test-support/company-cleanup";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";
import { einvoicePack } from "../../../packages/localization/co/src/einvoice/pack";
import { generateTestCertP12 } from "../../../packages/localization/co/src/__tests__/helpers/test-cert";

// Resolution and certificate hardening (plan 2B Task 37; owner decisions items 24 and 25):
//   1. an invoice keeps the DIAN environment it was issued in: after the company moves to producción, «Reintentar todos» sends the same
//      document again, accepted, and the document still names habilitación (frozen `dian_environment`, same CUFE);
//   2. «Reintentar todos» is the company administrator's: the server action, replayed from a member's session (a member holding the process),
//      answers the refusal and nothing is requeued;
//   3. the certificate warning: none while the Vault holds the certificate the settings describe; «mismatch» when the secret is overwritten;
//      «No se pudo verificar» when the Vault wrapper cannot be read; no key material in the page.

const CHAIN = join(__dirname, "..", "test-support", "invoicing-chain.mts");
const DIAN = join(__dirname, "..", "test-support", "mock-dian.mts");
const CUSTOMER = "860002964";
const NIT = "900373115";
const PIN = "75315";
const PROCESSES = [
  "invoicing.settings.consult", "invoicing.settings.update", "invoicing.certificate.upload", "invoicing.software_pin.set",
  "invoicing.invoice.resubmit_failed", "core.document_sequence.register",
  "invoicing.dian_checklist.tick", "invoicing.dian_checklist.consult", "invoicing.dian_defaults.confirm",
];

/** Puts kernel.secret_fingerprint back if a killed run left it renamed (idempotent). */
const restoreFingerprint = (f: AuthFixture) => f.sql`do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'kernel' and p.proname = 'secret_fingerprint_e2e_off')
     and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'kernel' and p.proname = 'secret_fingerprint') then
    alter function kernel.secret_fingerprint_e2e_off(text) rename to secret_fingerprint;
  end if; end $$`;

const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
const lastJson = <T>(out: string): T => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as T;

test.describe("invoicing hardening", () => {
  test.describe.configure({ mode: "serial" });
  let admin: AuthFixture;
  let secret: string;
  let member: AuthFixture;
  let memberSecret: string;
  let companyId: string;
  let memberInvoiceId: string;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    admin = await seedAuthUser({ role: "admin" });
    await restoreFingerprint(admin);
    secret = await enrolTotp(admin);
    companyId = admin.companyIds[0]!;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing"]) {
      await admin.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${admin.tenantId}, ${key}, 'manual')`;
    }
    lastJson(tsx(CHAIN, [companyId, admin.userId]));
    // A member who holds the «Reintentar todos» process (and the page's others) without being the company's administrator.
    member = await seedAuthUser({ role: "member" });
    memberSecret = await enrolTotp(member);
    const memberCompany = member.companyIds[0]!;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing"]) {
      await member.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${member.tenantId}, ${key}, 'manual')`;
    }
    const [role] = await member.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${memberCompany} and name = 'member'`;
    for (const process of PROCESSES) await member.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${memberCompany}, ${role!.id}, ${process}) on conflict do nothing`;
    // The member's company has something to requeue: an issued invoice whose sending stopped (so «nothing requeued» can fail).
    // (The chain's setup runs administrator-only processes: the role is a system role only while it runs, then a plain one again.)
    await member.sql`update kernel.roles set is_system = true, name = 'admin' where id = ${role!.id}`;
    let issued: { invoiceId: string };
    try {
      lastJson(tsx(CHAIN, [memberCompany, member.userId]));
      issued = lastJson<{ invoiceId: string }>(tsx(CHAIN, [memberCompany, member.userId, "--issue", CUSTOMER]));
      tsx(DIAN, ["invoice", issued.invoiceId, "rejected", "Regla FAD06: error simulado"]);
    } finally {
      await member.sql`update kernel.roles set is_system = false, name = 'member' where id = ${role!.id}`;
    }
    await member.sql`update invoicing.einvoice_submissions set status = 'failed', decided_at = null, last_error = 'einvoice_transport: caída' where invoice_id = ${issued.invoiceId} and note_id is null`;
    memberInvoiceId = issued.invoiceId;
  });

  test.afterAll(async () => {
    if (admin) await restoreFingerprint(admin).catch(() => undefined);
    for (const f of [member, admin]) {
      if (!f) continue;
      try {
        await f.sql`delete from vault.secrets where name like ${`dian/${f.companyIds[0]!}/%`}`;
        await cleanupCompanies(f.sql, f.companyIds, f.tenantId);
      } finally {
        await f.cleanup();
      }
    }
  });

  test("an invoice keeps its issue-time environment through «Reintentar todos»; a member's request is refused and nothing is requeued", async ({ page, browser, baseURL }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const { invoiceId } = lastJson<{ invoiceId: string }>(tsx(CHAIN, [companyId, admin.userId, "--issue", CUSTOMER]));
    const document = async () => (await admin.sql<{ dian_environment: string | null; cufe: string | null; number: string | null }[]>`select dian_environment, cufe, number from invoicing.invoices where id = ${invoiceId}`)[0]!;
    const submission = async () => (await admin.sql<{ status: string; round: number }[]>`select status, round from invoicing.einvoice_submissions where invoice_id = ${invoiceId} and note_id is null`)[0]!;
    const issued = await document();
    // Issued under habilitación: the environment and the CUFE (which the QR of the DIAN's query carries) are stamped at «Emitir».
    expect(issued.dian_environment).toBe("habilitacion");
    expect(issued.cufe).toMatch(/^[0-9a-f]{96}$/);

    tsx(DIAN, ["invoice", invoiceId, "rejected", "Regla FAD06: error simulado"]);
    // The company moves to producción (service SQL: the real switch needs the checklist and a real transport), and the sending stopped.
    await admin.sql`update invoicing.settings set certificate_uploaded_at = coalesce(certificate_uploaded_at, now()), software_pin_set_at = coalesce(software_pin_set_at, now()), dian_defaults_confirmed = true, dian_checklist_version = ${einvoicePack.dianChecklist.version}, dian_environment = 'produccion' where company_id = ${companyId}`;
    await admin.sql`update invoicing.einvoice_submissions set status = 'failed', decided_at = null, last_error = 'einvoice_transport: caída' where invoice_id = ${invoiceId} and note_id is null`;

    await signInWithCode(page, admin, secret);
    await page.goto("/invoicing/settings");
    const pending = page.getByRole("region", { name: "Envíos pendientes" });
    // The server action's request, kept to be replayed from the member's session below.
    const actionRequest = page.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
    await pending.getByRole("button", { name: "Reintentar todos" }).click();
    const sent = await actionRequest;
    await expect(pending.getByRole("status")).toHaveText("Se volvieron a enviar 1");
    expect(await submission()).toMatchObject({ status: "queued" });
    tsx(DIAN, ["invoice", invoiceId, "accepted"]);

    // The kept document: accepted, the same number and CUFE, still the habilitación environment (so the same QR of the DIAN's query).
    await page.goto(`/r/invoicing.invoice/${invoiceId}`);
    await expect(page.locator(".erp-record").filter({ visible: true }).getByTestId("invoice-dian")).toHaveText("Aceptada");
    expect(await document()).toEqual(issued);
    // Its PDF still prints (the QR is drawn from the frozen environment: pinned on the QR text by the workflow's integration test).
    const job = page.waitForResponse((r) => /\/api\/export\/[0-9a-f-]{36}$/.test(r.url()));
    await page.getByRole("group", { name: "Acciones del registro" }).getByRole("button", { name: "Imprimir" }).click();
    expect(((await (await job).json()) as { fileName?: string }).fileName).toMatch(/\.pdf$/);

    // (2) The same server action, replayed from a member's session: refused, nothing requeued.
    const context = await browser.newContext({ baseURL: baseURL! });
    try {
      const memberPage = await context.newPage();
      await signInWithCode(memberPage, member, memberSecret);
      const headers = { ...sent.headers() };
      for (const name of ["cookie", "host", "content-length", "connection"]) delete headers[name];
      const answer = await context.request.post(sent.url(), { headers, data: sent.postData() ?? "" });
      const text = await answer.text();
      expect(text).toContain('"ok":false');
      expect(text).toContain('"code":"forbidden"');
      expect(text).not.toContain('"requeued"');
    } finally {
      await context.close();
    }
    const [requested] = await member.sql<{ n: number }[]>`select count(*)::int as n from kernel.outbox where company_id = ${member.companyIds[0]!} and event = 'invoicing.invoice.resubmit_requested'`;
    expect(requested!.n).toBe(0);
    const [stillFailed] = await member.sql<{ status: string }[]>`select status from invoicing.einvoice_submissions where invoice_id = ${memberInvoiceId} and note_id is null`;
    expect(stillFailed!.status).toBe("failed");
    const [denied] = await member.sql<{ n: number }[]>`select count(*)::int as n from kernel.audit_log where company_id = ${member.companyIds[0]!} and process_id = 'invoicing.invoice.resubmit_failed' and action = 'denied'`;
    expect(denied!.n).toBeGreaterThan(0);
  });

  test("the certificate warning: none when the Vault matches, «mismatch» when the secret is replaced, «No se pudo verificar» when the Vault cannot be read; no key material in the page", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Back to habilitación (the first test moved the company by service SQL) with the metadata its switch needed cleared.
    await admin.sql`update invoicing.settings set dian_environment = 'habilitacion', certificate_uploaded_at = null, software_pin_set_at = null where company_id = ${companyId}`;
    await signInWithCode(page, admin, secret);
    await page.goto("/invoicing/settings");
    const certificate = page.getByRole("region", { name: "Certificado de firma digital" });
    const cert = generateTestCertP12({ subjectNit: NIT, cn: "CAFE DEL NORTE SAS PRUEBA", serial: "0a19" });
    const certPath = test.info().outputPath("certificado-prueba.p12");
    writeFileSync(certPath, cert.buffer);
    await certificate.getByLabel("Archivo .p12").setInputFiles(certPath);
    await certificate.getByLabel("Contraseña del certificado").fill(cert.password);
    await certificate.getByRole("button", { name: "Subir certificado" }).click();
    await confirmStepUp(page, secret);
    await expect(certificate.getByRole("status")).toHaveText("Certificado guardado");
    const pin = page.getByRole("region", { name: "PIN del software" });
    await pin.getByLabel("PIN del software").fill(PIN);
    await pin.getByRole("button", { name: "Guardar PIN" }).click();
    await confirmStepUp(page, secret);
    await expect(pin.getByRole("status")).toHaveText("PIN guardado");

    const noKeyMaterial = async () => {
      const html = await page.content();
      for (const bad of ["BEGIN", cert.password, PIN, cert.buffer.toString("base64").slice(0, 60)]) expect(html, bad).not.toContain(bad);
    };
    const alert = page.getByTestId("certificate-status");

    // The certificate stored is the one the settings describe: no alert.
    await page.goto("/invoicing/settings");
    await expect(page.getByRole("region", { name: "Certificado de firma digital" })).toContainText("0a19");
    await expect(alert).toHaveCount(0);
    await noKeyMaterial();

    // The secret is overwritten with another value: «mismatch».
    const name = `dian/${companyId}/certificate`;
    await admin.sql`select kernel.secret_write(${name}, 'otro-valor')`;
    await page.reload();
    await expect(alert).toHaveAttribute("data-status", "mismatch");
    await expect(alert).toContainText("no es el que describen estos datos");
    await noKeyMaterial();
    // Put it back (upload again) so the next check starts from a healthy store.
    await page.getByRole("region", { name: "Certificado de firma digital" }).getByLabel("Archivo .p12").setInputFiles(certPath);
    await page.getByRole("region", { name: "Certificado de firma digital" }).getByLabel("Contraseña del certificado").fill(cert.password);
    await page.getByRole("region", { name: "Certificado de firma digital" }).getByRole("button", { name: "Subir certificado" }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("region", { name: "Certificado de firma digital" }).getByRole("status")).toHaveText("Certificado guardado");
    await page.reload();
    await expect(alert).toHaveCount(0);

    // The Vault wrapper cannot be read: «No se pudo verificar», never a mismatch nor an error page.
    await admin.sql`alter function kernel.secret_fingerprint(text) rename to secret_fingerprint_e2e_off`;
    try {
      await page.reload();
      await expect(alert).toHaveAttribute("data-status", "unreadable");
      await expect(alert).toContainText("No se pudo verificar el certificado guardado");
      await expect(page.getByRole("heading", { name: "Facturación electrónica" })).toBeVisible();
      await noKeyMaterial();
      expect(await page.content()).not.toContain("secret_fingerprint");
    } finally {
      await restoreFingerprint(admin);
    }
    await page.reload();
    await expect(alert).toHaveCount(0);
  });
});
