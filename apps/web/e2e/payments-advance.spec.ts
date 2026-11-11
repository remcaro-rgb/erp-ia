import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";
import { cleanupCompanies } from "../test-support/company-cleanup";

// «Aplicar anticipo a factura» (plan 2B.2 Task 36, owner decisions item 23; design §8.1 step 7; prototype 2B): a customer's invoice is issued
// but the DIAN has not accepted it yet, so «Registrar pago» lists it without letting money be applied and says, once, that the money can be
// registered as an advance. The receipt is registered with no allocation (all advance). When the DIAN accepts the invoice, the receipt's page
// (Anticipos) applies the advance to it with «Aplicar a facturas»: the application is numbered AP-n and posted (Dr customer advances / Cr
// receivable), the advance has nothing left, and the invoice reads Pagada once invoicing's consumer reads the event (test-support/deliver-event.mts:
// the e2e stack runs no worker). «Deshacer aplicación» (step-up) reverses it and the invoice is Emitida again.

const CHAIN = join(__dirname, "..", "test-support", "invoicing-chain.mts");
const DIAN = join(__dirname, "..", "test-support", "mock-dian.mts");
const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });

const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
const lastJson = <T>(out: string): T => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as T;
const pesos = (n: number) => `$ ${n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HOTEL = "890903938";

test.describe("payments: apply an advance to an invoice", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let hotel: { invoiceId: string; number: string };
  let total = 0;

  const invoice = async (id: string) => (await fixture.sql<{ stage: string; paid_amount: string }[]>`select stage, paid_amount::text from invoicing.invoices where id = ${id}`)[0]!;
  /** Delivers the last event of `event` of the document to invoicing's consumer (it recomputes what the receipts and applications settled). */
  const deliver = async (event: string, documentId: string) => {
    const [row] = await fixture.sql<{ id: string }[]>`
      select id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>'paymentId' = ${documentId} order by created_at desc limit 1`;
    tsx(DELIVER, [row!.id, "invoicing"]);
  };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing", "module:payments"]) {
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
    tsx(CHAIN, [companyId, fixture.userId]);
    // The invoice is issued but NOT accepted by the DIAN yet.
    hotel = lastJson<{ invoiceId: string; number: string }>(tsx(CHAIN, [companyId, fixture.userId, "--issue", HOTEL]));
    const [row] = await fixture.sql<{ total: string }[]>`select total::text from invoicing.invoices where id = ${hotel.invoiceId}`;
    total = Number(row!.total);
  });

  test.afterAll(async () => {
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("the receipt of an invoice the DIAN has not accepted is an advance (with the hint); once accepted it is applied: Pagada; «Deshacer aplicación» gives Emitida back", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    // A medio de pago.
    await page.goto("/r/payments.method/new");
    await frame(page).getByLabel(/^Código \*/).fill("TRF");
    await frame(page).getByLabel(/^Nombre/).fill("Transferencia Bancolombia");
    await frame(page).getByLabel(/^Tipo/).selectOption("transfer");
    await frame(page).getByLabel(/^Código DIAN/).selectOption("42");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.method\/[0-9a-f-]{36}$/);

    // «Registrar pago»: the invoice is listed but not payable, and the form says the money can be registered as an advance.
    await page.goto("/r/payments.receipt/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill("Hotel Casa Andina");
    await page.getByRole("option", { name: /Hotel Casa Andina/ }).first().click();
    const row = frame(page).getByRole("table", { name: "Facturas del cliente" }).getByRole("row", { name: new RegExp(hotel.number) });
    await expect(row).toContainText("La DIAN aún no ha aceptado la factura");
    await expect(frame(page).getByText("Esta factura aún no ha sido aceptada por la DIAN; puede registrar el dinero como anticipo y aplicarlo después.")).toHaveCount(1);
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: "Transferencia Bancolombia" });
    await frame(page).getByLabel(/^Valor recibido/).fill(String(total).replace(".", ","));
    await expect(frame(page).getByTestId("payment-advance")).toHaveText(pesos(total));
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    const [receipt] = await fixture.sql<{ number: string; advance: string }[]>`select number, advance::text from payments.receipts where id = ${receiptId}`;
    expect(Number(receipt!.advance)).toBe(total);

    // The DIAN accepts the invoice; the receipt's page offers «Aplicar a facturas» over the full advance.
    tsx(DIAN, ["invoice", hotel.invoiceId, "accepted"]);
    await page.reload();
    const section = frame(page).getByTestId("advance-section");
    await expect(section.getByTestId("advance-remaining")).toHaveText(pesos(total));
    await expect(section.getByTestId("advance-applied")).toHaveText(pesos(0));
    await section.getByRole("button", { name: "Aplicar a facturas" }).click();
    const panel = frame(page).getByTestId("advance-apply-panel");
    const line = panel.getByRole("row", { name: new RegExp(hotel.number) });
    await expect(line).toBeVisible();
    await line.getByRole("button", { name: "Máximo" }).click();
    await expect(panel.getByLabel(`Aplicar a ${hotel.number}`)).toHaveValue(String(total).replace(".", ","));
    await panel.getByRole("button", { name: "Aplicar anticipo", exact: true }).click();

    // Applied: nothing left of the advance, the application AP-n is listed with its link and posted (Dr customer advances / Cr receivable).
    await expect(section.getByTestId("advance-remaining")).toHaveText(pesos(0));
    await expect(section.getByTestId("advance-applied")).toHaveText(pesos(total));
    const [application] = await fixture.sql<{ id: string; number: string; status: string; total: string }[]>`
      select id, number, status, total::text from payments.advance_applications where company_id = ${companyId}`;
    expect(application).toMatchObject({ status: "posted" });
    expect(application!.number).toMatch(/^AP-/);
    expect(Number(application!.total)).toBe(total);
    const entries = await fixture.sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit::text, l.credit::text from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
      where e.company_id = ${companyId} and e.source_entity = 'payments.advance_application' and e.source_record_id = ${application!.id} and e.reversal_of_id is null`;
    expect(entries.map((e) => [e.code, Number(e.debit) - Number(e.credit)]).sort()).toEqual([["130505", -total], ["280505", total]]);
    const rowOf = section.getByTestId("advance-application-row");
    await expect(rowOf).toHaveCount(1);
    await expect(rowOf.getByRole("link", { name: application!.number })).toBeVisible();

    // Invoicing reads the application: the invoice reads Pagada.
    await deliver("payments.advance.applied", application!.id);
    expect(await invoice(hotel.invoiceId)).toMatchObject({ stage: "paid" });
    await page.goto(`/r/invoicing.invoice/${hotel.invoiceId}`);
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Pagada");
    // Documentos relacionados of the invoice lists the application with its step (R36-11).
    await frame(page).getByRole("tab", { name: /^Documentos relacionados/ }).click();
    const trail = frame(page).getByRole("tabpanel", { name: /^Documentos relacionados/ });
    await expect(trail).toContainText(application!.number);
    await expect(trail).toContainText("Factura → Aplicación de anticipo");

    // The application's page (read only), reached from the receipt: its facts, lines and total.
    await page.goto(`/r/payments.receipt/${receiptId}`);
    await frame(page).getByTestId("advance-section").getByRole("link", { name: application!.number }).click();
    await expect(page).toHaveURL(new RegExp(`/r/payments\\.advance_application/${application!.id}$`));
    await expect(frame(page).getByTestId("application-status")).toHaveText("Contabilizado");
    await expect(frame(page).getByTestId("application-total")).toHaveText(pesos(total));
    await expect(frame(page).getByRole("link", { name: receipt!.number })).toBeVisible();
    await expect(frame(page).getByRole("link", { name: hotel.number })).toBeVisible();

    // «Deshacer aplicación» (step-up): the entry is reversed, the advance and the invoice get their balance back.
    await bar(page).getByRole("button", { name: "Deshacer aplicación", exact: true }).click();
    const ask = page.getByRole("dialog", { name: `Deshacer la aplicación ${application!.number}` });
    await expect(ask).toContainText(hotel.number);
    await expect(ask).toContainText("código de verificación");
    await expect(ask.getByRole("button", { name: "Deshacer aplicación", exact: true })).toBeDisabled();
    await ask.getByLabel("Motivo").fill("Se aplicó a la factura equivocada");
    await ask.getByRole("button", { name: "Deshacer aplicación", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(frame(page).getByTestId("application-status")).toHaveText("Anulado");
    await expect(frame(page).getByTestId("application-void-reason")).toContainText("Se aplicó a la factura equivocada");
    const [undone] = await fixture.sql<{ status: string }[]>`select status from payments.advance_applications where id = ${application!.id}`;
    expect(undone).toMatchObject({ status: "voided" });
    expect(await fixture.sql`select 1 from accounting.entries where company_id = ${companyId} and reversal_of_id is not null and source_record_id = ${application!.id}`).toHaveLength(1);
    await deliver("payments.advance.unapplied", application!.id);
    expect(await invoice(hotel.invoiceId)).toMatchObject({ stage: "issued" });
    await page.goto(`/r/invoicing.invoice/${hotel.invoiceId}`);
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Emitida");
    await page.goto(`/r/payments.receipt/${receiptId}`);
    await expect(frame(page).getByTestId("advance-section").getByTestId("advance-remaining")).toHaveText(pesos(total));
  });
});
