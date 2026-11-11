import { buildConsumerContext, consumers, type Caller } from "@erp/kernel";
import type { JwtClaims } from "@erp/kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoicingHarness, registry, type Harness } from "./helpers";

// An automatic invoice that cannot even be created leaves a recommendation for whoever bills (owner item 26, design §22.28, plan 2B Task 38):
// invoicing.invoice.auto_create answers `skipped` (no Borrador exists) and raises, through the kernel recommendation API, one open
// recommendation per entrega (or pedido) and reason, addressed to the holders of invoicing.invoice.create; the same refusal again merges;
// the document number is masked for a role that does not see it; «Descartar» is audited; invoicing the entrega by hand closes it.

let h: Harness;
let billing: Caller;
let billingMasked: Caller;
let warehouse: Caller;

interface Listed { id: string; reason: string | null; params: Record<string, unknown>; subject: { entity: string; id: string } | null; occurrences: number; module: string | null }
const listOf = async (caller: Caller) => (await h.run<{ recommendations: Listed[] }>(caller, "kernel.recommendation.list", { module: "invoicing" })).recommendations;
const rowsOf = (deliveryId: string) =>
  h.sql<{ id: string; status: string; reason: string; occurrences: number; audience_process_id: string; subject_entity: string; process_id: string; closed_reason: string | null }[]>`
    select r.id, r.status, r.reason, r.occurrences, r.audience_process_id, r.subject_entity, r.process_id, r.closed_reason
    from kernel.recommendations r where r.company_id = ${h.companyId} and r.subject_id = ${deliveryId} order by r.seq`;

beforeAll(async () => {
  h = await invoicingHarness();
  const { sql, companyId, seed } = h;
  const role = async (name: string) => (await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, ${name}, false) returning id`)[0]!.id;
  const grant = (roleId: string, processId: string) => sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${processId}) on conflict do nothing`;
  const as = async (roleId: string): Promise<Caller> => {
    await seed.holdRoles(seed.users.clerk!, companyId, [roleId]);
    return { claims: { ...seed.claimsFor(seed.users.clerk!, companyId), role_ids: [roleId] } as JwtClaims, origin: "ui" };
  };
  const billingRole = await role("Facturación");
  const maskedRole = await role("Facturación sin números");
  const warehouseRole = await role("Bodega");
  for (const roleId of [billingRole, maskedRole, warehouseRole]) {
    for (const id of ["kernel.recommendation.list", "kernel.recommendation.decide", "sales.delivery.consult"]) await grant(roleId, id);
  }
  for (const roleId of [billingRole, maskedRole]) await grant(roleId, "invoicing.invoice.create");
  await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${maskedRole}, 'sales.delivery', 'number', 'masked')`;
  billing = await as(billingRole);
  billingMasked = await as(maskedRole);
  warehouse = await as(warehouseRole);
  await h.setMode("on_delivery");
}, 300_000);
afterAll(async () => {
  await h.sql`delete from kernel.recommendations where company_id = ${h.companyId}`;
  await h.cleanup();
});

/** Hands the entrega's sales.delivery.shipped row to invoicing's consumer again (a redelivery of the event). */
async function redeliver(deliveryId: string): Promise<void> {
  const [row] = await h.sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = 'sales.delivery.shipped' and payload->>'deliveryId' = ${deliveryId}`;
  const consumer = consumers.for("sales.delivery.shipped").find((c) => c.moduleId === "invoicing")!;
  await consumer.fn(buildConsumerContext(h.sql, { id: row!.id, event: row!.event, createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, registry), row!.payload);
}

describe("auto_create refusals raise a recommendation (on_delivery)", () => {
  let customer: string;
  let orderId: string;
  let delivery: { id: string; number: string | null };

  beforeAll(async () => {
    customer = await h.newCustomer("830099001", "Cliente Cambiado S.A.S.");
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 2 }], { partyId: customer });
    orderId = order.id;
    const shipped = await h.shipDelivery(order.id);
    const [numbered] = await h.sql<{ number: string | null }[]>`select number from sales.deliveries where id = ${shipped.id}`;
    delivery = { id: shipped.id, number: numbered!.number };
    expect(delivery.number).toBeTruthy();
    // Between the despacho and its automatic invoice the tercero stops being a customer: the creation itself is refused (invalid_party).
    await h.sql`update core.parties set kind = array['supplier'] where id = ${customer}`;
    expect(await h.drain()).toEqual([]);
  });

  it("leaves no Borrador and exactly one open recommendation for whoever may create invoices", async () => {
    expect(await h.invoicesOf({ deliveryId: delivery.id })).toEqual([]);
    expect(await rowsOf(delivery.id)).toEqual([
      expect.objectContaining({ status: "new", reason: "invalid_party", occurrences: 1, audience_process_id: "invoicing.invoice.create", subject_entity: "sales.delivery", process_id: "invoicing.invoice.auto_create" }),
    ]);
  });

  it("the same refusal again for the same entrega and reason merges", async () => {
    await redeliver(delivery.id);
    expect((await rowsOf(delivery.id)).map((r) => [r.status, r.occurrences])).toEqual([["new", 2]]);
  });

  it("a role without invoicing.invoice.create does not see it; a billing role does, the number masked where its role masks it", async () => {
    const [row] = await rowsOf(delivery.id);
    expect((await listOf(warehouse)).map((r) => r.id)).not.toContain(row!.id);
    const seen = (await listOf(billing)).find((r) => r.id === row!.id)!;
    expect(seen).toMatchObject({ module: "invoicing", reason: "invalid_party", occurrences: 2, subject: { entity: "sales.delivery", id: delivery.id } });
    expect(seen.params.document).toBe(delivery.number);
    const masked = (await listOf(billingMasked)).find((r) => r.id === row!.id)!;
    expect(masked.params.document).toBeNull();
  });

  it("«Descartar» goes through kernel.recommendation.decide and is audited; the next refusal opens a new one", async () => {
    const [row] = await rowsOf(delivery.id);
    expect(await h.run(billing, "kernel.recommendation.decide", { id: row!.id, decision: "dismissed" })).toEqual({ id: row!.id, status: "dismissed" });
    const audit = await h.sql<{ process_id: string }[]>`
      select process_id from kernel.audit_log where company_id = ${h.companyId} and entity = 'kernel.recommendations' and row_id = ${row!.id} and action = 'update'`;
    expect(audit.map((a) => a.process_id)).toContain("kernel.recommendation.decide");
    await redeliver(delivery.id);
    expect((await rowsOf(delivery.id)).map((r) => r.status)).toEqual(["dismissed", "new"]);
  });

  it("invoicing the entrega by hand (Facturar pedidos) closes it", async () => {
    await h.sql`update core.parties set kind = array['customer'] where id = ${customer}`;
    await h.run(h.admin, "invoicing.invoice.from_orders", { orderIds: [orderId] });
    expect((await rowsOf(delivery.id)).map((r) => [r.status, r.closed_reason])).toEqual([["dismissed", null], ["closed", "cause_fixed"]]);
    expect((await listOf(billing)).map((r) => r.subject?.id)).not.toContain(delivery.id);
  });
});
