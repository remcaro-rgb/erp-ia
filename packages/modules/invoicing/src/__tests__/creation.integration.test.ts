import { buildConsumerContext, consumers } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoicingHarness, registry, type Harness, type InvoiceOut } from "./helpers";

// How invoices are created (OD-2, plan 2B Task 16) and how they hold the sale chain together: «Por facturar» and «Facturar pedidos»
// (manual), one invoice per shipped entrega (on_delivery), one whole invoice at confirmation (on_order_confirmation), each never billing a
// unit twice; an automatic invoice whose customer is not ready stays in Borrador with a recommendation and the entrega still ships; sales
// records what was invoiced (delivery_lines.invoiced_qty, its consumer of invoicing.invoice.issued) and never voids an invoiced entrega,
// even while «Emitir» is in flight; and the customer's credit exposure is "firm pedidos not yet invoiced + issued invoices still owed".

let h: Harness;
beforeAll(async () => {
  h = await invoicingHarness();
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

const pendingOf = (orderId: string) => h.sql<{ delivery_line_id: string; pending_qty: string }[]>`
  select delivery_line_id, pending_qty::text from invoicing.v_pending_to_invoice where order_id = ${orderId} order by delivery_line_id`;
const invoicedQty = (deliveryId: string) => h.sql<{ qty: string; invoiced_qty: string }[]>`
  select qty::text, invoiced_qty::text from sales.delivery_lines where delivery_id = ${deliveryId} order by line_no`;
const linesOfInvoice = (invoiceId: string) => h.sql<{ qty: string; delivery_id: string | null; order_line_id: string | null }[]>`
  select qty::text, delivery_id, order_line_id from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`;

describe("invoice_creation = manual (default): «Por facturar» and «Facturar pedidos»", () => {
  it("a pedido shipped in two entregas is invoiced once with both; sales records the invoiced quantities; nothing is left to invoice", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 6 }]);
    const first = await h.shipDelivery(order.id, [{ orderLineId: order.lineIds[0]!, qty: 2 }]);
    const second = await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    // Manual: nothing invoices by itself.
    expect(await h.invoicesOf({ orderId: order.id })).toEqual([]);
    expect((await pendingOf(order.id)).map((p) => Number(p.pending_qty)).sort()).toEqual([2, 4]);

    const { invoices } = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id], issueDate: h.day(3, 12) });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "draft", origin: "from_orders", subtotal: 120000, total: 126000 });
    expect((await linesOfInvoice(invoices[0]!.id)).map((l) => [Number(l.qty), l.delivery_id])).toEqual(expect.arrayContaining([[2, first.id], [4, second.id]]));
    // The Borrador holds what it bills: «Por facturar» is empty and a second «Facturar pedidos» has nothing to take.
    expect(await pendingOf(order.id)).toEqual([]);
    expect((await h.refusal(h.run(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] })))?.message).toMatch(/^nothing_to_invoice/);

    await h.run(h.admin, "invoicing.invoice.issue", { id: invoices[0]!.id });
    expect(await h.drain()).toEqual([]);
    expect(await invoicedQty(first.id)).toEqual([{ qty: "2.0000", invoiced_qty: "2.0000" }]);
    expect(await invoicedQty(second.id)).toEqual([{ qty: "4.0000", invoiced_qty: "4.0000" }]);
  });

  it("an invoiced entrega is never voided, even before sales recorded the invoiced quantities", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    const delivery = await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    const { invoices } = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    await h.run(h.admin, "invoicing.invoice.issue", { id: invoices[0]!.id });
    // No drain: sales' consumer has not recorded invoiced_qty yet.
    expect(await invoicedQty(delivery.id)).toEqual([{ qty: "1.0000", invoiced_qty: "0.0000" }]);
    const refused = await h.refusal(h.run(h.admin, "sales.delivery.void", { id: delivery.id, reason: "Error" }));
    expect(refused?.message).toMatch(/^delivery_invoiced/);
    expect(await h.drain()).toEqual([]);
    expect((await h.refusal(h.run(h.admin, "sales.delivery.void", { id: delivery.id, reason: "Error" })))?.message).toMatch(/^delivery_invoiced/);
  });

  it("race: «Emitir» waits for an Anular of the entrega in flight and then refuses the voided entrega, with nothing written", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    const delivery = await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    const { invoices } = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    // The Anular in flight: it holds the entrega FOR UPDATE and voids it, then commits.
    const voiding = h.sql.begin(async (tx) => {
      await tx`select id from sales.deliveries where id = ${delivery.id} for update`;
      await tx`update sales.deliveries set status = 'voided', void_reason = 'Anulada en paralelo' where id = ${delivery.id}`;
      locked();
      await gate;
    });
    await holding;
    let settled = false;
    const issuing = h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: invoices[0]!.id })).finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await voiding;
    const refused = await issuing;
    expect(refused?.message).toMatch(/^delivery_voided/);
    expect(await h.sql`select number, stage from invoicing.invoices where id = ${invoices[0]!.id}`).toEqual([{ number: null, stage: "draft" }]);
  });
});

describe("invoice_creation = on_delivery", () => {
  beforeAll(async () => {
    await h.setMode("on_delivery");
  });
  afterAll(async () => {
    await h.setMode("manual");
  });

  it("each shipped entrega is invoiced and issued with exactly what it shipped; a redelivered event invoices nothing more", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 6 }]);
    const first = await h.shipDelivery(order.id, [{ orderLineId: order.lineIds[0]!, qty: 2 }]);
    expect(await h.drain()).toEqual([]);
    const second = await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    const invoices = await h.invoicesOf({ orderId: order.id });
    expect(invoices.map((i) => [i.origin, i.stage, i.status])).toEqual([["on_delivery", "issued", "posted"], ["on_delivery", "issued", "posted"]]);
    expect((await linesOfInvoice(invoices[0]!.id)).map((l) => [Number(l.qty), l.delivery_id])).toEqual([[2, first.id]]);
    expect((await linesOfInvoice(invoices[1]!.id)).map((l) => [Number(l.qty), l.delivery_id])).toEqual([[4, second.id]]);
    expect(await invoicedQty(second.id)).toEqual([{ qty: "4.0000", invoiced_qty: "4.0000" }]);

    const [shipped] = await h.sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = 'sales.delivery.shipped' and payload->>'deliveryId' = ${second.id}`;
    const consumer = consumers.for("sales.delivery.shipped").find((c) => c.moduleId === "invoicing")!;
    await consumer.fn(buildConsumerContext(h.sql, { id: shipped!.id, event: shipped!.event, createdAt: shipped!.created_at, companyId: h.companyId, chainId: shipped!.chain_id }, registry), shipped!.payload);
    expect(await h.invoicesOf({ orderId: order.id })).toHaveLength(2);
  });

  it("a customer that is not ready leaves the automatic invoice in Borrador with a recommendation; the entrega still ships; «Emitir» later resolves it", async () => {
    const customer = await h.newCustomer("830045678", "Cliente Por Revisar S.A.S.");
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }], { partyId: customer });
    const delivery = await h.shipDelivery(order.id);
    // The customer stops being ready between the despacho and the invoice.
    await h.run(h.admin, "core.party.deactivate", { id: customer });
    expect(await h.drain()).toEqual([]);
    expect(await h.sql`select stage from sales.deliveries where id = ${delivery.id}`).toEqual([{ stage: "shipped" }]);
    const [invoice] = await h.invoicesOf({ deliveryId: delivery.id });
    expect(invoice).toMatchObject({ stage: "draft", status: "draft", origin: "on_delivery", number: null });
    const recommendations = await h.sql<{ status: string; code: string; details: string[] }[]>`
      select status, code, details from invoicing.invoice_recommendations where invoice_id = ${invoice!.id}`;
    expect(recommendations).toEqual([{ status: "open", code: "not_invoice_ready", details: [expect.stringMatching(/^El cliente Cliente Por Revisar S\.A\.S\. no está listo para facturar: .*inactivo/)] }]);

    await h.sql`update core.parties set is_active = true where id = ${customer}`;
    expect((await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: invoice!.id })).stage).toBe("issued");
    expect(await h.sql`select status from invoicing.invoice_recommendations where invoice_id = ${invoice!.id}`).toEqual([{ status: "resolved" }]);
  });
});

describe("invoice_creation = on_order_confirmation", () => {
  beforeAll(async () => {
    await h.setMode("on_order_confirmation");
  });
  afterAll(async () => {
    await h.setMode("manual");
  });

  it("the confirmed pedido is invoiced whole once; its two entregas invoice nothing more", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 6 }]);
    expect(await h.drain()).toEqual([]);
    const [invoice] = await h.invoicesOf({ orderId: order.id });
    expect(invoice).toMatchObject({ origin: "on_order_confirmation", stage: "issued" });
    expect((await linesOfInvoice(invoice!.id)).map((l) => [Number(l.qty), l.delivery_id, l.order_line_id])).toEqual([[6, null, order.lineIds[0]]]);
    await h.shipDelivery(order.id, [{ orderLineId: order.lineIds[0]!, qty: 2 }]);
    await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    expect(await h.invoicesOf({ orderId: order.id })).toHaveLength(1);
    // Nothing of the entregas is left «Por facturar», and a hand-made invoice of the pedido is refused.
    expect(await pendingOf(order.id)).toEqual([]);
    expect((await h.refusal(h.run(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] })))?.message).toMatch(/^nothing_to_invoice/);
  });
});

describe("credit exposure (sales.credit_exposure): firm pedidos not yet invoiced + issued invoices still owed", () => {
  const exposure = async (partyId: string) => h.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(h.admin.claims)}, true)`;
    const [row] = await tx<{ exposure: string }[]>`select exposure::text from sales.credit_exposure(${partyId}::uuid, null)`;
    return Number(row!.exposure);
  });

  it("counts a pedido until it is invoiced, then the invoice until it is paid", async () => {
    const customer = await h.newCustomer("800111222", "Cupo Controlado S.A.S.");
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 6 }], { partyId: customer });
    expect(await exposure(customer)).toBe(126000);
    await h.shipDelivery(order.id, [{ orderLineId: order.lineIds[0]!, qty: 2 }]);
    expect(await h.drain()).toEqual([]);
    const { invoices } = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    // A Borrador is not owed yet: the pedido still counts whole.
    expect(await exposure(customer)).toBe(126000);
    await h.run(h.admin, "invoicing.invoice.issue", { id: invoices[0]!.id });
    // 84.000 of the pedido not invoiced + 42.000 open on the invoice.
    expect(await exposure(customer)).toBe(126000);
    await h.sql`update invoicing.invoices set paid_amount = 42000, stage = 'paid' where id = ${invoices[0]!.id}`;
    expect(await exposure(customer)).toBe(84000);
  });
});
