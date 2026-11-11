import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";
import { cleanupCompanies } from "../test-support/company-cleanup";

// The payments pages (plan 2B Task 24b, controller-added; design §8, §8.1 step 7, §9, entity types spec §9.2; prototype 2B
// /payments/receipts and /payments/receipts/88): Medios de pago and Cajas (Maestros) are created and duplicated in their record pages; a
// recibo de caja is written with «Registrar pago»: the customer, the medio de pago, the money received, what it applies to each open invoice
// of the customer (only the ones the DIAN accepted: the others are listed with why) and the withholdings the customer practised; what is
// left is the customer's advance. It numbers and posts in the same action: its Contabilidad tab shows the comprobante (Dr bank and
// withholdings suffered / Cr receivable and advances), its Asignaciones tab what it applied to each invoice, and the invoice reads Pagada once
// invoicing's consumer reads the receipt (test-support/deliver-event.mts: the e2e stack runs no worker). «Anular recibo» asks for the code,
// reverses the entry and gives the invoice its balance back. A customer that is no longer ready is refused with the reason.
// The sale chain (accounting configured, the DIAN resolution, three customers with a shipped pedido) is written through the registered
// processes by test-support/invoicing-chain.mts; the invoices are issued with its --issue and answered by the mock DIAN.

const CHAIN = join(__dirname, "..", "test-support", "invoicing-chain.mts");
const DIAN = join(__dirname, "..", "test-support", "mock-dian.mts");
const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
const lastJson = <T>(out: string): T => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as T;

const SABANA = "860002964";
const HOTEL = "890903938";
const MAIZAL = "800197268";

test.describe("payments pages", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  const invoices: Record<string, { invoiceId: string; number: string }> = {};

  const issue = (document: string, accepted: boolean) => {
    const issued = lastJson<{ invoiceId: string; number: string }>(tsx(CHAIN, [companyId, fixture.userId, "--issue", document]));
    if (accepted) tsx(DIAN, ["invoice", issued.invoiceId, "accepted"]);
    invoices[document] = issued;
  };
  /** The posted comprobante of a source record: its number and the net (debit − credit) per account code. */
  const entryOf = async (entity: string, id: string, status = "posted") => {
    const rows = await fixture.sql<{ number: string; code: string; debit: string; credit: string }[]>`
      select e.number, a.code, l.debit::text, l.credit::text from accounting.entries e
      join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
      where e.company_id = ${companyId} and e.source_entity = ${entity} and e.source_record_id = ${id} and e.status = ${status} and e.reversal_of_id is null`;
    const net: Record<string, number> = {};
    for (const r of rows) net[r.code] = Math.round(((net[r.code] ?? 0) + Number(r.debit) - Number(r.credit)) * 100) / 100;
    return { number: rows[0]?.number ?? null, net };
  };
  /** Delivers the receipt's last event of `event` to invoicing's consumer (it recomputes what the posted receipts settled). */
  const deliver = async (event: string, receiptId: string) => {
    const [row] = await fixture.sql<{ id: string }[]>`
      select id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>'paymentId' = ${receiptId} order by created_at desc limit 1`;
    tsx(DELIVER, [row!.id, "invoicing"]);
  };
  const invoice = async (id: string) => (await fixture.sql<{ stage: string; paid_amount: string }[]>`select stage, paid_amount::text from invoicing.invoices where id = ${id}`)[0]!;
  const openTab = async (page: Page, name: RegExp) => {
    await frame(page).getByRole("tab", { name }).click();
    return frame(page).getByRole("tabpanel", { name });
  };
  const pickCustomer = async (page: Page, name: string) => {
    await page.getByRole("combobox", { name: "Cliente" }).fill(name);
    await page.getByRole("option", { name: new RegExp(name) }).first().click();
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
    issue(SABANA, true);
    issue(HOTEL, false);
    issue(MAIZAL, true);
  });

  test.afterAll(async () => {
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Medios de pago and Cajas: created in their record pages, duplicated without their code", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    // Pagos › Maestros › Medios de pago: the grid, then a new transferencia with its DIAN code.
    await page.goto("/payments/methods");
    await expect(page.getByRole("navigation", { name: "Menú del módulo" })).toBeVisible();
    await expect(grid(page)).toBeVisible();
    await page.goto("/r/payments.method/new");
    await frame(page).getByLabel(/^Código \*/).fill("TRF");
    await frame(page).getByLabel(/^Nombre/).fill("Transferencia Bancolombia");
    await frame(page).getByLabel(/^Tipo/).selectOption("transfer");
    await frame(page).getByLabel(/^Código DIAN/).selectOption("42");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.method\/[0-9a-f-]{36}$/);
    const [method] = await fixture.sql<{ status: string; kind: string; means_code: string }[]>`select status, kind, means_code from payments.methods where company_id = ${companyId} and code = 'TRF'`;
    expect(method).toMatchObject({ status: "saved", kind: "transfer", means_code: "42" });
    // Duplicar (rule 37): the copy keeps the name and the kind, never the code.
    await bar(page).getByRole("button", { name: "Duplicar" }).click();
    await expect(page).toHaveURL(/\/r\/payments\.method\/new$/);
    await expect(frame(page).getByLabel(/^Nombre/)).toHaveValue("Transferencia Bancolombia");
    await expect(frame(page).getByLabel(/^Código \*/)).toHaveValue("");
    await frame(page).getByLabel(/^Código \*/).fill("EFE");
    await frame(page).getByLabel(/^Nombre/).fill("Efectivo");
    await frame(page).getByLabel(/^Tipo/).selectOption("cash");
    await frame(page).getByLabel(/^Código DIAN/).selectOption("10");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.method\/[0-9a-f-]{36}$/);
    await page.goto("/payments/methods");
    await expect(grid(page).getByRole("row", { name: /Transferencia Bancolombia/ })).toContainText("Transferencia");
    await expect(grid(page).getByRole("row", { name: /Efectivo/ }).first()).toContainText("EFE");

    // Cajas: a new caja.
    await page.goto("/payments/cash-boxes");
    await expect(grid(page)).toBeVisible();
    await page.goto("/r/payments.cash_box/new");
    await frame(page).getByLabel(/^Código \*/).fill("CAJA1");
    await frame(page).getByLabel(/^Nombre/).fill("Caja principal");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.cash_box\/[0-9a-f-]{36}$/);
    expect(await fixture.sql`select 1 from payments.cash_boxes where company_id = ${companyId} and code = 'CAJA1' and status = 'saved'`).toHaveLength(1);

    // Parámetros of the payments entity types (Task 16 screens, routed under /payments/parametros): each page opens with its module menu.
    for (const sub of ["tipos", "destinatarios", "plantillas"]) {
      const response = await page.goto(`/payments/parametros/${sub}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("navigation", { name: "Menú del módulo" })).toBeVisible();
    }
    await page.goto("/payments/parametros/tipos");
    await expect(page.getByText("Recibo de caja").first()).toBeVisible();
  });

  test("«Registrar pago» with a retefuente: numbered, posted (Contabilidad), applied (Asignaciones), the invoice Pagada; «Anular recibo» behind step-up un-pays it", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const sabana = invoices[SABANA]!;

    await page.goto("/payments/receipts");
    await expect(grid(page)).toBeVisible();
    await page.goto("/r/payments.receipt/new");
    await pickCustomer(page, "Distribuidora La Sabana");
    // The customer's open invoices (the DIAN accepted them): the number, its balance and what to apply.
    const open = frame(page).getByRole("table", { name: "Facturas del cliente" });
    await expect(open.getByRole("row", { name: new RegExp(sabana.number) })).toContainText("$ 147.700,00");
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: "Transferencia Bancolombia" });
    await frame(page).getByLabel(/^Referencia/).fill("TRF-77120");
    await open.getByLabel(`Aplicar a ${sabana.number}`).fill("147700");
    // ReteFuente 2,5 % over the base 134.000 = 3.350: the value follows base × rate.
    await frame(page).getByRole("button", { name: `Agregar retención a ${sabana.number}` }).click();
    const held = frame(page).getByRole("group", { name: `Retención 1 de ${sabana.number}` });
    await held.getByLabel("Tipo").selectOption("income");
    await held.getByLabel("Código").fill("RTEFTE");
    await held.getByLabel("Tarifa %").fill("2,5");
    await held.getByLabel("Base").fill("134000");
    await expect(held.getByLabel("Valor")).toHaveValue("3350");
    await frame(page).getByLabel(/^Valor recibido/).fill("144350");
    // The live totals: cash applied, withholdings, advance.
    await expect(frame(page).getByTestId("payment-cash")).toHaveText("$ 144.350,00");
    await expect(frame(page).getByTestId("payment-withholdings")).toHaveText("$ 3.350,00");
    await expect(frame(page).getByTestId("payment-advance")).toHaveText("$ 0,00");
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    const [receipt] = await fixture.sql<{ number: string; status: string; amount: string; applied: string; withholding_total: string; advance: string }[]>`
      select number, status, amount::text, applied::text, withholding_total::text, advance::text from payments.receipts where id = ${receiptId}`;
    expect(receipt).toMatchObject({ status: "posted" });
    expect(receipt!.number).toMatch(/^RC-/);
    expect([receipt!.amount, receipt!.applied, receipt!.withholding_total, receipt!.advance].map(Number)).toEqual([144350, 147700, 3350, 0]);
    // The prototype's receipt: Recibo de caja RC-n, Contabilizado; the customer and the invoice link to their records (rule 21).
    await expect(frame(page).getByTestId("receipt-status")).toHaveText("Contabilizado");
    await expect(frame(page).getByRole("link", { name: "Distribuidora La Sabana S.A.S." })).toBeVisible();
    await expect(frame(page).getByRole("link", { name: sabana.number }).first()).toBeVisible();
    await expect(frame(page).getByText("TRF-77120").first()).toBeVisible();
    // Asignaciones: what it applied to the invoice, the withholding and the cash (rule 20: the universal grid).
    const applied = await openTab(page, /^Asignaciones/);
    await expect(applied.locator("section.erp-grid tbody tr")).toHaveCount(1);
    await expect(applied.locator("section.erp-grid tbody tr").first()).toContainText(sabana.number);
    await expect(applied.getByRole("table", { name: "Retenciones" })).toContainText("RTEFTE");
    await expect(applied.getByRole("table", { name: "Retenciones" })).toContainText("$ 3.350,00");
    // Contabilidad: one comprobante, Dr bank 144.350 and withholding suffered 3.350 / Cr receivable 147.700.
    const ledger = await openTab(page, /^Contabilidad/);
    await expect(ledger.locator("tbody tr")).toHaveCount(1);
    const entry = await entryOf("payments.receipt", receiptId);
    await expect(ledger.locator("tbody tr").first()).toContainText(entry.number!);
    expect(entry.net).toEqual({ "111005": 144350, "135515": 3350, "130505": -147700 });

    // Recibos de caja (Documentos): the row reads Contabilizado.
    await page.goto("/payments/receipts");
    await expect(grid(page).getByRole("row", { name: new RegExp(receipt!.number) })).toContainText("Contabilizado");

    // Invoicing reads the receipt (its consumer): the invoice reads Pagada and links to the receipt that paid it.
    await deliver("payments.received", receiptId);
    expect(await invoice(sabana.invoiceId)).toMatchObject({ stage: "paid" });
    await page.goto(`/r/invoicing.invoice/${sabana.invoiceId}`);
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Pagada");
    await frame(page).getByRole("link", { name: receipt!.number }).click();
    await expect(page).toHaveURL(new RegExp(`/r/payments\\.receipt/${receiptId}$`));

    // «Anular recibo» (step-up): the dialog says it reverses the entry and the invoices get their balance back; the motivo is required.
    await bar(page).getByRole("button", { name: "Anular recibo", exact: true }).click();
    const ask = page.getByRole("dialog", { name: `Anular el recibo ${receipt!.number}` });
    await expect(ask).toContainText("revierte");
    await expect(ask).toContainText(sabana.number);
    await expect(ask).toContainText("código de verificación");
    await expect(ask.getByRole("button", { name: "Anular recibo", exact: true })).toBeDisabled();
    await ask.getByLabel("Motivo de la anulación").fill("Transferencia devuelta por el banco");
    await ask.getByRole("button", { name: "Anular recibo", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(frame(page).getByTestId("receipt-status")).toHaveText("Anulado");
    const [voided] = await fixture.sql<{ status: string; void_reason: string }[]>`select status, void_reason from payments.receipts where id = ${receiptId}`;
    expect(voided).toMatchObject({ status: "voided", void_reason: "Transferencia devuelta por el banco" });
    // The reversal mirrors the entry, and the invoice is owed again once invoicing reads the void.
    const [reversal] = await fixture.sql<{ id: string }[]>`select id from accounting.entries where company_id = ${companyId} and reversal_of_id is not null and source_record_id = ${receiptId}`;
    expect(reversal).toBeDefined();
    await expect(bar(page).getByRole("button", { name: "Anular recibo", exact: true })).toHaveCount(0);
    await deliver("payments.payment.voided", receiptId);
    expect(await invoice(sabana.invoiceId)).toMatchObject({ stage: "issued" });
    expect(Number((await invoice(sabana.invoiceId)).paid_amount)).toBe(0);
    await page.goto(`/r/invoicing.invoice/${sabana.invoiceId}`);
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Emitida");
  });

  test("an invoice the DIAN has not accepted is listed but not payable, with the reason; the money becomes an advance", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const hotel = invoices[HOTEL]!;
    await page.goto("/r/payments.receipt/new");
    await pickCustomer(page, "Hotel Casa Andina");
    const row = frame(page).getByRole("table", { name: "Facturas del cliente" }).getByRole("row", { name: new RegExp(hotel.number) });
    await expect(row).toContainText("La DIAN aún no ha aceptado la factura");
    await expect(row.getByLabel(`Aplicar a ${hotel.number}`)).toHaveCount(0);
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: "Efectivo" });
    await frame(page).getByLabel(/^Caja/).selectOption({ label: "CAJA1 · Caja principal" });
    await frame(page).getByLabel(/^Valor recibido/).fill("50000");
    await expect(frame(page).getByTestId("payment-advance")).toHaveText("$ 50.000,00");
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    await expect(frame(page).getByTestId("receipt-status")).toHaveText("Contabilizado");
    await expect(frame(page).getByText(/anticipo/i).first()).toBeVisible();
    // All advance: Dr caja 50.000 / Cr customer advances.
    expect((await entryOf("payments.receipt", receiptId)).net).toEqual({ "110505": 50000, "280505": -50000 });
  });

  test("part applied and the remainder an advance; Duplicar keeps the customer; a customer no longer ready is refused with the reason", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const maizal = invoices[MAIZAL]!;
    await page.goto("/r/payments.receipt/new");
    await pickCustomer(page, "Tienda El Maizal");
    const open = frame(page).getByRole("table", { name: "Facturas del cliente" });
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: "Transferencia Bancolombia" });
    await open.getByLabel(`Aplicar a ${maizal.number}`).fill("100000");
    await frame(page).getByLabel(/^Valor recibido/).fill("120000");
    await expect(frame(page).getByTestId("payment-cash")).toHaveText("$ 100.000,00");
    await expect(frame(page).getByTestId("payment-advance")).toHaveText("$ 20.000,00");
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    expect((await entryOf("payments.receipt", receiptId)).net).toEqual({ "111005": 120000, "130505": -100000, "280505": -20000 });
    await deliver("payments.received", receiptId);
    // A part payment: the invoice stays Emitida with what is left.
    expect(await invoice(maizal.invoiceId)).toMatchObject({ stage: "issued" });

    // Duplicar (rule 37): the new receipt starts with the customer and the method, never the money.
    await bar(page).getByRole("button", { name: "Duplicar" }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/new$/);
    await expect(page.getByRole("combobox", { name: "Cliente" })).toHaveValue(/Tienda El Maizal/);
    await expect(frame(page).getByLabel(/^Valor recibido/)).toHaveValue("");
    // What is still open: 147.700 − 100.000.
    await expect(frame(page).getByRole("table", { name: "Facturas del cliente" }).getByRole("row", { name: new RegExp(maizal.number) })).toContainText("$ 47.700,00");
    // The customer is no longer ready to invoice: «Registrar pago» is refused with its name and what it lacks (rule 10).
    await fixture.sql`update core.parties set dian_status = 'missing: 1', dian_missing = ${["Dirección"]} where company_id = ${companyId} and document_number = ${MAIZAL}`;
    await frame(page).getByLabel(/^Valor recibido/).fill("10000");
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(frame(page).getByRole("alert").filter({ hasText: "Tienda El Maizal" })).toContainText("Dirección");
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/new$/);
    // And the lookup shows it disabled, with the reason.
    await page.goto("/r/payments.receipt/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill("Tienda El Maizal");
    await expect(page.getByRole("option", { name: /Tienda El Maizal/ }).first()).toHaveAttribute("title", /Faltan datos DIAN: Dirección/);
  });
});
