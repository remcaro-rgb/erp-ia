import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";
import { cleanupCompanies } from "../test-support/company-cleanup";

// The CRM and sales pages (plan 2B Task 14b, design §8, §8.1, §9, entity types spec §9.2, prototype 2B): a cotización written in its
// record, sent and accepted; «Crear pedido» from the accepted cotización; the pedido confirmed; «Crear entrega» and Despachar, which
// takes the stock out of Existencias (inventory's consumer, delivered here as the dispatch workflow's step would) and leaves the pedido
// Entregado; a devolución received puts it back. A prospecto converts into a customer and an oportunidad; a cotización over the discount
// threshold reads «Pendiente de aprobación» until the approver approves it; a customer that is not ready to invoice shows disabled with its
// reason in the lookup, and one that stopped being ready is refused with the reason when the cotización is accepted.

const PROCESSES = [
  "core.party.consult", "core.party.create", "core.product.consult",
  "crm.lead.create", "crm.lead.update", "crm.lead.convert", "crm.lead.consult",
  "crm.pipeline.create", "crm.pipeline.update", "crm.pipeline.consult", "crm.stage.consult",
  "crm.opportunity.create", "crm.opportunity.stage_move", "crm.opportunity.consult", "crm.opportunity_line.consult", "crm.opportunity.save", "crm.opportunity.void",
  "crm.activity.create", "crm.activity.consult",
  "crm.quote.create", "crm.quote.update", "crm.quote.send", "crm.quote.accept", "crm.quote.expire", "crm.quote.consult", "crm.quote_line.consult",
  "crm.quote.save", "crm.quote.submit", "crm.quote.approve", "crm.quote.reject", "crm.quote.void",
  "crm.settings.consult", "crm.settings.update",
  "sales.order.create", "sales.order.update", "sales.order.from_quote", "sales.order.confirm", "sales.order.consult", "sales.order_line.consult",
  "sales.order.save", "sales.order.submit", "sales.order.approve", "sales.order.reject", "sales.order.void", "sales.order.cancel",
  "sales.delivery.create", "sales.delivery.update", "sales.delivery.ship", "sales.delivery.consult", "sales.delivery_line.consult", "sales.delivery.save", "sales.delivery.void",
  "sales.return.create", "sales.return.receive", "sales.return.consult", "sales.return_line.consult", "sales.return.save", "sales.return.void",
  "sales.price.resolve", "sales.discount.resolve", "sales.customer_terms.consult", "sales.customer_terms.set", "sales.settings.consult", "sales.settings.update",
  "inventory.warehouse.consult", "inventory.stock_level.consult", "inventory.movement.consult",
  "kernel.saved_view.list", "kernel.saved_view.save", "kernel.saved_view.delete", "kernel.custom_field.list", "kernel.attachment.list", "kernel.export.run",
];

const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

test.describe("crm and sales pages", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let warehouseId: string;
  let productId: string;

  /** Delivers the outbox row of `event` whose payload names `key` = `value` to `moduleId`'s consumer. */
  const deliver = async (event: string, key: string, value: string, moduleId: string) => {
    const [row] = await fixture.sql<{ id: string }[]>`
      select id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>${key} = ${value} order by created_at desc limit 1`;
    expect(row, `${event} for ${value}`).toBeTruthy();
    execFileSync("pnpm", ["exec", "tsx", DELIVER, row!.id, moduleId], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 90_000 });
  };
  const onHand = async () =>
    Number((await fixture.sql<{ on_hand: string }[]>`select on_hand from inventory.stock_levels where company_id = ${companyId} and warehouse_id = ${warehouseId} and product_id = ${productId}`)[0]?.on_hand ?? 0);

  /** Picks the customer in the cotización's or pedido's Cliente box. */
  const pickCustomer = async (page: Page, name: string) => {
    await page.getByRole("combobox", { name: "Cliente" }).fill(name.slice(0, 10));
    await page.getByRole("option", { name: new RegExp(name) }).first().click();
  };
  const fillLine = async (page: Page, n: number, qty: string, discount?: string) => {
    await page.getByRole("combobox", { name: `Producto, línea ${n}` }).fill("VEN-CAF");
    await page.getByRole("option", { name: /VEN-CAF-500/ }).first().click();
    await page.getByLabel(`Cantidad, línea ${n}`).fill(qty);
    if (discount) await page.getByLabel(`Descuento %, línea ${n}`).fill(discount);
  };

  const party = (documentNumber: string, legalName: string, ready = true) => ({
    company_id: companyId,
    kind: ["customer"],
    person_type: "1",
    document_type: "31",
    document_number: documentNumber,
    legal_name: legalName,
    tax_responsibilities: ["O-13"],
    tax_scheme: "01",
    country_code: "CO",
    department_code: "11",
    municipality_code: "11001",
    address_line: "Cra 7 # 71-21",
    invoice_email: "fe@cliente.example",
    dian_status: ready ? "complete" : "missing: 1",
    ...(ready ? {} : { dian_missing: ["Dirección"] }),
  });

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    for (const key of ["module:core", "module:inventory", "module:costing", "module:sales", "module:crm"]) {
      await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    for (const process of PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    await sql`insert into core.parties ${sql(party("860002964", "Distribuidora La Sabana S.A.S."))}`;
    await sql`insert into core.parties ${sql(party("890903938", "Hotel Casa Andina S.A.S."))}`;
    await sql`insert into core.parties ${sql(party("800197268", "Tienda El Maizal S.A.S.", false))}`;
    const [category] = await sql<{ id: string }[]>`insert into core.product_categories (company_id, name, iva_rate, default_uom) values (${companyId}, 'Café', '5', 'KGM') returning id`;
    const [product] = await sql<{ id: string }[]>`
      insert into core.products ${sql({
        company_id: companyId,
        sku: "VEN-CAF-500",
        description: "Café Origen Huila 500 g",
        kind: "good",
        id_scheme: "999",
        uom_code: "KGM",
        iva_rate: "5",
        list_price: 28000,
        standard_cost: 17400,
        track_stock: true,
        category_id: category!.id,
        dian_status: "complete",
      })} returning id`;
    productId = product!.id;
    // The stock fixture: 20 units in Bodega Principal (the movement history is inventory's, Task 10's spec covers it).
    const [warehouse] = await sql<{ id: string }[]>`insert into inventory.warehouses (company_id, code, name, status) values (${companyId}, 'PRIN', 'Bodega Principal', 'saved') returning id`;
    warehouseId = warehouse!.id;
    await sql`insert into inventory.stock_levels (company_id, product_id, warehouse_id, on_hand) values (${companyId}, ${productId}, ${warehouseId}, 20)`;
  });

  test.afterAll(async () => {
    // Fix round 1: a failed beforeAll leaves no fixture; whatever the module cleanup does, the user, company and tenant still go.
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("cotización → pedido → entrega: accepted, confirmed, shipped; Existencias goes down, the pedido is Entregado; a devolución puts the stock back", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    // Cotizaciones (CRM › Documentos): the grid, then a new cotización with one line.
    await page.goto("/crm/quotes");
    await expect(page.getByRole("navigation", { name: "Menú del módulo" })).toBeVisible();
    await expect(grid(page)).toBeVisible();
    await page.goto("/r/crm.quote/new");
    await expect(page.getByRole("heading", { name: "Crear cotización" })).toBeVisible();
    await pickCustomer(page, "Distribuidora La Sabana");
    await fillLine(page, 1, "3");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/crm\.quote\/[0-9a-f-]{36}$/);
    const [quote] = await fixture.sql<{ id: string; number: string; status: string; total: string }[]>`select id, number, status, total::text from crm.quotes where company_id = ${companyId}`;
    expect(quote!.number).toMatch(/^COT-/);
    expect(quote!.status).toBe("saved");
    // 3 × $ 28.000 + IVA 5 % = $ 88.200,00, written with the money format (rule 23).
    expect(Number(quote!.total)).toBe(88200);
    await expect(frame(page).getByTestId("sales-total")).toHaveText("$ 88.200,00");
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Abierta");
    // The lines read in the universal grid (rule 20).
    await expect(frame(page).locator("section.erp-grid tbody tr")).toHaveCount(1);

    await frame(page).getByRole("button", { name: "Enviar al cliente", exact: true }).click();
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Enviada");
    await frame(page).getByRole("button", { name: "Aceptar cotización", exact: true }).click();
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Aceptada");

    // «Crear pedido»: the pedido copies the accepted lines, from the bodega chosen beside the button.
    await frame(page).getByLabel("Bodega del pedido").selectOption({ label: "PRIN · Bodega Principal" });
    await frame(page).getByRole("button", { name: "Crear pedido", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.order\/[0-9a-f-]{36}$/);
    const [order] = await fixture.sql<{ id: string; number: string; quote_id: string; warehouse_id: string }[]>`select id, number, quote_id, warehouse_id from sales.orders where company_id = ${companyId}`;
    expect(order!.quote_id).toBe(quote!.id);
    expect(order!.warehouse_id).toBe(warehouseId);
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Abierto");
    // The cotización is a reference that opens its record (rule 21).
    await expect(frame(page).getByRole("link", { name: quote!.number })).toBeVisible();

    await frame(page).getByRole("button", { name: "Confirmar pedido", exact: true }).click();
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Confirmado");
    await deliver("sales.order.confirmed", "orderId", order!.id, "inventory");

    // «Crear entrega»: everything the pedido has left to deliver; Despachar takes it out of the bodega.
    await frame(page).getByRole("button", { name: "Crear entrega", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.delivery\/[0-9a-f-]{36}$/);
    const [delivery] = await fixture.sql<{ id: string; number: string }[]>`select id, number from sales.deliveries where company_id = ${companyId}`;
    expect(delivery!.number).toMatch(/^ENT-/);
    await expect(frame(page).getByTestId("delivery-stage")).toHaveText("Por despachar");
    await frame(page).getByRole("button", { name: "Despachar", exact: true }).click();
    await expect(frame(page).getByTestId("delivery-stage")).toHaveText("Despachada");
    await deliver("sales.delivery.shipped", "deliveryId", delivery!.id, "inventory");
    expect(await onHand()).toBe(17);

    // Existencias (Inventario › Reportes) shows 17 left.
    await page.goto("/inventory/stock");
    await expect(grid(page).getByRole("row", { name: /Café Origen Huila 500 g/ })).toContainText("17");
    // The pedido reads Entregado in its grid.
    await page.goto("/sales/orders");
    await expect(grid(page).getByRole("row", { name: new RegExp(order!.number) })).toContainText("Entregado");

    // Devoluciones: «Crear devolución» from the entrega with its reason; Recibir brings the 3 units back.
    await page.goto(`/r/sales.delivery/${delivery!.id}`);
    await frame(page).getByLabel("Motivo de la devolución").fill("Empaque dañado");
    await frame(page).getByRole("button", { name: "Crear devolución", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.return\/[0-9a-f-]{36}$/);
    const [ret] = await fixture.sql<{ id: string; number: string }[]>`select id, number from sales.returns where company_id = ${companyId}`;
    expect(ret!.number).toMatch(/^DEV-/);
    await expect(frame(page).getByTestId("return-stage")).toHaveText("Por recibir");
    await frame(page).getByRole("button", { name: "Recibir", exact: true }).click();
    await expect(frame(page).getByTestId("return-stage")).toHaveText("Recibida");
    await deliver("sales.return.received", "returnId", ret!.id, "inventory");
    expect(await onHand()).toBe(20);
  });

  test("a prospecto converts into a customer and an oportunidad", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/crm/leads");
    await expect(grid(page)).toBeVisible();
    await page.goto("/r/crm.lead/new");
    await expect(page.getByRole("heading", { name: "Crear prospecto" })).toBeVisible();
    await page.getByLabel(/^Nombre/).fill("Tostadores del Cauca S.A.S.");
    await page.getByLabel(/^Contacto/).fill("Marta Rojas");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/crm\.lead\/[0-9a-f-]{36}$/);
    await expect(frame(page).getByTestId("lead-stage")).toHaveText("Nuevo");

    // Convertir en cliente: the document data the prospecto lacks, and the oportunidad's value.
    await frame(page).getByRole("button", { name: "Convertir en cliente", exact: true }).click();
    await frame(page).getByLabel("Tipo de persona").selectOption("1");
    await frame(page).getByLabel("Tipo de documento").selectOption("31");
    await frame(page).getByLabel("Número de documento").fill("901234567");
    await frame(page).getByLabel("Valor de la oportunidad").fill("1500000");
    await frame(page).getByRole("button", { name: "Convertir", exact: true }).click();
    await expect(frame(page).getByTestId("lead-stage")).toHaveText("Convertido");
    const [lead] = await fixture.sql<{ converted_party_id: string; converted_opportunity_id: string }[]>`
      select converted_party_id, converted_opportunity_id from crm.leads where company_id = ${companyId} and name = 'Tostadores del Cauca S.A.S.'`;
    expect(lead!.converted_party_id).toBeTruthy();
    const [opportunity] = await fixture.sql<{ number: string; amount: string }[]>`select number, amount::text from crm.opportunities where id = ${lead!.converted_opportunity_id}`;
    expect(Number(opportunity!.amount)).toBe(1500000);
    // Both are references that open their records (rule 21).
    await frame(page).getByRole("link", { name: opportunity!.number }).click();
    await expect(page).toHaveURL(new RegExp(`/r/crm\\.opportunity/${lead!.converted_opportunity_id}$`));
    await expect(frame(page).getByTestId("opportunity-outcome")).toHaveText("Abierta");
  });

  test("a cotización over the discount threshold waits for approval; the approver approves it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    // Parámetros de CRM: above 10 % a cotización needs approval.
    await page.goto("/crm/settings");
    await page.getByLabel("Descuento máximo sin aprobación (%)").fill("10");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();

    await page.goto("/r/crm.quote/new");
    await pickCustomer(page, "Hotel Casa Andina");
    await fillLine(page, 1, "2", "15");
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/crm\.quote\/[0-9a-f-]{36}$/);
    await expect(frame(page).locator(".erp-record__header")).toContainText("Pendiente de Aprobación");
    const status = async () => (await fixture.sql<{ status: string }[]>`select status from crm.quotes where company_id = ${companyId} and max_discount_pct = 15`)[0]!.status;
    expect(await status()).toBe("pending");
    // A pending cotización is not sent: the step is not offered.
    await expect(frame(page).getByRole("button", { name: "Enviar al cliente", exact: true })).toHaveCount(0);
    await bar(page).getByRole("button", { name: "Aprobar", exact: true }).click();
    await expect(frame(page).locator(".erp-record__header")).toContainText("Aprobado");
    expect(await status()).toBe("approved");
    await expect(frame(page).getByRole("button", { name: "Enviar al cliente", exact: true })).toBeVisible();
  });

  const today = async () => (await fixture.sql<{ d: string }[]>`select (now() at time zone timezone)::date::text as d from kernel.companies where id = ${companyId}`)[0]!.d;
  const voidWithBar = async (page: Page, reason: string) => {
    await bar(page).getByRole("button", { name: "Anular" }).click();
    await bar(page).getByRole("textbox", { name: "Motivo" }).fill(reason);
    await bar(page).getByRole("button", { name: "Confirmar", exact: true }).click();
  };

  test("step-up on save: a sensitive cotización asks for the code, then reads Pendiente de Aprobación (Grabar is not run on it)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Above 10 % a cotización needs approval (as the threshold test leaves it), and creating one is sensitive.
    await fixture.sql`insert into crm.settings (company_id, quote_approval_discount_pct) values (${companyId}, 10)
                      on conflict (company_id) do update set quote_approval_discount_pct = 10`;
    await fixture.sql`insert into kernel.sensitive_processes (company_id, process_id, mode) values (${companyId}, 'crm.quote.create', 'self_2fa')`;
    try {
      await signInWithCode(page, fixture, secret);
      await page.goto("/r/crm.quote/new");
      await pickCustomer(page, "Distribuidora La Sabana");
      await fillLine(page, 1, "1", "12");
      await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
      await confirmStepUp(page, secret);
      await expect(page).toHaveURL(/\/r\/crm\.quote\/[0-9a-f-]{36}$/);
      await expect(frame(page).locator(".erp-record__header")).toContainText("Pendiente de Aprobación");
      await expect(frame(page).getByRole("alert")).toHaveCount(0);
      expect((await fixture.sql<{ status: string }[]>`select status from crm.quotes where company_id = ${companyId} and max_discount_pct = 12`)[0]?.status).toBe("pending");
    } finally {
      await fixture.sql`delete from kernel.sensitive_processes where company_id = ${companyId} and process_id = 'crm.quote.create'`;
    }
  });

  test("a cotización: Imprimir makes its PDF; Duplicar copies its lines and starts today; Marcar vencida expires the copy", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const [source] = await fixture.sql<{ id: string }[]>`select id from crm.quotes where company_id = ${companyId} order by seq limit 1`;
    await page.goto(`/r/crm.quote/${source!.id}`);
    const job = page.waitForResponse((r) => /\/api\/export\/[0-9a-f-]{36}$/.test(r.url()));
    await bar(page).getByRole("button", { name: "Imprimir" }).click();
    const answer = (await (await job).json()) as { url?: string; fileName?: string };
    expect(answer.url).toBeTruthy();
    expect(answer.fileName).toMatch(/\.pdf$/);
    const [printed] = await fixture.sql<{ format: string; entity: string }[]>`select format, entity from kernel.export_jobs where company_id = ${companyId} order by created_at desc limit 1`;
    expect(printed).toMatchObject({ format: "pdf", entity: "crm.quote" });

    await bar(page).getByRole("button", { name: "Duplicar" }).click();
    await expect(page.getByRole("heading", { name: "Crear cotización" })).toBeVisible();
    await expect(page.getByLabel("Cantidad, línea 1")).toHaveValue("3");
    await expect(page.getByLabel(/^Fecha/).first()).toHaveValue(await today());
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/crm\.quote\/[0-9a-f-]{36}$/);
    const copyId = page.url().split("/").pop()!;
    expect(copyId).not.toBe(source!.id);
    expect(Number((await fixture.sql<{ n: string }[]>`select count(*) as n from crm.quote_lines where quote_id = ${copyId}`)[0]!.n)).toBe(1);

    await frame(page).getByRole("button", { name: "Marcar vencida", exact: true }).click();
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Vencida");
  });

  test("a pedido over the discount threshold waits for approval; Aprobar lets it be confirmed; it shows the credit; Cancelar pedido cancels it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const [sabana] = await fixture.sql<{ id: string }[]>`select id from core.parties where company_id = ${companyId} and document_number = '860002964'`;
    await fixture.sql`insert into sales.customer_terms (company_id, party_id, credit_limit) values (${companyId}, ${sabana!.id}, 5000000)`;
    await signInWithCode(page, fixture, secret);
    await page.goto("/sales/settings");
    await page.getByLabel(/^Descuento máximo de un pedido sin aprobación/).fill("10");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();

    await page.goto("/r/sales.order/new");
    await pickCustomer(page, "Distribuidora La Sabana");
    await page.getByRole("combobox", { name: /^Bodega/ }).first().selectOption({ label: "PRIN · Bodega Principal" });
    await fillLine(page, 1, "1", "20");
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/sales\.order\/[0-9a-f-]{36}$/);
    await expect(frame(page).locator(".erp-record__header")).toContainText("Pendiente de Aprobación");
    await expect(frame(page).getByRole("button", { name: "Confirmar pedido", exact: true })).toHaveCount(0);
    // Límite de crédito · Disponible (prototype 2B), in the money format.
    await expect(frame(page).getByTestId("order-credit")).toContainText("$ 5.000.000,00 · Disponible");
    // Task 20 fix round 1: the Disponible counts the customer's invoices. A role that may not consult invoices (the same role, for a
    // moment a plain one: only this spec's grants, none of invoicing's) sees no credit at all rather than a wrong one.
    const [admin] = await fixture.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    await fixture.sql`update kernel.roles set is_system = false where id = ${admin!.id}`;
    try {
      await page.reload();
      await expect(frame(page).getByTestId("order-stage")).toBeVisible();
      await expect(frame(page).getByTestId("order-credit")).toHaveCount(0);
      // The plain role needs the invoice consult (the module entitled, the grant given) and the all-orders permission («Cambiar el vendedor
      // de un pedido», so sales.v_orders holds every salesperson's orders; review F-4.2). The consult alone is not enough.
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:invoicing', 'manual')`;
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${admin!.id}, 'invoicing.invoice.consult')`;
      await page.reload();
      await expect(frame(page).getByTestId("order-stage")).toBeVisible();
      await expect(frame(page).getByTestId("order-credit")).toHaveCount(0);
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${admin!.id}, 'sales.order.reassign')`;
      await page.reload();
      await expect(frame(page).getByTestId("order-credit")).toContainText("$ 5.000.000,00 · Disponible");
    } finally {
      await fixture.sql`update kernel.roles set is_system = true where id = ${admin!.id}`;
    }
    await page.reload();
    await expect(frame(page).getByTestId("order-credit")).toContainText("$ 5.000.000,00 · Disponible");
    await bar(page).getByRole("button", { name: "Aprobar", exact: true }).click();
    await expect(frame(page).locator(".erp-record__header")).toContainText("Aprobado");
    await expect(frame(page).getByRole("button", { name: "Confirmar pedido", exact: true })).toBeVisible();

    await frame(page).getByLabel("Motivo de la cancelación").fill("El cliente desistió");
    await frame(page).getByRole("button", { name: "Cancelar pedido", exact: true }).click();
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Cancelado");
  });

  test("Anular a devolución, then its entrega: the stock comes back (inventory consumer simulated)", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const before = await onHand();
    await page.goto("/r/sales.order/new");
    await pickCustomer(page, "Distribuidora La Sabana");
    await page.getByRole("combobox", { name: /^Bodega/ }).first().selectOption({ label: "PRIN · Bodega Principal" });
    await fillLine(page, 1, "2");
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/sales\.order\/[0-9a-f-]{36}$/);
    const orderId = page.url().split("/").pop()!;
    await frame(page).getByRole("button", { name: "Confirmar pedido", exact: true }).click();
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Confirmado");
    await deliver("sales.order.confirmed", "orderId", orderId, "inventory");
    await frame(page).getByRole("button", { name: "Crear entrega", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.delivery\/[0-9a-f-]{36}$/);
    const deliveryId = page.url().split("/").pop()!;
    await frame(page).getByRole("button", { name: "Despachar", exact: true }).click();
    await expect(frame(page).getByTestId("delivery-stage")).toHaveText("Despachada");
    await deliver("sales.delivery.shipped", "deliveryId", deliveryId, "inventory");
    expect(await onHand()).toBe(before - 2);

    await frame(page).getByLabel("Motivo de la devolución").fill("Pedido por error");
    await frame(page).getByRole("button", { name: "Crear devolución", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/sales\.return\/[0-9a-f-]{36}$/);
    const returnId = page.url().split("/").pop()!;
    await voidWithBar(page, "Devolución duplicada");
    await expect.poll(async () => (await fixture.sql<{ status: string }[]>`select status from sales.returns where id = ${returnId}`)[0]?.status).toBe("voided");

    await page.goto(`/r/sales.delivery/${deliveryId}`);
    await voidWithBar(page, "Despacho equivocado");
    await expect.poll(async () => (await fixture.sql<{ status: string }[]>`select status from sales.deliveries where id = ${deliveryId}`)[0]?.status).toBe("voided");
    await deliver("sales.delivery.voided", "deliveryId", deliveryId, "inventory");
    expect(await onHand()).toBe(before);
  });

  test("an oportunidad moves to another etapa with Mover de etapa", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const [deal] = await fixture.sql<{ id: string; stage_id: string }[]>`select id, stage_id from crm.opportunities where company_id = ${companyId} and outcome = 'open' order by seq limit 1`;
    const [next] = await fixture.sql<{ id: string; name: string }[]>`
      select s.id, s.name from crm.stages s join crm.opportunities o on o.pipeline_id = s.pipeline_id
      where o.id = ${deal!.id} and s.id <> ${deal!.stage_id} and s.kind = 'open' order by s.line_no limit 1`;
    await page.goto(`/r/crm.opportunity/${deal!.id}`);
    await frame(page).getByLabel("Etapa", { exact: true }).selectOption({ label: next!.name });
    await frame(page).getByRole("button", { name: "Mover de etapa", exact: true }).click();
    await expect.poll(async () => (await fixture.sql<{ stage_id: string }[]>`select stage_id from crm.opportunities where id = ${deal!.id}`)[0]?.stage_id).toBe(next!.id);
  });

  test("every CRM and Ventas screen opens: the grids, the new-record forms and the parámetros pages", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    for (const href of ["/crm/pipelines", "/crm/opportunities", "/crm/activities", "/sales/deliveries", "/sales/returns"]) {
      await page.goto(href);
      await expect(grid(page), href).toBeVisible();
    }
    for (const [entity, heading] of [["crm.pipeline", "Crear embudo de ventas"], ["crm.opportunity", "Crear oportunidad"], ["crm.activity", "Crear actividad"], ["sales.order", "Crear pedido"], ["sales.delivery", "Crear entrega"], ["sales.return", "Crear devolución"]]) {
      await page.goto(`/r/${entity}/new`);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    // A new embudo starts with the standard etapas.
    await page.goto("/r/crm.pipeline/new");
    await expect(page.getByLabel("Etapa, fila 6")).toHaveValue("Perdida");
    await page.goto("/sales/settings");
    await expect(page.getByLabel(/^Descuento máximo de un pedido sin aprobación/)).toBeVisible();
    await page.goto("/sales/customer-terms");
    await expect(grid(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fijar condiciones de un cliente" })).toBeVisible();
  });

  test("a customer not ready to invoice: disabled with its reason in the lookup, and refused with the reason on accepting", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/r/crm.quote/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill("Tienda El");
    const option = page.getByRole("option", { name: /Tienda El Maizal/ }).first();
    await expect(option).toHaveAttribute("aria-disabled", "true");
    // The reason reads on the option itself (its title: "No se puede usar en facturas: Faltan datos DIAN: Dirección").
    await expect(option).toHaveAttribute("title", /Faltan datos DIAN: Dirección/);

    // A cotización for a ready customer who stops being ready before accepting: Aceptar is refused with the reason.
    await pickCustomer(page, "Hotel Casa Andina");
    await fillLine(page, 1, "1");
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/crm\.quote\/[0-9a-f-]{36}$/);
    await fixture.sql`update core.parties set dian_status = 'missing: 1', dian_missing = '{"Dirección"}' where company_id = ${companyId} and document_number = '890903938'`;
    await frame(page).getByRole("button", { name: "Aceptar cotización", exact: true }).click();
    await expect(frame(page).getByRole("alert")).toContainText("no está listo para facturar");
    await expect(frame(page).getByTestId("quote-stage")).toHaveText("Abierta");
  });
});
