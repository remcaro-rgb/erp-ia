import { randomUUID } from "node:crypto";
import { buildConsumerContext } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onDeliveryVoided } from "../processes/sales-deliveries";
import { inventoryHarness, newId, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// Void delivery offers re-reserving the stock (plan 2B.2 Task 43, design §8.1 steps 3–4, R43-1..R43-12): inventory.sale.void_issue, the
// consumer of sales.delivery.voided, voids the sale issue and, when the event asks (reReserve), nests inventory.reservation.reserve_again:
// the pedido lines' reservations are restored by what the entrega had used up, all or nothing per entrega, only when the stock suffices. The
// outcome travels back as inventory.delivery_reservation.restored. Here the events are written by hand as sales would emit them.

const ORDER_LINE = "sales.order_line";
const today = "2026-11-04";
type Restored = { deliveryId: string; status: "reserved" | "insufficient" | "nothing"; short: { productId: string; sku: string; needed: number; available: number }[]; lines: { orderLineId: string; productId: string; qty: number }[] };

describe("void_issue → reserve_again", () => {
  let h: InventoryHarness;
  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const post = (input: Record<string, unknown>) => h.run<{ id: string }>(h.admin, "inventory.movement.post", input);

  /** A bodega with `onHand` of each product, a pedido line reserved per `lines` entry and its entrega shipped (issue posted, reservation used up). */
  async function shipped(lines: { sku: string; stock: number; reserved: number; qty: number }[]) {
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, `R${randomUUID().slice(0, 6)}`);
    const orderId = newId();
    const deliveryId = newId();
    const made: { productId: string; sku: string; orderLineId: string; lineId: string; qty: number }[] = [];
    for (const l of lines) {
      const productId = await product(h, h.admin, `${l.sku}-${randomUUID().slice(0, 5)}`);
      await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: l.stock }] });
      const orderLineId = newId();
      if (l.reserved > 0) await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: orderLineId, productId, warehouseId, qty: l.reserved });
      made.push({ productId, sku: l.sku, orderLineId, lineId: newId(), qty: l.qty });
    }
    await h.consumer().runProcess("inventory.movement.post", {
      kind: "sale_issue", date: today, warehouseId, sourceEntity: "sales.delivery", sourceId: deliveryId,
      lines: made.map((m) => ({ productId: m.productId, locationId, qty: -m.qty, sourceLineId: m.lineId })),
    });
    for (const m of made) await h.run(h.admin, "inventory.reservation.release", { sourceEntity: ORDER_LINE, sourceLineId: m.orderLineId, qty: m.qty });
    return { warehouseId, locationId, orderId, deliveryId, made };
  }

  const voidEvent = (s: Awaited<ReturnType<typeof shipped>>, extra: Record<string, unknown> = {}) => ({
    deliveryId: s.deliveryId, number: "ENT-1", orderId: s.orderId, warehouseId: s.warehouseId, date: today, reason: "Error de despacho",
    lines: s.made.map((m, i) => ({ lineId: m.lineId, lineNo: i + 1, orderLineId: m.orderLineId, productId: m.productId, qty: m.qty })),
    ...extra,
  });
  /** Hands the event to inventory's consumer as the dispatch does (the same row id = a redelivery); returns the chain it ran on. */
  const consume = async (payload: Record<string, unknown>, row = { id: randomUUID(), chainId: randomUUID() }) => {
    const ctx = buildConsumerContext(h.sql, { id: row.id, event: "sales.delivery.voided", companyId: h.companyId, chainId: row.chainId, createdAt: new Date() }, h.registry);
    await onDeliveryVoided(ctx, payload);
    return row;
  };
  const restored = async (deliveryId: string) =>
    (await h.sql<{ payload: Restored }[]>`select payload from kernel.outbox where company_id = ${h.companyId} and event = 'inventory.delivery_reservation.restored' and payload->>'deliveryId' = ${deliveryId} order by created_at`).map((r) => r.payload);
  const reservationsOf = (orderLineId: string) =>
    h.sql<{ qty: string; released_qty: string; status: string }[]>`select qty, released_qty, status from inventory.reservations where company_id = ${h.companyId} and source_line_id = ${orderLineId} order by seq`;

  it("yes + enough stock: each pedido line is reserved by what the entrega delivered, the stock is back, one nested audit row on the void's chain, result reserved", async () => {
    const s = await shipped([{ sku: "RA1", stock: 10, reserved: 6, qty: 4 }, { sku: "RA2", stock: 5, reserved: 3, qty: 2 }]);
    expect(await stockOf(h, s.made[0]!.productId, s.warehouseId)).toMatchObject({ onHand: 6, reserved: 2 });
    const row = await consume(voidEvent(s, { reReserve: true }));
    // The pedido lines are covered again: what they kept (2 and 1) plus what the entrega had used up (4 and 2), on the line's one active row.
    const remaining = async (orderLineId: string) => (await reservationsOf(orderLineId)).filter((r) => r.status === "active").map((r) => Number(r.qty) - Number(r.released_qty));
    expect(await remaining(s.made[0]!.orderLineId)).toEqual([6]);
    expect(await remaining(s.made[1]!.orderLineId)).toEqual([3]);
    // The stock came back: 10 and 5 on hand.
    expect(await stockOf(h, s.made[0]!.productId, s.warehouseId)).toMatchObject({ onHand: 10, reserved: 6 });
    expect(await stockOf(h, s.made[1]!.productId, s.warehouseId)).toMatchObject({ onHand: 5, reserved: 3 });
    const [audit] = await h.sql<{ origin: string; n: string }[]>`
      select origin, count(*) over () as n from kernel.audit_log where company_id = ${h.companyId} and process_id = 'inventory.reservation.reserve_again' and chain_id = ${row.chainId} limit 1`;
    expect(audit).toMatchObject({ origin: "event" });
    const [event] = await restored(s.deliveryId);
    expect(event).toMatchObject({ deliveryId: s.deliveryId, status: "reserved", short: [], lines: [{ orderLineId: s.made[0]!.orderLineId, qty: 4 }, { orderLineId: s.made[1]!.orderLineId, qty: 2 }] });
  });

  it("an active partial reservation of the line gets back what it released, not duplicated; a fully released one is brought back to life (same row, owner item 119(c))", async () => {
    // Line 1 reserved 6 of 10, 4 shipped: 2 stay reserved (one active row). Line 2 reserved exactly what shipped: its row is released.
    const s = await shipped([{ sku: "RB1", stock: 10, reserved: 6, qty: 4 }, { sku: "RB2", stock: 5, reserved: 2, qty: 2 }]);
    await consume(voidEvent(s, { reReserve: true }));
    const first = await reservationsOf(s.made[0]!.orderLineId);
    expect(first.filter((r) => r.status === "active")).toHaveLength(1);
    expect(first).toHaveLength(1);
    expect(Number(first[0]!.qty) - Number(first[0]!.released_qty)).toBe(6);
    const second = await reservationsOf(s.made[1]!.orderLineId);
    expect(second.map((r) => r.status)).toEqual(["active"]);
    expect(Number(second[0]!.qty) - Number(second[0]!.released_qty)).toBe(2);
  });

  it("owner item 119(c): a line gets back at most what its reservation released at ship; a line without reservation gets nothing", async () => {
    // Line 1 reserved only 2 of the 5 it shipped (backorder); line 2 had no reservation at all.
    const s = await shipped([{ sku: "RP1", stock: 10, reserved: 2, qty: 5 }, { sku: "RP2", stock: 5, reserved: 0, qty: 3 }]);
    await consume(voidEvent(s, { reReserve: true }));
    const [event] = await restored(s.deliveryId);
    expect(event!.status).toBe("reserved");
    const first = await reservationsOf(s.made[0]!.orderLineId);
    expect(first.filter((r) => r.status === "active").map((r) => Number(r.qty) - Number(r.released_qty))).toEqual([2]);
    expect(await reservationsOf(s.made[1]!.orderLineId)).toEqual([]);
  });

  it("yes + one product short: nothing is reserved, the void's stock return stands, result insufficient naming the product with needed and available", async () => {
    const s = await shipped([{ sku: "RC1", stock: 10, reserved: 4, qty: 4 }, { sku: "RC2", stock: 6, reserved: 4, qty: 4 }]);
    // Another document reserves what the second product had left (2) and a movement then takes it out: after the units come back, 4 are on
    // hand but 2 are promised to the other document, so 2 are available for the 4 needed.
    const second = s.made[1]!;
    await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: newId(), productId: second.productId, warehouseId: s.warehouseId, qty: 2 });
    await post({ kind: "issue", date: today, warehouseId: s.warehouseId, lines: [{ productId: second.productId, locationId: s.locationId, qty: -2 }] });
    await consume(voidEvent(s, { reReserve: true }));
    const [event] = await restored(s.deliveryId);
    expect(event!.status).toBe("insufficient");
    expect(event!.short).toEqual([{ productId: second.productId, sku: expect.stringMatching(/^RC2-/), needed: 4, available: 2 }]);
    // All or nothing: the first product, which had enough, was not reserved either.
    expect((await reservationsOf(s.made[0]!.orderLineId)).filter((r) => r.status === "active")).toHaveLength(0);
    expect((await h.sql`select 1 from inventory.movements where source_id = ${s.deliveryId} and status = 'voided'`).length).toBe(1);
    expect(await stockOf(h, s.made[0]!.productId, s.warehouseId)).toMatchObject({ onHand: 10 });
  });

  it("two lines of one product are summed for availability: each fits alone but not together", async () => {
    // The entrega delivered 3 + 3 of the same product on two pedido lines: each fits the availability alone, both together do not.
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, `S${randomUUID().slice(0, 6)}`);
    const productId = await product(h, h.admin, `SUM-${randomUUID().slice(0, 5)}`);
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 8 }] });
    const deliveryId = newId();
    const lines = [{ orderLineId: newId(), lineId: newId(), qty: 3 }, { orderLineId: newId(), lineId: newId(), qty: 3 }];
    // Each pedido line had reserved its 3, and shipping used the reservation up (owner item 119(c): only what was released comes back).
    for (const l of lines) {
      await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: l.orderLineId, productId, warehouseId, qty: 3 });
      await h.run(h.admin, "inventory.reservation.release", { sourceEntity: ORDER_LINE, sourceLineId: l.orderLineId, qty: 3 });
    }
    await h.consumer().runProcess("inventory.movement.post", {
      kind: "sale_issue", date: today, warehouseId, sourceEntity: "sales.delivery", sourceId: deliveryId,
      lines: lines.map((l) => ({ productId, locationId, qty: -l.qty, sourceLineId: l.lineId })),
    });
    // 2 left on hand: another document reserves them and a movement takes them out; 6 come back with 2 promised: 4 available for the 6 needed.
    await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: newId(), productId, warehouseId, qty: 2 });
    await post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -2 }] });
    await consume({
      deliveryId, number: "ENT-2", orderId: newId(), warehouseId, date: today, reason: "x", reReserve: true,
      lines: lines.map((l, i) => ({ lineId: l.lineId, lineNo: i + 1, orderLineId: l.orderLineId, productId, qty: l.qty })),
    });
    const [event] = await restored(deliveryId);
    expect(event).toMatchObject({ status: "insufficient", short: [{ productId, needed: 6, available: 4 }] });
    for (const l of lines) expect((await reservationsOf(l.orderLineId)).filter((r) => r.status === "active")).toEqual([]);
  });

  it("no (reReserve false or absent): nothing is reserved and no result event, as before this task", async () => {
    const s = await shipped([{ sku: "RD1", stock: 10, reserved: 4, qty: 4 }]);
    await consume(voidEvent(s));
    expect(await restored(s.deliveryId)).toEqual([]);
    expect((await reservationsOf(s.made[0]!.orderLineId)).filter((r) => r.status === "active")).toHaveLength(0);
    expect(await stockOf(h, s.made[0]!.productId, s.warehouseId)).toMatchObject({ onHand: 10, reserved: 0 });
    const s2 = await shipped([{ sku: "RD2", stock: 10, reserved: 4, qty: 4 }]);
    await consume(voidEvent(s2, { reReserve: false }));
    expect(await restored(s2.deliveryId)).toEqual([]);
  });

  it("a redelivered event reserves once and emits one result", async () => {
    const s = await shipped([{ sku: "RE1", stock: 10, reserved: 4, qty: 4 }]);
    const row = await consume(voidEvent(s, { reReserve: true }));
    await consume(voidEvent(s, { reReserve: true }), row);
    const active = (await reservationsOf(s.made[0]!.orderLineId)).filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(Number(active[0]!.qty) - Number(active[0]!.released_qty)).toBe(4);
    expect(await restored(s.deliveryId)).toHaveLength(1);
    // reserve_again is nested-only: nobody runs it on its own.
    await expect(h.run(h.admin, "inventory.reservation.reserve_again", { deliveryId: s.deliveryId, warehouseId: s.warehouseId, lines: [] })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("services and products that keep no stock are skipped; an entrega with no tracked line answers nothing", async () => {
    const { id: warehouseId } = await warehouse(h, h.admin, `V${randomUUID().slice(0, 6)}`);
    const servicio = await product(h, h.admin, `SRV-${randomUUID().slice(0, 5)}`, { kind: "service", trackStock: false });
    const deliveryId = newId();
    await consume({ deliveryId, number: "ENT-3", orderId: newId(), warehouseId, date: today, reason: "x", reReserve: true, lines: [{ lineId: newId(), lineNo: 1, orderLineId: newId(), productId: servicio, qty: 1 }] });
    expect(await restored(deliveryId)).toEqual([expect.objectContaining({ status: "nothing", lines: [] })]);
  });
  // Fix round 1 (review I-1): the stock checked and locked is the event's bodega; a line whose active reservation sits in another bodega is
  // never topped up there (R43-14).
  it("I-1: a line whose active reservation is in another bodega than the entrega's is not topped up: insufficient, nothing reserved anywhere", async () => {
    const a = await warehouse(h, h.admin, `A${randomUUID().slice(0, 6)}`);
    const b = await warehouse(h, h.admin, `B${randomUUID().slice(0, 6)}`);
    const productId = await product(h, h.admin, `XW-${randomUUID().slice(0, 5)}`);
    await post({ kind: "receipt", date: today, warehouseId: a.id, lines: [{ productId, locationId: a.locationId, qty: 10 }] });
    await post({ kind: "receipt", date: today, warehouseId: b.id, lines: [{ productId, locationId: b.locationId, qty: 4 }] });
    const orderLineId = newId();
    const lineId = newId();
    const deliveryId = newId();
    await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: orderLineId, productId, warehouseId: a.id, qty: 10 });
    await h.consumer().runProcess("inventory.movement.post", { kind: "sale_issue", date: today, warehouseId: b.id, sourceEntity: "sales.delivery", sourceId: deliveryId, lines: [{ productId, locationId: b.locationId, qty: -4, sourceLineId: lineId }] });
    await h.run(h.admin, "inventory.reservation.release", { sourceEntity: ORDER_LINE, sourceLineId: orderLineId, qty: 4 });
    await consume({ deliveryId, number: "ENT-9", orderId: newId(), warehouseId: b.id, date: today, reason: "x", reReserve: true, lines: [{ lineId, lineNo: 1, orderLineId, productId, qty: 4 }] });
    const [event] = await restored(deliveryId);
    expect(event!.status).toBe("insufficient");
    expect(event!.short).toEqual([expect.objectContaining({ productId, needed: 4, available: 0 })]);
    const rows = await reservationsOf(orderLineId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.qty) - Number(rows[0]!.released_qty)).toBe(6);
    expect(await stockOf(h, productId, a.id)).toMatchObject({ onHand: 10, reserved: 6 });
  });

  // Review I-2: an entrega whose issue never posted (every despacho refused) used nothing up: nothing to give back.
  it("I-2: a void whose despachos were all refused does not double the reservation: result nothing", async () => {
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, `Q${randomUUID().slice(0, 6)}`);
    const productId = await product(h, h.admin, `NI-${randomUUID().slice(0, 5)}`);
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 10 }] });
    const orderLineId = newId();
    const deliveryId = newId();
    await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: orderLineId, productId, warehouseId, qty: 4 });
    for (const event of ["sales.delivery.shipped", "inventory.sale_issue.refused"]) {
      await h.sql`insert into kernel.outbox (company_id, event, payload, chain_id) values (${h.companyId}, ${event}, ${h.sql.json({ deliveryId })}, ${randomUUID()})`;
    }
    await consume({ deliveryId, number: "ENT-8", orderId: newId(), warehouseId, date: today, reason: "x", reReserve: true, lines: [{ lineId: newId(), lineNo: 1, orderLineId, productId, qty: 4 }] });
    const rows = await reservationsOf(orderLineId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.qty) - Number(rows[0]!.released_qty)).toBe(4);
    expect(await restored(deliveryId)).toEqual([expect.objectContaining({ status: "nothing", lines: [] })]);
  });

  // Review M-1: the already-voided issue path also answers, so the entrega never waits for good.
  it("M-1: an event that finds its sale issue already voided still answers nothing, and reserves nothing", async () => {
    const s = await shipped([{ sku: "RM1", stock: 10, reserved: 4, qty: 4 }]);
    await consume(voidEvent(s));
    await consume(voidEvent(s, { reReserve: true }));
    expect(await restored(s.deliveryId)).toEqual([expect.objectContaining({ status: "nothing" })]);
    expect((await reservationsOf(s.made[0]!.orderLineId)).filter((r) => r.status === "active")).toHaveLength(0);
  });
});
