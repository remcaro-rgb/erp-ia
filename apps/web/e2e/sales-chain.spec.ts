import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The phase 2B chain in the UI on the demo company (plan 2B Task 26; `pnpm db:reset && DEMO_SEED=1 pnpm db:seed`, scripts/demo/sales.ts),
// signed in as Laura (admin): a cotización to Distribuidora Caribe Express written, sent and accepted; «Crear pedido» and Confirmar; «Crear
// entrega» and Despachar; Por facturar → «Crear facturas» (manual creation, the demo's mode) → Emitir (SETP numbering of habilitación, the
// CUFE, the entry); the mock DIAN accepts it (test-support/mock-dian.mts: the e-invoice workflow's processes, the e2e stack runs no worker);
// «Registrar pago» with a retención en la fuente. Along the way the Inicio cards move (Pedidos abiertos, Por facturar, Por cobrar before and
// after the payment), the aging report and Información exógena 1007 include the sale, and the invoice's XML downloads
// and so does the 1007 exógena XML (it holds the customer and the bank's tercero).
//
// The spec runs on the shared demo: it measures every figure as a difference from what it read before its own sale, and leaves its sale
// paid (one more paid sale per run; the demo's opening stock covers hundreds of runs). Nothing is dated in October: accounting-smoke.spec.ts
// reads October 2026, which this sale (dated today) never touches.
//
// Figures: 2 × Café en grano Norte Especial · kilo at $ 62.000 = $ 124.000 + IVA 5 % $ 6.200 = $ 130.200; retefuente 2,5 % = $ 3.100,
// so the receipt brings $ 127.100 and settles the invoice in full.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });

const CUSTOMER = "Distribuidora Caribe Express S.A.S.";
const CUSTOMER_DOCUMENT = "900888123";
const SKU = "CAF-GRA-KG";
const SUBTOTAL = 124000;
const TOTAL = 130200;
const RETEFUENTE = 3100;

const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");
const DIAN = join(__dirname, "..", "test-support", "mock-dian.mts");
const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

/** `$ 1.234.567,00` (rule 23). */
const peso = (n: number) => `$ ${Math.floor(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(Math.round(Math.abs(n) * 100) % 100).padStart(2, "0")}`;
const fromPeso = (text: string) => Number(text.replace(/[^\d,-]/g, "").replace(",", "."));

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(mfa\/verify)?$/);
  if (page.url().endsWith("/mfa/verify")) await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
  await expect(page).toHaveURL(/\/$/);
}

/** The value a card of a module's Inicio shows, as a number. */
async function cardValue(page: Page, module: string, id: string): Promise<number> {
  await page.goto(`/inicio/${module}`);
  const card = page.getByTestId("module-home").locator(`[data-kpi="${id}"]`);
  await expect(card).toBeVisible();
  return fromPeso((await card.getByTestId("kpi-value").innerText()).trim());
}
async function expectCard(page: Page, module: string, id: string, text: string) {
  await page.goto(`/inicio/${module}`);
  await expect(page.getByTestId("module-home").locator(`[data-kpi="${id}"]`).getByTestId("kpi-value")).toHaveText(text);
}

/** One report window as the session's user (POST /api/report/:id): the rows of the first 500. */
async function report<T>(request: APIRequestContext, id: string, params: Record<string, unknown>): Promise<{ rows: T[]; errors?: string[] }> {
  const answer = await request.post(`/api/report/${id}`, { data: { params, state: { filters: [], sort: [], page: 1, pageSize: 500 } } });
  expect(answer.status(), `${id} ${await answer.text()}`).toBe(200);
  const body = (await answer.json()) as { rows: T[]; extra?: { errors?: string[] }; errors?: string[] };
  return { rows: body.rows, errors: body.extra?.errors ?? body.errors };
}

/** What Información exógena 1007 (ingresos recibidos) of `year` reports for the customer, threshold 0 so it has its own row. */
async function income(request: APIRequestContext, year: number): Promise<number> {
  const { rows } = await report<{ party_document: string; col1: number }>(request, "accounting.exogena", { year, format: "1007", threshold: 0 });
  return rows.filter((r) => r.party_document === CUSTOMER_DOCUMENT).reduce((sum, r) => sum + Number(r.col1), 0);
}

/** Delivers the outbox row of `event` whose payload names `key` = `value` to `moduleId`'s consumer (the dispatch workflow's step). */
async function deliver(event: string, key: string, value: string, moduleId: string) {
  const [row] = await sql<{ id: string }[]>`
    select id from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = ${event} and payload->>${key} = ${value} order by created_at desc limit 1`;
  expect(row, `${event} for ${value}`).toBeTruthy();
  tsx(DELIVER, [row!.id, moduleId]);
}

test.describe("the sale chain on the demo company", () => {
  test.afterAll(async () => {
    await sql.end();
  });

  test("cotización → pedido → entrega → factura emitida (DIAN simulada) → pago con retefuente; Inicio, cartera por edades y exógena muestran la venta; el XML de la factura se descarga", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const [clock] = await sql<{ today: string }[]>`select (now() at time zone 'America/Bogota')::date::text as today`;
    const today = clock!.today;
    const year = Number(today.slice(0, 4));
    await login(page);

    // The seed left the demo with the sale chain's modules: their Inicio pages and cards.
    const before = {
      openOrders: await cardValue(page, "sales", "sales.open_orders"),
      toInvoice: await cardValue(page, "invoicing", "invoicing.to_invoice"),
      receivable: await cardValue(page, "invoicing", "invoicing.receivable"),
      collected: await cardValue(page, "payments", "payments.collected_month"),
      income: await income(page.request, year),
    };
    await page.goto("/inicio/crm");
    await expect(page.getByTestId("module-home").locator('[data-kpi="crm.pipeline"]')).toBeVisible();
    await page.goto("/inicio/inventory");
    await expect(page.getByTestId("module-home").locator('[data-kpi="inventory.below_minimum"]')).toBeVisible();
    // The demo seed's own chain is there, linked: Almacenes Éxito's invoice is paid.
    const [seeded] = await sql<{ stage: string; dian_status: string }[]>`
      select i.stage, i.dian_status from invoicing.invoices i join core.parties p on p.id = i.party_id
      where i.company_id = ${DEMO_COMPANY_ID} and p.document_number = '890900608' order by i.created_at limit 1`;
    expect(seeded).toEqual({ stage: "paid", dian_status: "accepted" });
    // Task 51: Club Campestre El Rodeo's terms name the seeded list Mayoristas, which prices Café en grano Norte Especial 500 g at 10 % under its list
    // price (whole pesos): the row sales.price.resolve reads first (customer_list) for that customer and product.
    const [wholesale] = await sql<{ list: string; price: string; list_price: string }[]>`
      select l.name as list, i.price::text, p.list_price::text from sales.customer_terms t
      join core.parties c on c.id = t.party_id join core.price_lists l on l.id = t.price_list_id
      join core.price_list_items i on i.price_list_id = l.id join core.products p on p.id = i.product_id
      where t.company_id = ${DEMO_COMPANY_ID} and c.document_number = '890981234' and p.sku = 'CAF-GRA-500'`;
    expect(wholesale!.list).toBe("Mayoristas");
    expect(Number(wholesale!.price)).toBe(Math.round(Number(wholesale!.list_price) * 0.9));

    // ── Cotización (CRM › Documentos): the customer, one line, Guardar; Enviar al cliente; Aceptar cotización. ──
    await page.goto("/r/crm.quote/new");
    await expect(page.getByRole("heading", { name: "Crear cotización" })).toBeVisible();
    await page.getByRole("combobox", { name: "Cliente" }).fill("Distribuidora Caribe");
    await page.getByRole("option", { name: new RegExp(CUSTOMER) }).first().click();
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill(SKU);
    await page.getByRole("option", { name: new RegExp(SKU) }).first().click();
    await page.getByLabel("Cantidad, línea 1").fill("2");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/crm\.quote\/[0-9a-f-]{36}$/);
    const quoteId = page.url().split("/").pop()!;
    await expect(frame(page).getByTestId("sales-total")).toHaveText(peso(TOTAL));
    await frame(page).getByRole("button", { name: "Enviar al cliente", exact: true }).click();
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Enviada");
    await frame(page).getByRole("button", { name: "Aceptar cotización", exact: true }).click();
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Aceptada");

    // ── Pedido: «Crear pedido» from the accepted cotización, in Bodega Principal; Confirmar pedido reserves the stock. ──
    await frame(page).getByLabel("Bodega del pedido").selectOption({ label: "PRIN · Bodega Principal" });
    await frame(page).getByRole("button", { name: "Crear pedido", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.order\/[0-9a-f-]{36}$/);
    const [order] = await sql<{ id: string; number: string }[]>`select id, number from sales.orders where quote_id = ${quoteId}`;
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Abierto");
    await expectCard(page, "sales", "sales.open_orders", String(before.openOrders + 1));
    await page.goto(`/r/sales.order/${order!.id}`);
    await frame(page).getByRole("button", { name: "Confirmar pedido", exact: true }).click();
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Confirmado");
    await deliver("sales.order.confirmed", "orderId", order!.id, "inventory");

    // ── Entrega: «Crear entrega», Despachar: the stock leaves the bodega; the pedido is no longer open; Por facturar grows by its subtotal. ──
    await frame(page).getByRole("button", { name: "Crear entrega", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.delivery\/[0-9a-f-]{36}$/);
    const deliveryId = page.url().split("/").pop()!;
    await frame(page).getByRole("button", { name: "Despachar", exact: true }).click();
    await expect(frame(page).getByTestId("delivery-stage")).toHaveText("Despachada");
    await deliver("sales.delivery.shipped", "deliveryId", deliveryId, "inventory");
    await expectCard(page, "sales", "sales.open_orders", String(before.openOrders));
    await expectCard(page, "invoicing", "invoicing.to_invoice", peso(before.toInvoice + SUBTOTAL));

    // ── Factura (manual creation): Por facturar → the pedido's line → «Crear facturas» → Borrador; Emitir numbers it (SETP) and posts it. ──
    await page.goto("/invoicing/pending");
    await expect(grid(page)).toBeVisible();
    await grid(page).getByLabel("Filtrar Pedido").fill(order!.number);
    await expect(grid(page).locator("tbody tr")).toHaveCount(1);
    await grid(page).getByRole("checkbox", { name: "Seleccionar todas las filas de la página" }).check();
    await page.getByRole("button", { name: "Crear facturas", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/invoicing\.invoice\/[0-9a-f-]{36}$/);
    const invoiceId = page.url().split("/").pop()!;
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Borrador");
    await expect(frame(page).getByTestId("invoice-total")).toHaveText(peso(TOTAL));
    await bar(page).getByRole("button", { name: "Emitir", exact: true }).click();
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Emitida");
    const [issued] = await sql<{ number: string; cufe: string }[]>`select number, cufe from invoicing.invoices where id = ${invoiceId}`;
    expect(issued!.number).toMatch(/^SETP\d+$/);
    expect(issued!.cufe).toMatch(/^[0-9a-f]{96}$/);
    await expectCard(page, "invoicing", "invoicing.to_invoice", peso(before.toInvoice));
    await expectCard(page, "invoicing", "invoicing.receivable", peso(before.receivable + TOTAL));

    // The DIAN (mock) accepts it: Aceptada; its signed XML (the placeholder the mock keeps) downloads through a signed link (rule 22).
    tsx(DIAN, ["invoice", invoiceId, "accepted"]);
    await page.goto(`/r/invoicing.invoice/${invoiceId}`);
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("Aceptada");
    await frame(page).getByRole("tab", { name: /^DIAN/ }).click();
    const xmlLink = frame(page).getByRole("link", { name: "Documento electrónico firmado (XML)" });
    await expect(xmlLink).toBeVisible();
    const signed = await page.request.get((await xmlLink.getAttribute("href"))!, { maxRedirects: 0 });
    expect(signed.status()).toBe(303);
    const xml = await page.request.get(signed.headers().location!);
    expect(xml.status()).toBe(200);
    expect(await xml.text()).toContain("<Invoice>");

    // Cartera por edades (as of today) has the sale: the customer owes its total more than before, not yet due.
    type AgingRow = { party_document: string; not_due: number; total: number };
    const aging = async () => (await report<AgingRow>(page.request, "accounting.aging", { kind: "receivable", asOf: today })).rows.find((r) => r.party_document === CUSTOMER_DOCUMENT);
    const owed = await aging();
    expect(owed, "the customer in the aging report").toBeTruthy();
    expect(Number(owed!.not_due)).toBeGreaterThanOrEqual(TOTAL);
    await page.goto(`/accounting/reports/aging?p=${encodeURIComponent(JSON.stringify({ kind: "receivable", asOf: today }))}`);
    await expect(page.getByRole("cell", { name: CUSTOMER }).first()).toBeVisible();

    // ── Registrar pago: the invoice applied in full, with the retefuente the customer withheld; Contabilizado; the invoice Pagada. ──
    await page.goto("/r/payments.receipt/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill("Distribuidora Caribe");
    await page.getByRole("option", { name: new RegExp(CUSTOMER) }).first().click();
    const open = frame(page).getByRole("table", { name: "Facturas del cliente" });
    await expect(open.getByRole("row", { name: new RegExp(issued!.number) })).toContainText(peso(TOTAL));
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: "Transferencia Bancolombia" });
    await frame(page).getByLabel(/^Referencia/).fill(`TRF-E2E-${invoiceId.slice(0, 8)}`);
    await open.getByLabel(`Aplicar a ${issued!.number}`).fill(String(TOTAL));
    await frame(page).getByRole("button", { name: `Agregar retención a ${issued!.number}` }).click();
    const held = frame(page).getByRole("group", { name: `Retención 1 de ${issued!.number}` });
    await held.getByLabel("Tipo").selectOption("income");
    await held.getByLabel("Código").fill("RTEFTE_COMPRAS_2.5");
    await held.getByLabel("Tarifa %").fill("2,5");
    await held.getByLabel("Base").fill(String(SUBTOTAL));
    await expect(held.getByLabel("Valor")).toHaveValue(String(RETEFUENTE));
    await frame(page).getByLabel(/^Valor recibido/).fill(String(TOTAL - RETEFUENTE));
    await expect(frame(page).getByTestId("payment-withholdings")).toHaveText(peso(RETEFUENTE));
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    await expect(frame(page).getByTestId("receipt-status")).toHaveText("Contabilizado");
    await deliver("payments.received", "paymentId", receiptId, "invoicing");
    expect(await sql`select stage, paid_amount::float8 as paid from invoicing.invoices where id = ${invoiceId}`).toEqual([{ stage: "paid", paid: TOTAL }]);
    await page.goto(`/r/invoicing.invoice/${invoiceId}`);
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Pagada");

    // Inicio after the payment: Por cobrar is back where it was; Recaudo del mes grew by the money received.
    await expectCard(page, "invoicing", "invoicing.receivable", peso(before.receivable));
    await expectCard(page, "payments", "payments.collected_month", peso(before.collected + TOTAL - RETEFUENTE));
    // And the aging report no longer has the sale: the customer owes what it owed before.
    const settled = await aging();
    expect(Number(settled?.total ?? 0)).toBeCloseTo(Number(owed!.total) - TOTAL, 2);

    // Información exógena 1007 (ingresos recibidos) of the year: the customer's ingresos grew by the sale's subtotal; Exportar XML downloads.
    expect(await income(page.request, year)).toBeCloseTo(before.income + SUBTOTAL, 2);
    await page.goto(`/accounting/reports/exogena?p=${encodeURIComponent(JSON.stringify({ year, format: "1007" }))}`);
    await expect(page.getByRole("button", { name: "Exportar XML" })).toBeVisible();
    // Exportar XML downloads the real 1007 file of the demo year: the 2A sample line on 421005 (Rendimientos financieros) names its tercero
    // (Bancolombia, scripts/demo/accounting.ts), so nothing refuses the file. It holds the sale's customer and the bank.
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar XML" }).click()]);
    expect(file.suggestedFilename()).toMatch(/\.xml$/);
    const exogenaXml = (await readFile((await file.path())!)).toString("utf8");
    expect(exogenaXml).toContain("<Formato>1007</Formato>");
    expect(exogenaXml).toContain(`<Ano>${year}</Ano>`);
    expect(exogenaXml).toContain(`nid="${CUSTOMER_DOCUMENT}"`);
    // The bank's interest (NC-18, $ 320.000) is under the default threshold: it is reported in the «CUANTÍAS MENORES» row, no longer refused.
    expect(exogenaXml).toContain('raz="CUANTÍAS MENORES"');
    await expect(page.getByRole("alert").filter({ hasText: "No se generó el archivo:" })).toHaveCount(0);
  });
});
