import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { FOREIGN_SALE, NORTHWIND, USD_METHOD, USD_RATES } from "../../../scripts/demo/foreign-sale";
import { pdfText } from "../../../packages/kernel/src/templates/__tests__/pdf-text";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The export sale in dollars on the demo company (plan 2B.2 Task 34.8, FX design §9; `pnpm db:reset && DEMO_SEED=1 pnpm db:seed`,
// scripts/demo/sales.ts step 9), signed in as Laura (admin): «Tasas de cambio» lists the seeded USD rates; FE-USD to Northwind Roasters reads
// USD 12.500,00, carries no «La tasa difiere» chip (its rate is the table's), and its PDF prints the COP equivalent legend; «Registrar pago»
// with «Transferencia USD» receives USD 5.000 at a lower rate (a realized loss); the aging report shows the open dollars in both modes.
//
// The spec runs on the shared demo: it voids its own receipt at the end (step-up), so FE-USD is back at the USD 7.500 the seed left open and
// the next run starts from the same figures.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });

const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");
const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(mfa\/verify)?$/);
  if (page.url().endsWith("/mfa/verify")) {
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
  }
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}

async function deliver(event: string, paymentId: string) {
  const [row] = await sql<{ id: string }[]>`
    select id from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = ${event} and payload->>'paymentId' = ${paymentId} order by created_at desc limit 1`;
  expect(row, `${event} for ${paymentId}`).toBeTruthy();
  tsx(DELIVER, [row!.id, "invoicing"]);
}

type AgingRow = { party_document: string; currency: string; total: number; row_kind: string };
async function aging(request: APIRequestContext, asOf: string, currency: "company" | "document"): Promise<AgingRow[]> {
  const answer = await request.post("/api/report/accounting.aging", {
    data: { params: { kind: "receivable", asOf, currency, notDue: "include" }, state: { filters: [], sort: [], page: 1, pageSize: 500 } },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { rows: AgingRow[] }).rows.filter((r) => r.party_document === NORTHWIND.documentNumber);
}

test.describe("foreign currency on the demo (Task 34.8)", () => {
  test.afterAll(async () => {
    await sql.end();
  });

  test("Tasas de cambio; FE-USD in dollars with its PDF legend; a USD receipt; aging in both currencies; the receipt voided", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const [fe] = await sql<{ id: string; number: string; paid: number }[]>`
      select i.id, i.number, i.paid_amount::float8 as paid from invoicing.invoices i join core.parties p on p.id = i.party_id
      where i.company_id = ${DEMO_COMPANY_ID} and p.document_number = ${NORTHWIND.documentNumber} and i.notes = ${FOREIGN_SALE.notes} and i.status <> 'voided'`;
    expect(fe, "the seeded FE-USD (DEMO_SEED=1 pnpm db:seed)").toBeTruthy();
    expect(fe!.paid).toBe(FOREIGN_SALE.receipt.amount);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    await login(page);

    // ── Tasas de cambio: the three seeded USD rates, entered by hand (source Manual). ──
    await page.goto("/exchange-rates");
    await expect(grid(page)).toBeVisible();
    // Each row by its day, its rate and its source in words (Manual, not the stored `manual`). Number columns print the stored value
    // (owner item 136), so the rate is matched on its digits.
    const day = (daysAgo: number) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return d.toISOString().slice(0, 10).replaceAll("-", "/");
    };
    for (const r of USD_RATES) {
      const row = grid(page).locator("tbody tr").filter({ hasText: day(r.daysAgo) }).filter({ hasText: "USD" });
      await expect(row.getByRole("cell", { name: "Manual", exact: true })).toBeVisible();
      await expect(row).toContainText(String(r.rate));
    }

    // ── FE-USD: in dollars, Aceptada, no «La tasa difiere» chip (its rate is the table's); Imprimir prints the COP equivalent. ──
    await page.goto(`/r/invoicing.invoice/${fe!.id}`);
    await expect(frame(page).getByTestId("invoice-total")).toHaveText("USD 12.500,00");
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("Aceptada");
    await expect(frame(page).getByTestId("rate-warning")).toHaveCount(0);
    const job = page.waitForResponse((r) => /\/api\/export\/[0-9a-f-]{36}$/.test(r.url()));
    await bar(page).getByRole("button", { name: "Imprimir" }).click();
    const printed = (await (await job).json()) as { url?: string; fileName?: string };
    expect(printed.fileName).toMatch(/\.pdf$/);
    const pdf = await page.request.get(printed.url!);
    expect(pdf.status()).toBe(200);
    const text = pdfText(await pdf.body());
    expect(text).toContain("Equivalente en COP a TRM");
    expect(text).toContain("USD");

    // ── Aging before the receipt: USD 7.500 open in the document's currency; its peso equivalent at the invoice's rate. ──
    const docBefore = await aging(page.request, today, "document");
    expect(docBefore.find((r) => r.row_kind === "detail")).toMatchObject({ currency: "USD", total: FOREIGN_SALE.open });
    const copBefore = await aging(page.request, today, "company");
    expect(copBefore[0]).toMatchObject({ currency: "COP", total: FOREIGN_SALE.open * FOREIGN_SALE.rate });
    await page.goto(`/accounting/reports/aging?p=${encodeURIComponent(JSON.stringify({ kind: "receivable", asOf: today, currency: "document" }))}`);
    await expect(page.getByRole("cell", { name: NORTHWIND.legalName }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Subtotal USD" })).toBeVisible();

    // ── Registrar pago with «Transferencia USD»: USD 5.000 at 4.050, below the invoice's rate: Contabilizado, a realized loss. ──
    const { amount, rate } = FOREIGN_SALE.receipt;
    await page.goto("/r/payments.receipt/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill("Northwind");
    await page.getByRole("option", { name: new RegExp(NORTHWIND.legalName) }).first().click();
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: USD_METHOD.name });
    const open = frame(page).getByRole("table", { name: "Facturas del cliente" });
    await expect(open.getByRole("row", { name: new RegExp(fe!.number) })).toContainText("7.500,00");
    await frame(page).getByLabel(/^Referencia/).fill(`SWIFT-E2E-${Date.now()}`);
    await open.getByLabel(`Aplicar a ${fe!.number}`).fill(String(amount));
    await frame(page).getByLabel(/^Valor recibido/).fill(String(amount));
    await frame(page).getByLabel(/^Tasa de cambio/).fill(String(rate).replace(".", ","));
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    await expect(frame(page).getByTestId("receipt-status")).toHaveText("Contabilizado");
    const [receipt] = await sql<{ number: string; currency: string; rate: number }[]>`
      select number, currency, exchange_rate::float8 as rate from payments.receipts where id = ${receiptId}`;
    expect(receipt).toMatchObject({ currency: "USD", rate });
    const loss = await sql<{ debit: number }[]>`
      select l.debit::float8 as debit from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
      where e.source_record_id = ${receiptId} and e.status = 'posted' and e.reversal_of_id is null and a.code = '530525'`;
    expect(loss).toEqual([{ debit: FOREIGN_SALE.realizedLoss }]);
    await deliver("payments.received", receiptId);

    // Aging after it: USD 2.500 open, in both modes.
    const left = FOREIGN_SALE.open - amount;
    expect((await aging(page.request, today, "document")).find((r) => r.row_kind === "detail")).toMatchObject({ currency: "USD", total: left });
    expect((await aging(page.request, today, "company"))[0]).toMatchObject({ currency: "COP", total: left * FOREIGN_SALE.rate });

    // ── «Anular recibo» behind step-up: the demo is back at USD 7.500 open. ──
    await bar(page).getByRole("button", { name: "Anular recibo", exact: true }).click();
    const ask = page.getByRole("dialog", { name: `Anular el recibo ${receipt!.number}` });
    await ask.getByLabel("Motivo de la anulación").fill("Prueba e2e de moneda extranjera");
    await ask.getByRole("button", { name: "Anular recibo", exact: true }).click();
    const code = page.getByLabel("Código de 6 dígitos");
    await expect(code).toBeFocused();
    await code.fill(totpCode(LAURA.totpSecret!));
    await expect(frame(page).getByTestId("receipt-status")).toHaveText("Anulado");
    await deliver("payments.payment.voided", receiptId);
    expect(await sql`select paid_amount::float8 as paid from invoicing.invoices where id = ${fe!.id}`).toEqual([{ paid: FOREIGN_SALE.receipt.amount }]);
    expect((await aging(page.request, today, "document")).find((r) => r.row_kind === "detail")).toMatchObject({ currency: "USD", total: FOREIGN_SALE.open });
  });
});
