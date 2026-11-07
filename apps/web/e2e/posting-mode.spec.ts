import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupAccounting, confirmStepUp, seedSmallLedger, signInWithCode } from "../test-support/accounting-fixture";
import { cleanupCompanies } from "../test-support/company-cleanup";

// The posting mode (plan 2B Task 33, owner decisions item 5, R33-8, R33-9): Reglas contables › Mapeo de cuentas opens on the mode «Inmediata y
// estricta»; the accountant chooses «Asíncrona con reintentos», reads the warning, confirms with the TOTP and the card keeps the warning. An
// invoice issued afterwards commits without its comprobante and its record says «Pendiente de contabilizar»; the accounting consumer (run here as
// the dispatch workflow's step, test-support/deliver-event.mts: the e2e stack runs no worker) posts it and the badge goes. Switching back needs the
// code too. A role without `accounting.posting_mode.set` sees the card read-only.

const CHAIN = join(__dirname, "..", "test-support", "invoicing-chain.mts");
const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");
const CUSTOMER = "860002964";

const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
const lastJson = <T>(out: string): T => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as T;

/** The documents-awaiting count the card shows («3 documentos esperan su asiento»). */
const awaiting = async (card: Locator) => Number(/^\d+/.exec((await card.getByTestId("posting-mode-pending-documents").innerText()).trim())![0]);

const WARNING = /puede existir sin su asiento contable hasta que el reintento tenga éxito/;

test.describe("posting mode", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let reader: AuthFixture;
  let readerSecret: string;
  let companyId: string;

  const mode = async () => (await fixture.sql<{ posting_mode: string }[]>`select posting_mode from accounting.settings where company_id = ${companyId}`)[0]!.posting_mode;
  const entries = async (invoiceId: string) =>
    (await fixture.sql<{ n: number }[]>`select count(*)::int as n from accounting.entries where company_id = ${companyId} and source_entity = 'invoicing.invoice' and source_record_id = ${invoiceId}`)[0]!.n;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing"]) {
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
    lastJson(tsx(CHAIN, [companyId, fixture.userId]));
    // A reader: a plain role (the system admin role may run every process) with the mapping only (no settings consult: R33-9, the card shows to whoever reads the mapping), not the right to change the mode.
    reader = await seedAuthUser({ role: "member" });
    readerSecret = await enrolTotp(reader);
    for (const key of ["module:core", "module:accounting"]) await reader.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${reader.tenantId}, ${key}, 'manual')`;
    const [member] = await reader.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${reader.companyIds[0]!} and name = 'member'`;
    for (const process of ["accounting.account_role_mapping.consult", "accounting.account.consult"]) {
      await reader.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${reader.companyIds[0]!}, ${member!.id}, ${process})`;
    }
    await seedSmallLedger(reader);
  });

  test.afterAll(async () => {
    if (reader) {
      await cleanupAccounting(reader);
      await reader.cleanup();
    }
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Mapeo de cuentas: Inmediata → Asíncrona (aviso, TOTP) → a factura emitida queda Pendiente de contabilizar → el consumidor la contabiliza → de vuelta a Inmediata", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    await page.goto("/accounting/posting?tab=mapping");
    const card = page.getByRole("region", { name: "Modo de contabilización" });
    await expect(card.getByRole("radio", { name: /Inmediata y estricta \(recomendada\)/ })).toBeChecked();
    await expect(card.getByRole("alert")).toHaveCount(0);
    // The documentos the mode applies to are listed (derived from the registry), with the two counts.
    await expect(card).toContainText("Emitir factura");
    await expect(card.getByTestId("posting-mode-documents")).toContainText("Registrar recibo de caja");
    // The fixture's stock receipt and deliveries wait for accounting's consumer too (no worker runs in this stack): the count is read, not assumed.
    const baseline = await awaiting(card);
    await expect(card.getByTestId("posting-mode-pending-failures")).toContainText("0 fallos en la cola de reintentos");

    // Choosing Asíncrona: the dialog says the risk first; the switch asks for the code.
    await card.getByRole("radio", { name: /Asíncrona con reintentos/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText(WARNING);
    expect(await mode()).toBe("inline_strict");
    await dialog.getByRole("button", { name: "Cambiar a «Asíncrona con reintentos»" }).click();
    await confirmStepUp(page, secret);
    await expect(dialog).toBeHidden();
    await expect(card.getByRole("radio", { name: /Asíncrona con reintentos/ })).toBeChecked();
    await expect(card.getByRole("alert")).toContainText(WARNING);
    expect(await mode()).toBe("asynchronous");

    // An invoice issued now commits with no comprobante: its record says so.
    const issued = lastJson<{ invoiceId: string; number: string }>(tsx(CHAIN, [companyId, fixture.userId, "--issue", CUSTOMER]));
    expect(await entries(issued.invoiceId)).toBe(0);
    await page.goto(`/r/invoicing.invoice/${issued.invoiceId}`);
    await expect(page.getByTestId("pending-posting").first()).toHaveText("Pendiente de contabilizar");
    await page.goto("/accounting/posting?tab=mapping");
    await expect.poll(() => awaiting(card)).toBe(baseline + 1);

    // The consumer posts it (the dispatch workflow's step): the badge goes and the comprobante exists.
    const [row] = await fixture.sql<{ id: string }[]>`
      select id from kernel.outbox where company_id = ${companyId} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${issued.invoiceId} order by created_at desc limit 1`;
    expect(row).toBeTruthy();
    tsx(DELIVER, [row!.id, "accounting"]);
    expect(await entries(issued.invoiceId)).toBe(1);
    await page.goto(`/r/invoicing.invoice/${issued.invoiceId}`);
    await expect(page.getByRole("tab", { name: /^Datos$/ })).toBeVisible();
    await expect(page.getByTestId("pending-posting")).toHaveCount(0);
    await page.goto("/accounting/posting?tab=mapping");
    await expect.poll(() => awaiting(card)).toBe(baseline);

    // Back to Inmediata y estricta: no risk to read, still the code.
    await card.getByRole("radio", { name: /Inmediata y estricta/ }).click();
    const back = page.getByRole("dialog");
    await expect(back.getByRole("alert")).toHaveCount(0);
    await back.getByRole("button", { name: "Cambiar a «Inmediata y estricta (recomendada)»" }).click();
    await confirmStepUp(page, secret);
    await expect(back).toBeHidden();
    await expect(card.getByRole("radio", { name: /Inmediata y estricta/ })).toBeChecked();
    await expect(card.getByRole("alert")).toHaveCount(0);
    expect(await mode()).toBe("inline_strict");
    expect(await entries(issued.invoiceId)).toBe(1);
  });

  test("a role without accounting.posting_mode.set sees the card read-only", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await signInWithCode(page, reader, readerSecret);
      await page.goto("/accounting/posting?tab=mapping");
      const card = page.getByRole("region", { name: "Modo de contabilización" });
      await expect(card.getByRole("radio", { name: /Inmediata y estricta/ })).toBeChecked();
      await expect(card.getByRole("radio", { name: /Inmediata y estricta/ })).toBeDisabled();
      await expect(card.getByRole("radio", { name: /Asíncrona con reintentos/ })).toBeDisabled();
    } finally {
      await context.close();
    }
  });
});
