import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "@erp/kernel";
import type { JwtClaims } from "@erp/kernel/testing";
import { chainHarness, type ChainHarness } from "./chain-helpers";

// Order owner isolation across the chain (plan 2B Task 39, R39-9 to R39-11, migration 0139). The plan names
// packages/modules/sales/src/__tests__/order-owner.integration.test.ts, which covers the sales surfaces; these cases live here, on the chain
// harness, because they run invoicing's consumers and its e-invoice workflow in-process (sales may not depend on invoicing, as
// chain-failures.integration.test.ts explains):
//   * the auto-invoice consumer (on_order_confirmation) invoices the pedido of a salesperson whose role holds no «all orders» permission:
//     event consumers act as the system user with the company's admin role;
//   * a salesperson creating the invoice of another's shipped pedido finds nothing to invoice (the published sales views are RLS-bound);
//   * a refused automatic invoice of B's pedido raises the «no se facturó solo» recommendation about that pedido: only the holders of
//     invoicing.invoice.create who read the pedido see it (final review I-1, 0141), never A;
//   * the invoices stay readable (they are not isolated by the pedido's owner, R39-8) and their trail counts the other's pedido as hidden,
//     never naming it.

let h: ChainHarness;
let a: Caller;
let b: Caller;
let allOrders: Caller;

beforeAll(async () => {
  h = await chainHarness({ users: [{ name: "vendedorA", companies: [0], role: "member" }, { name: "vendedorB", companies: [0], role: "member" }, { name: "facturador", companies: [0], role: "member" }] });
  const [role] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, 'vendedor', false) returning id`;
  for (const id of [
    "sales.order.create", "sales.order.confirm", "sales.order.consult", "sales.order_line.consult", "sales.delivery.consult",
    "invoicing.invoice.from_orders", "invoicing.invoice.create", "invoicing.invoice.issue", "invoicing.invoice.consult", "kernel.document_link.trail",
    "kernel.recommendation.list", "kernel.recommendation.decide",
  ]) {
    await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${role!.id}, ${id}) on conflict do nothing`;
  }
  for (const user of [h.seed.users.vendedorA!, h.seed.users.vendedorB!]) await h.seed.holdRoles(user, h.companyId, [role!.id]);
  const as = (user: string): Caller => ({ claims: { ...h.seed.claimsFor(user, h.companyId), role_ids: [role!.id] } as JwtClaims, origin: "ui" });
  a = as(h.seed.users.vendedorA!);
  b = as(h.seed.users.vendedorB!);
  // A billing role that sees every pedido (the «all orders» permission, sales.order.reassign), held by «facturador».
  const [billing] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, 'facturación todos', false) returning id`;
  for (const id of ["invoicing.invoice.create", "sales.order.consult", "sales.order.reassign", "kernel.recommendation.list"]) {
    await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${billing!.id}, ${id}) on conflict do nothing`;
  }
  await h.seed.holdRoles(h.seed.users.facturador!, h.companyId, [billing!.id]);
  allOrders = { claims: { ...h.seed.claimsFor(h.seed.users.facturador!, h.companyId), role_ids: [billing!.id] } as JwtClaims, origin: "ui" };
}, 300_000);

afterAll(async () => {
  await h.cleanup();
});

const orderOf = async (caller: Caller, qty: number) => {
  const order = await h.run<{ id: string }>(caller, "sales.order.create", { partyId: h.partyId, issueDate: h.today, warehouseId: h.warehouseId, lines: [{ productId: h.cafe, qty }] });
  await h.run(caller, "sales.order.confirm", { id: order.id });
  return order;
};

describe("order owner isolation across the chain (Task 39)", () => {
  it("the auto-invoice consumer invoices B's pedido although B's role holds no sales.order.reassign (R39-10)", async () => {
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: "on_order_confirmation" });
    try {
      const order = await orderOf(b, 1);
      expect(await h.drain()).toEqual([]);
      const [invoice] = await h.sql<{ id: string; stage: string }[]>`select id, stage from invoicing.invoices where company_id = ${h.companyId} and auto_source = ${`order:${order.id}`}`;
      expect(invoice).toBeDefined();
      expect(invoice!.stage).not.toBe("draft");
      await h.settleDian(invoice!.id);
    } finally {
      await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
    }
  });

  it("a refused automatic invoice of B's pedido: the recommendation shows to B, the all-orders holder and the admin, never to A (I-1, 0141)", async () => {
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: "on_order_confirmation" });
    let orderId: string;
    try {
      const order = await orderOf(b, 1);
      orderId = order.id;
      // Between the confirmation and its automatic invoice the tercero stops being a customer: the creation is refused (invalid_party).
      await h.sql`update core.parties set kind = array['supplier'] where id = ${h.partyId}`;
      try {
        expect(await h.drain()).toEqual([]);
      } finally {
        await h.sql`update core.parties set kind = array['customer'] where id = ${h.partyId}`;
      }
    } finally {
      await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
    }
    const [rec] = await h.sql<{ id: string; reason: string }[]>`
      select id, reason from kernel.recommendations where company_id = ${h.companyId} and subject_entity = 'sales.order' and subject_id = ${orderId!} and status = 'new'`;
    expect(rec).toMatchObject({ reason: "invalid_party" });
    const orderNumber = (await h.sql<{ number: string }[]>`select number from sales.orders where id = ${orderId!}`)[0]!.number;
    type Listed = { total: number; recommendations: { id: string; params: Record<string, unknown>; subject: { entity: string; id: string } | null }[] };
    const listOf = (caller: Caller) => h.run<Listed>(caller, "kernel.recommendation.list", { module: "invoicing" });

    const seenByA = await listOf(a);
    expect(seenByA.recommendations.map((r) => r.id)).not.toContain(rec!.id);
    expect(JSON.stringify(seenByA)).not.toContain(orderNumber);
    expect(JSON.stringify(seenByA)).not.toContain(orderId!);
    // Nor can A dismiss it for the others.
    expect((await h.refusal(h.run(a, "kernel.recommendation.decide", { id: rec!.id, decision: "dismissed" })))?.code).toBe("not_found");
    for (const caller of [b, allOrders, h.admin]) {
      const seen = (await listOf(caller)).recommendations.find((r) => r.id === rec!.id);
      expect(seen).toMatchObject({ params: { document: orderNumber }, subject: { entity: "sales.order", id: orderId! } });
    }
    await h.sql`delete from kernel.recommendations where id = ${rec!.id}`;
  });

  it("A finds nothing to invoice of B's shipped pedido; the admin invoices it; A's trail of that invoice counts B's pedido hidden (R39-9, R39-11)", async () => {
    const order = await orderOf(b, 2);
    expect(await h.drain()).toEqual([]);
    const delivery = await h.run<{ id: string }>(h.admin, "sales.delivery.create", { orderId: order.id, date: h.today, costCenterId: h.costCenterId });
    await h.run(h.admin, "sales.delivery.ship", { id: delivery.id });
    expect(await h.drain()).toEqual([]);

    const refused = await h.refusal(h.run(a, "invoicing.invoice.from_orders", { orderIds: [order.id] }));
    expect(refused?.message).toMatch(/^nothing_to_invoice/);
    const created = await h.run<{ invoices: { id: string }[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    const invoiceId = created.invoices[0]!.id;

    // «Emitir» of that Borrador by A (review M-3, 0140): refused as a line A cannot read; B's pedido is neither named nor its stage told.
    const orderNumber = (await h.sql<{ number: string }[]>`select number from sales.orders where id = ${order.id}`)[0]!.number;
    const issued = await h.refusal(h.run(a, "invoicing.invoice.issue", { id: invoiceId }));
    expect(issued?.code).toBe("invalid_input");
    expect(issued?.message).toMatch(/^invalid_order_line/);
    const told = JSON.stringify({ message: issued?.message, details: issued?.details });
    expect(told).toMatch(/no existe o no es visible/);
    expect(told).not.toContain(orderNumber);
    expect(told).not.toMatch(/cancelado|no está confirmado/);

    // The invoice is readable by A (invoices are not isolated by the pedido's owner, R39-8); the pedido in its trail is only counted.
    expect(await h.run(a, "invoicing.invoice.consult", { id: invoiceId })).toMatchObject({ id: invoiceId });
    const trail = await h.run<{ nodes: { entity: string; id: string }[]; hidden: number }>(a, "kernel.document_link.trail", { entity: "invoicing.invoice", id: invoiceId });
    expect(trail.nodes.map((n) => n.id)).not.toContain(order.id);
    // Exactly one hidden document: B's pedido (A reads the entrega and the invoice).
    expect(trail.hidden).toBe(1);
    // B, the owner, sees the pedido in it.
    const own = await h.run<{ nodes: { entity: string; id: string }[] }>(b, "kernel.document_link.trail", { entity: "invoicing.invoice", id: invoiceId });
    expect(own.nodes.map((n) => n.id)).toContain(order.id);
  });
});
