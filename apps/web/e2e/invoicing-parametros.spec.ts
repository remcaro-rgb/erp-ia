import { writeFileSync } from "node:fs";
import { expect, test } from "../test-support/streamed";
import { cleanupCompanies } from "../test-support/company-cleanup";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";
import { generateTestCertP12 } from "../../../packages/localization/co/src/__tests__/helpers/test-cert";

// Parámetros › Facturación electrónica (plan 2B Task 19; prototype 2B /invoicing/settings): the company's administrator registers the DIAN
// resolution of invoices and the numbering of credit notes, uploads the signing certificate (a self-signed test certificate generated here,
// written only to the test's own output folder, never committed) and the software PIN, each behind the verification code; the page shows
// what the certificate says of itself (subject, serial, expiry), never its content; producción is refused while the DIAN defaults are not
// confirmed (the checklist's own spec, invoicing-dian-checklist, ticks and confirms them: Task 35); «Reintentar todos» sweeps the invoices that waited for the software. A user who is not an administrator cannot open the page.

const NIT = "900373115";
const PROCESSES = [
  "invoicing.settings.consult", "invoicing.settings.update", "invoicing.certificate.upload", "invoicing.software_pin.set",
  "invoicing.invoice.resubmit_failed", "core.document_sequence.register",
  // Task 35: the DIAN verification checklist.
  "invoicing.dian_checklist.tick", "invoicing.dian_checklist.consult", "invoicing.dian_defaults.confirm",
];

const grantAll = async (fixture: AuthFixture, roleName: "admin" | "member") => {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  for (const key of ["module:core", "module:accounting", "module:invoicing", "module:sales", "module:inventory"]) {
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual') on conflict do nothing`;
  }
  const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = ${roleName}`;
  for (const process of PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process}) on conflict do nothing`;
  await sql`update kernel.companies set tax_id = ${NIT} where id = ${companyId}`;
};

const cleanup = async (fixture: AuthFixture | undefined) => {
  if (!fixture) return;
  try {
    await fixture.sql`delete from vault.secrets where name like ${`dian/${fixture.companyIds[0]!}/%`}`;
    await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
  } finally {
    await fixture.cleanup();
  }
};

test.describe("Parámetros de facturación electrónica", () => {
  test.describe.configure({ mode: "serial" });
  let admin: AuthFixture;
  let secret: string;

  test.beforeAll(async () => {
    admin = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(admin);
    await grantAll(admin, "admin");
  });

  test.afterAll(async () => {
    await cleanup(admin);
  });

  test("the administrator registers the resolution and the notes' numbering, the certificate and the PIN; producción waits for the DIAN defaults", async ({ page }) => {
    test.setTimeout(150_000);
    const companyId = admin.companyIds[0]!;
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, admin, secret);
    await page.goto("/invoicing/settings");
    await expect(page.getByRole("heading", { name: "Facturación electrónica" })).toBeVisible();

    // The DIAN resolution of invoices (prefix, range, validity, technical key), behind the code.
    const year = new Date().getFullYear();
    const numbering = page.getByRole("region", { name: "Resolución y numeración" });
    await numbering.getByLabel("Documento").selectOption({ label: "Factura electrónica de venta" });
    await numbering.getByLabel("Prefijo").fill("FE");
    await numbering.getByLabel("Número de resolución").fill("18760000009");
    await numbering.getByLabel("Desde", { exact: true }).fill("1");
    await numbering.getByLabel("Hasta", { exact: true }).fill("5000");
    await numbering.getByLabel("Vigente desde").fill(`${year}-01-01`);
    await numbering.getByLabel("Vigente hasta").fill(`${year + 1}-12-31`);
    await numbering.getByLabel("Clave técnica").fill("fc8eac422eba16e22ffd8c6f94b3f40a6e38162c");
    await numbering.getByRole("button", { name: "Registrar numeración" }).click();
    await confirmStepUp(page, secret);
    await expect(numbering.getByRole("status")).toHaveText("Numeración registrada");
    const table = numbering.getByRole("table", { name: "Numeraciones registradas" });
    await expect(table.getByRole("row", { name: /18760000009/ })).toContainText("FE");
    // The technical key is shown by its last characters only.
    await expect(table).toContainText("•••• 162c");
    await expect(table).not.toContainText("fc8eac422eba");
    const [row] = await admin.sql<{ next_number: string; resolution: Record<string, unknown> }[]>`
      select next_number::text, resolution from core.document_sequences where company_id = ${companyId} and document_type = 'invoice' and prefix = 'FE'`;
    // The key is kept apart (migration 0104): the row carries its last characters.
    expect(row).toMatchObject({ next_number: "1", resolution: { number: "18760000009", from: 1, technicalKeyEnding: "162c" } });
    expect(row!.resolution).not.toHaveProperty("technicalKey");
    const [kept] = await admin.sql<{ technical_key: string }[]>`
      select technical_key from core.document_resolution_keys where company_id = ${companyId} and prefix = 'FE' and resolution_number = '18760000009'`;
    expect(kept!.technical_key).toBe("fc8eac422eba16e22ffd8c6f94b3f40a6e38162c");

    // The credit notes' own numbering (no resolution).
    await numbering.getByLabel("Documento").selectOption({ label: "Nota crédito" });
    await numbering.getByLabel("Prefijo").fill("NC");
    await numbering.getByRole("button", { name: "Registrar numeración" }).click();
    await confirmStepUp(page, secret);
    await expect(numbering.getByRole("status")).toHaveText("Numeración registrada");
    await expect(table.getByRole("row", { name: /Nota crédito/ })).toContainText("NC");

    // The signing certificate: a self-signed test certificate of the company's NIT, generated now (never committed).
    const certificate = page.getByRole("region", { name: "Certificado de firma digital" });
    const cert = generateTestCertP12({ subjectNit: NIT, cn: "CAFE DEL NORTE SAS PRUEBA", serial: "0a19" });
    const certPath = test.info().outputPath("certificado-prueba.p12");
    writeFileSync(certPath, cert.buffer);
    await certificate.getByLabel("Archivo .p12").setInputFiles(certPath);
    await certificate.getByLabel("Contraseña del certificado").fill(cert.password);
    await certificate.getByRole("button", { name: "Subir certificado" }).click();
    await confirmStepUp(page, secret);
    await expect(certificate.getByRole("status")).toHaveText("Certificado guardado");
    await expect(certificate).toContainText("CAFE DEL NORTE SAS PRUEBA");
    await expect(certificate).toContainText("0a19");
    await expect(certificate).toContainText(NIT);
    // Kept in Supabase Vault (encrypted), not in the settings.
    const [stored] = await admin.sql<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${`dian/${companyId}/certificate`}`;
    expect(stored!.n).toBe(1);
    await expect(page.locator("body")).not.toContainText(cert.password);

    // The software (its id) and its PIN.
    const dian = page.getByRole("region", { name: "Conexión DIAN" });
    await dian.getByLabel("Identificador del software").fill("56f2ae4e-9812-4fad-9255-08fcfcd5ccb0");
    await dian.getByLabel("NIT del proveedor del software").fill(NIT);
    await dian.getByRole("button", { name: "Guardar conexión" }).click();
    await confirmStepUp(page, secret);
    await expect(dian.getByRole("status")).toHaveText("Parámetros guardados");
    const pin = page.getByRole("region", { name: "PIN del software" });
    await pin.getByLabel("PIN del software").fill("75315");
    await pin.getByRole("button", { name: "Guardar PIN" }).click();
    await confirmStepUp(page, secret);
    await expect(pin.getByRole("status")).toHaveText("PIN guardado");
    await expect(pin.getByLabel("PIN del software")).toHaveValue("");

    // Task 35: the old checkbox is gone; the card shows the checklist's progress and a link to it.
    await expect(dian.getByRole("checkbox")).toHaveCount(0);
    await expect(dian.getByText("Valores por defecto DIAN: 0 de 23 verificados")).toBeVisible();
    await expect(dian.getByRole("link", { name: "Abrir la lista de verificación" })).toHaveAttribute("href", "/invoicing/settings/checklist");

    // Producción while the DIAN defaults are not confirmed: refused (naming the checklist), the company stays in habilitación.
    await dian.getByLabel("Ambiente DIAN").selectOption({ label: "Producción" });
    await dian.getByRole("button", { name: "Guardar conexión" }).click();
    await confirmStepUp(page, secret);
    await expect(dian.getByRole("alert")).toContainText("Verifica los 23 valores pendientes en la lista de verificación DIAN");
    const [settings] = await admin.sql<{ dian_environment: string; dian_defaults_confirmed: boolean }[]>`
      select dian_environment, dian_defaults_confirmed from invoicing.settings where company_id = ${companyId}`;
    expect(settings).toEqual({ dian_environment: "habilitacion", dian_defaults_confirmed: false });

    // «Reintentar todos»: nothing waiting, nothing sent again.
    const pending = page.getByRole("region", { name: "Envíos pendientes" });
    await pending.getByRole("button", { name: "Reintentar todos" }).click();
    await expect(pending.getByRole("status")).toHaveText("No había envíos por reintentar");
  });
});

test.describe("Parámetros de facturación electrónica for a user who is not an administrator", () => {
  let member: AuthFixture;
  let secret: string;

  test.beforeAll(async () => {
    member = await seedAuthUser({ role: "member" });
    secret = await enrolTotp(member);
    await grantAll(member, "member");
  });

  test.afterAll(async () => {
    await cleanup(member);
  });

  test("cannot open the page (even holding the processes)", async ({ page }) => {
    test.setTimeout(90_000);
    await signInWithCode(page, member, secret);
    await page.goto("/invoicing/settings");
    await expect(page.locator(".erp-dian--bad")).toHaveText("Solo los administradores de la empresa abren los parámetros de facturación electrónica");
    await expect(page.getByRole("heading", { name: "Facturación electrónica" })).toHaveCount(0);
    await expect(page.getByLabel("Archivo .p12")).toHaveCount(0);
  });
});
