import { randomUUID } from "node:crypto";
import { buildConsumerContext, withClaims } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onDeliveryShipped, onDeliveryVoided, onReturnReceived, onReturnVoided } from "../processes/sales-deliveries";
import { onOrderConfirmed } from "../processes/sales-orders";
import { inventoryHarness, newId, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// FEFO issue, availability, deliveries and returns (plan 2B.2 Task 28.3, PG §3.3, §3.7; RG-4, Review Focus 1 and 2). A delivery line of a
// lot product that names no lot leaves by FEFO (expires_on asc nulls last, produced_on asc nulls last, code asc), split over the lots,
// one movement line per bucket, skipping blocked lots and (block_expired) lots expired at the delivery date; a named lot is honoured
// (lot_expired when expired); a serial line names its serials (serials_required). inventory.sale_issue.allocated tells sales what left.
// Availability (inventory.sale_stock, inventory.reservation.create) counts the lots FEFO may issue. Returns re-enter the named (or the
// original) lot at the issue's cost. Here the sales events are written by hand as sales would emit them.

const ORDER_LINE = "sales.order_line";
type Event = { event: string; payload: Record<string, unknown> };

describe("FEFO sale issue by lot and serial (Task 28.3)", () => {
  let h: InventoryHarness;
  let w: { id: string; locationId: string };

  beforeAll(async () => {
    h = await inventoryHarness();
    w = await warehouse(h, h.admin, "FEFO");
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const consumer = (event: string) => buildConsumerContext(h.sql, { id: randomUUID(), event, companyId: h.companyId, chainId: randomUUID(), createdAt: new Date() }, h.registry);
  const post = (kind: string, lines: Record<string, unknown>[], date = "2026-11-01") =>
    h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind, date, warehouseId: w.id, lines: lines.map((l) => ({ locationId: w.locationId, ...l })) });
  /** A lot-tracked product with lots A (expires 2026-12-01, 4 units) and B (2026-11-20, 3 units) received. */
  const lotProduct = async (sku: string, tracking: Record<string, unknown> = {}, lots = [{ code: "A", expiresOn: "2026-12-01", qty: 4 }, { code: "B", expiresOn: "2026-11-20", qty: 3 }]) => {
    const productId = await product(h, h.admin, `${sku}-${randomUUID().slice(0, 5)}`);
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId, tracking: "lot", ...tracking });
    if (lots.length > 0) await post("receipt", lots.map((l) => ({ productId, qty: l.qty, unitCost: 1000, lot: { code: l.code, expiresOn: l.expiresOn } })));
    const ids = await h.sql<{ id: string; code: string }[]>`select id, code from inventory.lots where product_id = ${productId}`;
    return { productId, lot: Object.fromEntries(ids.map((r) => [r.code, r.id])) as Record<string, string> };
  };
  const bucket = async (productId: string, lotId: string | null) =>
    Number((await h.sql<{ n: string }[]>`
      select coalesce(sum(on_hand), 0)::text as n from inventory.stock_levels where company_id = ${h.companyId} and product_id = ${productId} and lot_id is not distinct from ${lotId}::uuid`)[0]!.n);
  const eventsOf = (deliveryId: string) =>
    h.sql<Event[]>`select event, payload from kernel.outbox where company_id = ${h.companyId} and payload->>'deliveryId' = ${deliveryId} order by created_at, id`;
  /** Hands sales.delivery.shipped to inventory's consumer; answers the delivery and its line ids. */
  const ship = async (lines: { productId: string; qty: number; lotId?: string; serialIds?: string[]; orderLineId?: string }[], date = "2026-11-15") => {
    const deliveryId = newId();
    const withIds = lines.map((l) => ({ lineId: newId(), ...l }));
    await onDeliveryShipped(consumer("sales.delivery.shipped"), { deliveryId, number: "ENT-T", orderId: newId(), warehouseId: w.id, date, lines: withIds.map((l, i) => ({ lineNo: i + 1, ...l })) });
    const events = await eventsOf(deliveryId);
    return { deliveryId, lines: withIds, refused: events.find((e) => e.event === "inventory.sale_issue.refused")?.payload, allocated: events.find((e) => e.event === "inventory.sale_issue.allocated")?.payload };
  };
  const issueLines = (deliveryId: string) =>
    h.sql<{ id: string; lot_id: string | null; serial_id: string | null; location_id: string | null; qty: string; source_line_id: string }[]>`
      select l.id, l.lot_id, l.serial_id, l.location_id, l.qty::text, l.source_line_id from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
      where m.source_entity = 'sales.delivery' and m.source_id = ${deliveryId} and m.kind = 'sale_issue' order by l.line_no`;

  it("(1) lots A (expires 2026-12-01, 4) and B (2026-11-20, 3): a delivery of 5 takes 3 from B and 2 from A, two movement lines, and inventory tells sales", async () => {
    const p = await lotProduct("F1");
    const s = await ship([{ productId: p.productId, qty: 5 }]);
    expect(s.refused).toBeUndefined();
    const lines = await issueLines(s.deliveryId);
    expect(lines.map((l) => [l.lot_id, Number(l.qty), l.source_line_id])).toEqual([[p.lot.B, -3, s.lines[0]!.lineId], [p.lot.A, -2, s.lines[0]!.lineId]]);
    expect(await bucket(p.productId, p.lot.B!)).toBe(0);
    expect(await bucket(p.productId, p.lot.A!)).toBe(2);
    expect(s.allocated).toEqual({
      deliveryId: s.deliveryId,
      lines: [
        { deliveryLineId: s.lines[0]!.lineId, lotId: p.lot.B, lotCode: "B", expiresOn: "2026-11-20", serialId: null, serialNo: null, qty: 3 },
        { deliveryLineId: s.lines[0]!.lineId, lotId: p.lot.A, lotCode: "A", expiresOn: "2026-12-01", serialId: null, serialNo: null, qty: 2 },
      ],
    });
    // A redelivered shipped event issues nothing more and tells sales nothing new.
    const again = await h.sql`select count(*)::int as n from kernel.outbox where event = 'inventory.sale_issue.allocated' and payload->>'deliveryId' = ${s.deliveryId}`;
    expect(again[0]!.n).toBe(1);
  });

  it("(2) lot B blocked: 5 from A alone is short, so the delivery is refused all or nothing", async () => {
    const p = await lotProduct("F2");
    await h.run(h.admin, "inventory.lot.update", { id: p.lot.B, status: "blocked" });
    const s = await ship([{ productId: p.productId, qty: 5 }]);
    expect(s.refused).toMatchObject({ deliveryId: s.deliveryId, code: "lot_short" });
    expect(s.allocated).toBeUndefined();
    expect(await issueLines(s.deliveryId)).toEqual([]);
    expect(await bucket(p.productId, p.lot.A!)).toBe(4);
    expect(await bucket(p.productId, p.lot.B!)).toBe(3);
    // Within what A holds, B (blocked) is skipped although it expires first.
    const ok = await ship([{ productId: p.productId, qty: 2 }]);
    expect((await issueLines(ok.deliveryId)).map((l) => l.lot_id)).toEqual([p.lot.A]);
  });

  it("(3) lot B expired at the delivery date: skipped with block_expired, used with it off", async () => {
    const blocking = await lotProduct("F3");
    const s = await ship([{ productId: blocking.productId, qty: 3 }], "2026-11-25");
    expect((await issueLines(s.deliveryId)).map((l) => [l.lot_id, Number(l.qty)])).toEqual([[blocking.lot.A, -3]]);
    const lenient = await lotProduct("F3B", { blockExpired: false });
    const t = await ship([{ productId: lenient.productId, qty: 3 }], "2026-11-25");
    expect((await issueLines(t.deliveryId)).map((l) => [l.lot_id, Number(l.qty)])).toEqual([[lenient.lot.B, -3]]);
  });

  it("(4) a delivery line naming lot A takes A; naming an expired lot is refused lot_expired", async () => {
    const p = await lotProduct("F4");
    const s = await ship([{ productId: p.productId, qty: 2, lotId: p.lot.A! }]);
    expect((await issueLines(s.deliveryId)).map((l) => [l.lot_id, Number(l.qty)])).toEqual([[p.lot.A, -2]]);
    const expired = await ship([{ productId: p.productId, qty: 1, lotId: p.lot.B! }], "2026-11-25");
    expect(expired.refused).toMatchObject({ code: "lot_expired" });
    expect(await bucket(p.productId, p.lot.B!)).toBe(3);
    // A named lot that holds less than the line: lot_short, nothing moves.
    const short = await ship([{ productId: p.productId, qty: 3, lotId: p.lot.A! }]);
    expect(short.refused).toMatchObject({ code: "lot_short" });
  });

  it("(5) a serial product shipped without serials is refused serials_required; with them, each serial leaves its bucket", async () => {
    const serial = await product(h, h.admin, `F5-${randomUUID().slice(0, 5)}`);
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId: serial, tracking: "serial" });
    await post("receipt", [{ productId: serial, qty: 2, serials: [{ serialNo: "SN-F5-1" }, { serialNo: "SN-F5-2" }] }]);
    const none = await ship([{ productId: serial, qty: 1 }]);
    expect(none.refused).toMatchObject({ code: "serials_required" });
    const [sn1] = await h.sql<{ id: string }[]>`select id from inventory.serials where product_id = ${serial} and serial_no = 'SN-F5-1'`;
    const s = await ship([{ productId: serial, qty: 1, serialIds: [sn1!.id] }]);
    expect(s.refused).toBeUndefined();
    expect((await issueLines(s.deliveryId)).map((l) => [l.serial_id, Number(l.qty)])).toEqual([[sn1!.id, -1]]);
    expect((s.allocated as { lines: unknown[] }).lines).toEqual([{ deliveryLineId: s.lines[0]!.lineId, lotId: null, lotCode: null, expiresOn: null, serialId: sn1!.id, serialNo: "SN-F5-1", qty: 1 }]);
    expect((await h.sql<{ serial_status: string }[]>`select serial_status from inventory.serials where id = ${sn1!.id}`)[0]!.serial_status).toBe("issued");
  });

  it("(6) inventory.sale_stock and reservation.create see the lot stock minus blocked and expired lots; a lot-only order line reserves (Review Focus 2)", async () => {
    // A 5 (active), B 2 (blocked), C 3 (expired before today).
    const p = await lotProduct("F6", {}, [{ code: "A", expiresOn: "2099-12-01", qty: 5 }, { code: "B", expiresOn: "2099-06-01", qty: 2 }, { code: "C", expiresOn: "2020-01-01", qty: 3 }]);
    await h.run(h.admin, "inventory.lot.update", { id: p.lot.B, status: "blocked" });
    const saleStock = await withClaims(h.sql, h.admin.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'inventory.test', true)`;
      return tx<{ on_hand: string; max_bucket: string }[]>`select on_hand::text, max_bucket::text from inventory.sale_stock(${w.id}::uuid, ${[p.productId]}::uuid[])`;
    });
    expect(saleStock.map((r) => [Number(r.on_hand), Number(r.max_bucket)])).toEqual([[5, 5]]);
    // PG §3.7: inventory.v_stock's available leaves out the blocked and the expired lots too; on hand counts them all.
    expect(await stockOf(h, p.productId, w.id)).toEqual({ onHand: 10, reserved: 0, available: 5 });
    await expect(h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: newId(), productId: p.productId, warehouseId: w.id, qty: 6 }))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^reservation_exceeds_available/) });
    // The pedido's confirmation (sales.order.confirmed → inventory): the lot-only line reserves.
    const lineId = newId();
    await onOrderConfirmed(consumer("sales.order.confirmed"), { orderId: newId(), warehouseId: w.id, lines: [{ lineId, productId: p.productId, qty: 4 }] });
    const [reservation] = await h.sql<{ qty: string; status: string }[]>`select qty::text, status from inventory.reservations where source_line_id = ${lineId}`;
    expect(reservation).toMatchObject({ qty: "4.0000", status: "active" });
  });

  it("(7) a return of 2 goes back to lot A at the original issue line; the void of the delivery restores both lots and re-reserves", async () => {
    const p = await lotProduct("F7");
    const orderLineId = newId();
    await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: orderLineId, productId: p.productId, warehouseId: w.id, qty: 5 });
    const s = await ship([{ productId: p.productId, qty: 5, orderLineId }]);
    const issued = await issueLines(s.deliveryId);
    const issueA = issued.find((l) => l.lot_id === p.lot.A)!;
    const returnId = newId();
    const returnLineId = newId();
    await onReturnReceived(consumer("sales.return.received"), {
      returnId, number: "DEV-T", deliveryId: s.deliveryId, warehouseId: w.id, date: "2026-11-16",
      lines: [{ lineId: returnLineId, deliveryLineId: s.lines[0]!.lineId, productId: p.productId, qty: 2, lotId: p.lot.A }],
    });
    const [back] = await h.sql<{ lot_id: string; qty: string; return_of_line_id: string }[]>`
      select lot_id, qty::text, return_of_line_id from inventory.movement_lines where source_entity = 'sales.return' and source_line_id = ${returnLineId}`;
    expect(back).toMatchObject({ lot_id: p.lot.A, qty: "2.0000", return_of_line_id: issueA.id });
    expect(await bucket(p.productId, p.lot.A!)).toBe(4);
    expect(await bucket(p.productId, p.lot.B!)).toBe(0);
    // A return line naming no lot re-enters the lot its issue line left from first (B here).
    const defaultLine = newId();
    await onReturnReceived(consumer("sales.return.received"), {
      returnId: newId(), number: "DEV-U", deliveryId: s.deliveryId, warehouseId: w.id, date: "2026-11-16",
      lines: [{ lineId: defaultLine, deliveryLineId: s.lines[0]!.lineId, productId: p.productId, qty: 1 }],
    });
    expect(await bucket(p.productId, p.lot.B!)).toBe(1);
    // Void both returns, then the delivery with re-reservation: lots back to 4 and 3, the pedido line reserved 5 again.
    await onReturnVoided(consumer("sales.return.voided"), { returnId, reason: "Error", lines: [{ productId: p.productId }] });
    const [other] = await h.sql<{ source_id: string }[]>`select m.source_id from inventory.movements m join inventory.movement_lines l on l.movement_id = m.id where l.source_line_id = ${defaultLine}`;
    await onReturnVoided(consumer("sales.return.voided"), { returnId: other!.source_id, reason: "Error", lines: [{ productId: p.productId }] });
    await onDeliveryVoided(consumer("sales.delivery.voided"), {
      deliveryId: s.deliveryId, reason: "Error de despacho", reReserve: true, warehouseId: w.id, lines: [{ productId: p.productId, orderLineId, qty: 5 }],
    });
    expect(await bucket(p.productId, p.lot.A!)).toBe(4);
    expect(await bucket(p.productId, p.lot.B!)).toBe(3);
    const [reservation] = await h.sql<{ left: string }[]>`select (qty - released_qty)::text as left from inventory.reservations where source_line_id = ${orderLineId} and status = 'active'`;
    expect(Number(reservation!.left)).toBe(5);
  });

  it("(R3) an inactive lot is not sellable: FEFO skips it, availability leaves it out, and naming it is refused to sales", async () => {
    const p = await lotProduct("F9");
    // B expires first, but its maestro is inactive.
    await h.sql`update inventory.lots set is_active = false where id = ${p.lot.B!}`;
    const s = await ship([{ productId: p.productId, qty: 2 }]);
    expect(s.refused).toBeUndefined();
    expect((await issueLines(s.deliveryId)).map((l) => [l.lot_id, Number(l.qty)])).toEqual([[p.lot.A, -2]]);
    const saleStock = await withClaims(h.sql, h.admin.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'inventory.test', true)`;
      return tx<{ on_hand: string }[]>`select on_hand::text from inventory.sale_stock(${w.id}::uuid, ${[p.productId]}::uuid[], '2026-11-15'::date)`;
    });
    expect(saleStock.map((r) => Number(r.on_hand))).toEqual([2]);
    expect(await stockOf(h, p.productId, w.id)).toMatchObject({ onHand: 5, available: 2 });
    const named = await ship([{ productId: p.productId, qty: 1, lotId: p.lot.B! }]);
    expect(named.refused).toMatchObject({ code: "maestro_not_usable" });
    expect(await bucket(p.productId, p.lot.B!)).toBe(3);
  });

  it("(R3b) a maestro the movement's save finds not usable (an inactive ubicación) is refused to sales, never a silent dead letter", async () => {
    const other = await warehouse(h, h.admin, `FX${randomUUID().slice(0, 3)}`);
    const productId = await product(h, h.admin, `F9B-${randomUUID().slice(0, 5)}`);
    await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: "2026-11-01", warehouseId: other.id, lines: [{ productId, locationId: other.locationId, qty: 3 }] });
    await h.sql`update inventory.locations set is_active = false where id = ${other.locationId}`;
    const deliveryId = newId();
    await onDeliveryShipped(consumer("sales.delivery.shipped"), { deliveryId, number: "ENT-X", orderId: newId(), warehouseId: other.id, date: "2026-11-15", lines: [{ lineNo: 1, lineId: newId(), productId, qty: 1 }] });
    const refused = (await eventsOf(deliveryId)).find((e) => e.event === "inventory.sale_issue.refused")?.payload;
    expect(refused).toMatchObject({ deliveryId, code: "maestro_not_usable", reason: expect.stringContaining("ubicación") });
  });

  it("(R7) a manual entrega of another pedido does not take the units a confirmed alistamiento allocated (Review Focus 3)", async () => {
    const p = await lotProduct("F10");
    const orderX = newId();
    await h.run(h.admin, "inventory.reservation.create", { sourceEntity: ORDER_LINE, sourceLineId: orderX, productId: p.productId, warehouseId: w.id, qty: 3 });
    await consumer("warehouse.pick.confirmed").runProcess("inventory.reservation.allocate", {
      eventId: newId(), pickId: newId(), orderId: newId(), warehouseId: w.id, createDelivery: false,
      lines: [{ orderLineId: orderX, productId: p.productId, locationId: w.locationId, lotId: p.lot.B!, qty: 3 }],
    });
    // Pedido Y, no alistamiento: FEFO would take B (expires first), but X's pick holds all of B.
    const y = await ship([{ productId: p.productId, qty: 3 }]);
    expect(y.refused).toBeUndefined();
    expect((await issueLines(y.deliveryId)).map((l) => [l.lot_id, Number(l.qty)])).toEqual([[p.lot.A, -3]]);
    // Y again: only 1 of A is free (B is held), so 2 more is short.
    const short = await ship([{ productId: p.productId, qty: 2 }]);
    expect(short.refused).toMatchObject({ code: "lot_short" });
    // X ships its allocation.
    const x = await ship([{ productId: p.productId, qty: 3, orderLineId: orderX }]);
    expect(x.refused).toBeUndefined();
    expect((await issueLines(x.deliveryId)).map((l) => [l.lot_id, Number(l.qty)])).toEqual([[p.lot.B, -3]]);
  });

  it("(8) Review Focus 1: every bucket's on_hand equals the sum of its movement lines after (1)–(7); no serial on hand twice", async () => {
    const drift = await h.sql`
      select s.id, s.on_hand, s.lot_id, s.serial_id from inventory.stock_levels s
      where s.company_id = ${h.companyId} and s.on_hand <> coalesce((
        select sum(l.qty) from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
        where m.status <> 'voided' and m.warehouse_id = s.warehouse_id and l.product_id = s.product_id
          and l.location_id is not distinct from s.location_id and l.lot_id is not distinct from s.lot_id and l.serial_id is not distinct from s.serial_id), 0)`;
    expect(drift).toEqual([]);
    const twice = await h.sql`select serial_id from inventory.stock_levels where company_id = ${h.companyId} and serial_id is not null group by serial_id having sum(on_hand) > 1`;
    expect(twice).toEqual([]);
  });
});
