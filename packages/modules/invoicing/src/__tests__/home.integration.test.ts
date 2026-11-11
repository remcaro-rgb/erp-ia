import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainHarness, type ChainHarness } from "./chain-helpers";

// The Inicio cards of the sale chain's modules (plan 2B Task 26, main design §19a), computed by kernel.home.kpis as the company's admin on
// the chain harness (every module of the chain, the real posting engine, the e-invoice workflow on the mock DIAN): Pipeline (crm), Pedidos
// abiertos (sales), Stock bajo mínimo (inventory), Por facturar and Por cobrar (invoicing), Recaudo del mes (payments), Costos faltantes
// (costing), and the charts Ventas por mes and Pipeline por etapa, as one sale moves from the oportunidad to the receipt. A role that may
// not consult a module gets none of its cards; a masked amount hides its card.
//
// Figures: 10 × Café $ 28.500 = $ 285.000 + IVA 5 % = $ 299.250 (the chain test's sale).

const QTY = 10;
const SUBTOTAL = 285000;
const TOTAL = 299250;

let h: ChainHarness;

beforeAll(async () => {
  h = await chainHarness();
}, 300_000);

afterAll(async () => {
  await h.cleanup();
});

interface Card { id: string; value: number; unit: string; href?: string; tone?: string; detail?: { key: string; params: Record<string, unknown> } }
interface ChartOut { id: string; series: { points: { label: string; value: number }[] }[] }

const home = async (module?: string) =>
  h.run<{ kpis: Card[]; charts: ChartOut[] }>(h.admin, "kernel.home.kpis", module ? { module } : {});
const card = async (id: string): Promise<Card | undefined> => (await home(id.split(".")[0])).kpis.find((k) => k.id === id);

describe("the Inicio cards of the sale chain", () => {
  it("follow one sale from the oportunidad to the receipt", async () => {
    // Every module of the chain has its Inicio cards on the company-wide Inicio.
    const ids = (await home()).kpis.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(["crm.pipeline", "sales.open_orders", "invoicing.receivable", "invoicing.to_invoice", "payments.collected_month", "costing.cost_missing"]));
    // No minimum on the coffee yet: no Stock bajo mínimo card. With a minimum of 250 and 200 on hand, one product of one is below it.
    expect(await card("inventory.below_minimum")).toBeUndefined();
    await h.sql`update core.products set min_stock = 250 where id = ${h.cafe}`;
    expect(await card("inventory.below_minimum")).toMatchObject({ value: 1, unit: "count", tone: "warn", href: "/inventory/stock", detail: { params: { tracked: 1 } } });
    expect(await card("costing.cost_missing")).toMatchObject({ value: 0, unit: "count" });

    // Pipeline: an open oportunidad of $ 500.000; Pipeline por etapa puts it in its first etapa.
    const opportunityId = (await h.run<{ id: string }>(h.admin, "crm.opportunity.create", { title: "Café para Andina (Inicio)", partyId: h.partyId, pipelineId: h.pipelineId, amount: 500000 })).id;
    const pipeline = await card("crm.pipeline");
    expect(pipeline).toMatchObject({ value: 500000, unit: "money", detail: { params: { count: 1 } } });
    expect(pipeline!.href).toContain("/crm/opportunities?q=");
    expect((await home("crm")).charts.find((c) => c.id === "crm.pipeline_by_stage")!.series[0]!.points).toEqual([{ label: "Nuevo", value: 500000 }]);

    // The quote, accepted; the pedido from it: one pedido abierto; confirmed, it is still open (and counted confirmed), the deal won.
    const quote = await h.run<{ id: string }>(h.admin, "crm.quote.create", { partyId: h.partyId, opportunityId, issueDate: h.today, validUntil: h.plusDays(h.today, 30), lines: [{ productId: h.cafe, qty: QTY }] });
    await h.run(h.admin, "crm.quote.send", { id: quote.id });
    await h.run(h.admin, "crm.quote.accept", { id: quote.id });
    expect(await h.drain()).toEqual([]);
    const order = await h.run<{ id: string }>(h.admin, "sales.order.from_quote", { quoteId: quote.id, warehouseId: h.warehouseId, issueDate: h.today });
    expect(await card("sales.open_orders")).toMatchObject({ value: 1, unit: "count", detail: { params: { confirmed: 0 } } });
    await h.run(h.admin, "sales.order.confirm", { id: order.id });
    expect(await h.drain()).toEqual([]);
    expect(await card("sales.open_orders")).toMatchObject({ value: 1, detail: { params: { confirmed: 1 } } });
    expect(await card("crm.pipeline")).toMatchObject({ value: 0, detail: { params: { count: 0 } } });
    expect(await card("invoicing.to_invoice")).toMatchObject({ value: 0, detail: { params: { deliveries: 0 } } });

    // The entrega, shipped: nothing open in sales; Por facturar is what it shipped, before taxes; 190 left on hand, still below 250.
    const delivery = await h.run<{ id: string }>(h.admin, "sales.delivery.create", { orderId: order.id, date: h.today, costCenterId: h.costCenterId });
    await h.run(h.admin, "sales.delivery.ship", { id: delivery.id });
    expect(await h.drain()).toEqual([]);
    expect(await card("sales.open_orders")).toMatchObject({ value: 0 });
    expect(await card("invoicing.to_invoice")).toMatchObject({ value: SUBTOTAL, unit: "money", href: "/invoicing/pending", detail: { params: { deliveries: 1 } } });
    expect(await card("inventory.below_minimum")).toMatchObject({ value: 1 });

    // Facturada y emitida, accepted by the (mock) DIAN: nothing left to invoice; Por cobrar is its total, not yet due; Ventas por mes has it.
    const invoiceId = (await h.run<{ invoices: { id: string }[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] })).invoices[0]!.id;
    await h.run(h.admin, "invoicing.invoice.issue", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    expect(await h.settleDian(invoiceId)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    expect(await card("invoicing.to_invoice")).toMatchObject({ value: 0 });
    const receivable = await card("invoicing.receivable");
    expect(receivable).toMatchObject({ value: TOTAL, unit: "money", detail: { params: { count: 1, overdue: 0 } } });
    expect(receivable!.tone).toBeUndefined();
    expect(receivable!.href).toContain("/invoicing/invoices?q=");
    const month = h.today.slice(0, 7);
    expect((await home("invoicing")).charts.find((c) => c.id === "invoicing.sales_by_month")!.series[0]!.points).toEqual([{ label: month, value: SUBTOTAL }]);
    expect(await card("payments.collected_month")).toMatchObject({ value: 0, detail: { params: { count: 0, month } } });

    // Paid in full by a recibo de caja: Por cobrar is back to zero; Recaudo del mes is the money received.
    await h.run(h.admin, "payments.payment.receive", { partyId: h.partyId, methodId: h.transferId, amount: TOTAL, date: h.today, allocations: [{ invoiceId, amount: TOTAL }] });
    expect(await h.drain()).toEqual([]);
    expect(await card("invoicing.receivable")).toMatchObject({ value: 0, detail: { params: { count: 0 } } });
    expect(await card("payments.collected_month")).toMatchObject({ value: TOTAL, detail: { params: { count: 1 } } });
    expect((await home("payments")).charts.find((c) => c.id === "payments.collected_by_month")!.series[0]!.points).toEqual([{ label: month, value: TOTAL }]);
  });

  it("a role that may not consult invoices gets no invoicing card; a hidden total hides Por cobrar, not Por facturar", async () => {
    // An invoice still owed (1 × $ 28.500 + IVA 5 % = $ 29.925), so a hidden total matters.
    const order = await h.run<{ id: string }>(h.admin, "sales.order.create", { partyId: h.partyId, warehouseId: h.warehouseId, lines: [{ productId: h.cafe, qty: 1 }] });
    await h.run(h.admin, "sales.order.confirm", { id: order.id });
    expect(await h.drain()).toEqual([]);
    const delivery = await h.run<{ id: string }>(h.admin, "sales.delivery.create", { orderId: order.id, date: h.today, costCenterId: h.costCenterId });
    await h.run(h.admin, "sales.delivery.ship", { id: delivery.id });
    expect(await h.drain()).toEqual([]);
    const invoiceId = (await h.run<{ invoices: { id: string }[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] })).invoices[0]!.id;
    await h.run(h.admin, "invoicing.invoice.issue", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    expect(await card("invoicing.receivable")).toMatchObject({ value: 29925 });

    // The same user as a plain member of the company (the harness's member role instead of admin), allowed Inicio and Por facturar only.
    const [member] = await h.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${h.companyId} and not is_system order by created_at limit 1`;
    const [membership] = await h.sql<{ id: string }[]>`select id from kernel.memberships where company_id = ${h.companyId} and user_id = ${h.admin.claims.sub}`;
    const adminRoles = h.admin.claims.role_ids;
    const caller = { ...h.admin, claims: { ...h.admin.claims, role_ids: [member!.id] } };
    for (const id of ["kernel.home.kpis", "invoicing.pending_line.list"]) {
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${member!.id}, ${id}) on conflict do nothing`;
    }
    await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${member!.id} and process_id = 'invoicing.invoice.consult'`;
    await h.sql`delete from kernel.membership_roles where membership_id = ${membership!.id}`;
    await h.sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${member!.id})`;
    const ids = async () => (await h.run<{ kpis: Card[] }>(caller, "kernel.home.kpis", { module: "invoicing" })).kpis.map((k) => k.id);
    try {
      expect(await ids()).toEqual(["invoicing.to_invoice"]);
      // With the invoices' consult but their total hidden for the role: Por cobrar cannot be computed, so it is left out.
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${member!.id}, 'invoicing.invoice.consult') on conflict do nothing`;
      expect(await ids()).toEqual(["invoicing.receivable", "invoicing.to_invoice"]);
      await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${member!.id}, 'invoicing.invoice', 'total', 'hidden')
        on conflict (company_id, role_id, entity, field) do update set mode = 'hidden'`;
      expect(await ids()).toEqual(["invoicing.to_invoice"]);
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${member!.id} and entity = 'invoicing.invoice'`;
      await h.sql`delete from kernel.membership_roles where membership_id = ${membership!.id}`;
      for (const role of adminRoles) await h.sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${role})`;
    }
  });

  // Final review I-2: Stock bajo mínimo reads the masked stock levels as the caller (never the unmasked inventory.v_stock): a role whose
  // on-hand (or the stock level's product) is masked or hidden gets no card, never a count built on quantities it may not see.
  it("Stock bajo mínimo is left out for a role that may not see the on-hand", async () => {
    const [before] = await h.sql<{ min_stock: string | null }[]>`select min_stock::text from core.products where id = ${h.cafe}`;
    await h.sql`update core.products set min_stock = 1000000 where id = ${h.cafe}`;
    const [member] = await h.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${h.companyId} and not is_system order by created_at limit 1`;
    const [membership] = await h.sql<{ id: string }[]>`select id from kernel.memberships where company_id = ${h.companyId} and user_id = ${h.admin.claims.sub}`;
    const adminRoles = h.admin.claims.role_ids;
    const caller = { ...h.admin, claims: { ...h.admin.claims, role_ids: [member!.id] } };
    for (const id of ["kernel.home.kpis", "inventory.stock_level.consult"]) {
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${member!.id}, ${id}) on conflict do nothing`;
    }
    await h.sql`delete from kernel.membership_roles where membership_id = ${membership!.id}`;
    await h.sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${member!.id})`;
    const below = async () => (await h.run<{ kpis: Card[] }>(caller, "kernel.home.kpis", { module: "inventory" })).kpis.find((k) => k.id === "inventory.below_minimum");
    const restrict = (field: string, mode: "masked" | "hidden") => h.sql`
      insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${member!.id}, 'inventory.stock_level', ${field}, ${mode})
      on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
    const unrestrict = () => h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${member!.id} and entity = 'inventory.stock_level'`;
    try {
      expect(await below()).toMatchObject({ value: 1, detail: { params: { tracked: 1 } } });
      for (const [field, mode] of [["on_hand", "masked"], ["on_hand", "hidden"], ["product_id", "hidden"]] as const) {
        await restrict(field, mode);
        expect(await below(), `${field} ${mode}`).toBeUndefined();
        await unrestrict();
      }
      expect(await below()).toMatchObject({ value: 1 });
    } finally {
      await unrestrict();
      await h.sql`update core.products set min_stock = ${before!.min_stock} where id = ${h.cafe}`;
      await h.sql`delete from kernel.membership_roles where membership_id = ${membership!.id}`;
      for (const role of adminRoles) await h.sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${role})`;
    }
  });
});
