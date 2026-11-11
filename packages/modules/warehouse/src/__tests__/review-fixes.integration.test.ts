import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmedOrder, good, warehouseHarness, type Harness } from "./harness";

// Review fixes of Part G's warehouse lane (plan 2B.2 Tasks 29.1–29.3; RG-4, RG-7; migration 0174), with the real modules:
//   (1) a re-pick replaces the earlier allocation: ALI-1 confirmed and allocated, its unshipped entrega voided (sales emits nothing), then
//       «Crear alistamiento» makes ALI-2, whose confirmation is allocated (not short) and whose allocations are its lines; the same with
//       delivery_from_pick off (no entrega at all);
//   (2) RG-4: a blocked or expired lot is refused at the pick (lot_blocked, lot_expired), and a lot blocked between the confirmation and the
//       allocation is not free stock (short);
//   (3) the short answer lands on the pick line of the short bucket (ubicación, lot, serial), not on the first line of the pedido line;
//   (4) put-away moves at most what is left of the receipt: a receiving ubicación that holds other stock is not relocated again;
//   (5) a cancelled pedido voids the open empaque of its alistamiento.

interface PickRow { id: string; number: string | null; status: string; stage: string; allocation_status: string | null }
interface PickLine { id: string; line_no: number; order_line_id: string; location_id: string | null; lot_id: string | null; qty_picked: string | null; short_qty: string | null }
interface SuggestOut { lines: { productId: string; lotId: string | null; serialId: string | null; qty: number; fromLocationId: string | null; toLocationId: string | null }[] }

describe("warehouse review fixes (Part G lane C)", () => {
  let h: Harness;
  let a1: string;
  let a2: string;

  const picksOf = (orderId: string) =>
    h.sql<PickRow[]>`select id, number, status, stage, allocation_status from warehouse.picks where order_id = ${orderId} order by seq`;
  const linesOf = (pickId: string) =>
    h.sql<PickLine[]>`select id, line_no, order_line_id, location_id, lot_id, qty_picked::text, short_qty::text from warehouse.pick_lines where pick_id = ${pickId} order by line_no`;
  const allocations = (orderLineIds: string[]) =>
    h.sql<{ location_id: string | null; lot_id: string | null; qty: number }[]>`
      select a.location_id, a.lot_id, a.qty::float8 as qty from inventory.reservation_allocations a join inventory.reservations r on r.id = a.reservation_id
      where r.source_line_id = any(${orderLineIds}::uuid[]) and r.status = 'active' order by a.seq`;
  const openDeliveries = (orderId: string) => h.sql<{ id: string }[]>`select id from sales.deliveries where order_id = ${orderId} and status <> 'voided' order by seq`;
  const receive = async (lines: unknown[]) => {
    const posted = await h.run<{ id: string }>("inventory.movement.post", { kind: "receipt", date: h.day(2, 10), warehouseId: h.warehouseId, lines });
    expect(await h.drain()).toEqual([]);
    return posted.id;
  };

  beforeAll(async () => {
    h = await warehouseHarness("830114921");
    a1 = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "A1", name: "Estante A1" })).id;
    a2 = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "A2", name: "Estante A2" })).id;
  }, 300_000);

  afterAll(async () => {
    await h.cleanup();
  });

  it("(1) after ALI-1's unshipped entrega is voided, ALI-2 of the pedido is allocated (not short) and its allocations replace ALI-1's", async () => {
    const product = (await h.run<{ id: string }>("core.product.create", good(`RP-${randomUUID().slice(0, 6)}`))).id;
    await receive([{ productId: product, locationId: a1, qty: 4, unitCost: 100 }]);
    const order = await confirmedOrder(h, [{ productId: product, qty: 4 }]);
    const [first] = await picksOf(order.id);
    await h.run("warehouse.pick.confirm", { id: first!.id });
    expect(await h.drain()).toEqual([]);
    expect((await picksOf(order.id))[0]).toMatchObject({ stage: "confirmed", allocation_status: "allocated" });
    const [delivery] = await openDeliveries(order.id);
    await h.run("sales.delivery.void", { id: delivery!.id, reason: "Se alista de nuevo" });
    expect(await h.drain()).toEqual([]);

    const again = await h.run<{ created: boolean; pick?: { id: string; lines: { locationId: string | null; qtyRequested: number }[] } }>("warehouse.pick.create", { orderId: order.id });
    expect(again.created).toBe(true);
    // The pedido's own (stale) allocation does not hide the stock from its re-pick.
    expect(again.pick!.lines.map((l) => [l.locationId, l.qtyRequested])).toEqual([[a1, 4]]);
    await h.run("warehouse.pick.confirm", { id: again.pick!.id });
    expect(await h.drain()).toEqual([]);
    const second = (await picksOf(order.id)).find((p) => p.id === again.pick!.id);
    expect(second).toMatchObject({ stage: "confirmed", allocation_status: "allocated" });
    expect(await allocations(order.lineIds)).toEqual([{ location_id: a1, lot_id: null, qty: 4 }]);
    expect(await openDeliveries(order.id)).toHaveLength(1);
  });

  it("(1b) with delivery_from_pick off, a second alistamiento of the pedido replaces the first one's allocation", async () => {
    const product = (await h.run<{ id: string }>("core.product.create", good(`RQ-${randomUUID().slice(0, 6)}`))).id;
    await receive([{ productId: product, locationId: a1, qty: 3, unitCost: 100 }]);
    await h.runStepUp("warehouse.settings.update", { deliveryFromPick: false });
    try {
      const order = await confirmedOrder(h, [{ productId: product, qty: 3 }]);
      const [first] = await picksOf(order.id);
      await h.run("warehouse.pick.confirm", { id: first!.id });
      expect(await h.drain()).toEqual([]);
      const again = await h.run<{ created: boolean; pick?: { id: string } }>("warehouse.pick.create", { orderId: order.id });
      expect(again.created).toBe(true);
      await h.run("warehouse.pick.confirm", { id: again.pick!.id });
      expect(await h.drain()).toEqual([]);
      expect((await picksOf(order.id)).find((p) => p.id === again.pick!.id)).toMatchObject({ allocation_status: "allocated" });
      expect(await allocations(order.lineIds)).toEqual([{ location_id: a1, lot_id: null, qty: 3 }]);
    } finally {
      await h.runStepUp("warehouse.settings.update", { deliveryFromPick: true });
    }
  });

  it("(1c) a re-pick replaces only the stale allocation: the live entrega D1 keeps its 6, the third alistamiento is allocated 4, D1 ships from them", async () => {
    const product = (await h.run<{ id: string }>("core.product.create", good(`RS-${randomUUID().slice(0, 6)}`))).id;
    await receive([{ productId: product, locationId: a1, qty: 6, unitCost: 100 }, { productId: product, locationId: a2, qty: 4, unitCost: 100 }]);
    const order = await confirmedOrder(h, [{ productId: product, qty: 10 }]);
    // Pick 1 takes the 6 of A1 → entrega D1 (live).
    const [pick1] = await picksOf(order.id);
    const lines1 = await linesOf(pick1!.id);
    await h.run("warehouse.pick.confirm", { id: pick1!.id, lines: lines1.map((l) => ({ pickLineId: l.id, qtyPicked: l.location_id === a1 ? 6 : 0 })) });
    expect(await h.drain()).toEqual([]);
    const [d1] = await openDeliveries(order.id);
    // Pick 2 takes the 4 of A2 → entrega D2, voided unshipped (its allocation stays, stale).
    const pick2 = await h.run<{ pick: { id: string } }>("warehouse.pick.create", { orderId: order.id });
    await h.run("warehouse.pick.confirm", { id: pick2.pick.id });
    expect(await h.drain()).toEqual([]);
    const d2 = (await openDeliveries(order.id)).find((d) => d.id !== d1!.id)!;
    await h.run("sales.delivery.void", { id: d2.id, reason: "Se alista de nuevo" });
    expect(await h.drain()).toEqual([]);
    expect(await allocations(order.lineIds)).toEqual([{ location_id: a1, lot_id: null, qty: 6 }, { location_id: a2, lot_id: null, qty: 4 }]);
    // Pick 3 asks the 4 still to deliver: allocated; D1's 6 stay.
    const pick3 = await h.run<{ created: boolean; pick: { id: string; lines: { locationId: string | null; qtyRequested: number }[] } }>("warehouse.pick.create", { orderId: order.id });
    expect(pick3.pick.lines.map((l) => [l.locationId, l.qtyRequested])).toEqual([[a2, 4]]);
    await h.run("warehouse.pick.confirm", { id: pick3.pick.id });
    expect(await h.drain()).toEqual([]);
    expect((await picksOf(order.id)).find((p) => p.id === pick3.pick.id)).toMatchObject({ allocation_status: "allocated" });
    expect(await allocations(order.lineIds)).toEqual([{ location_id: a1, lot_id: null, qty: 6 }, { location_id: a2, lot_id: null, qty: 4 }]);
    await h.run("sales.delivery.ship", { id: d1!.id });
    expect(await h.drain()).toEqual([]);
    const at = async (locationId: string) =>
      Number((await h.sql<{ q: string }[]>`select coalesce(sum(on_hand), 0)::text as q from inventory.stock_levels where product_id = ${product} and location_id = ${locationId}`)[0]!.q);
    expect([await at(a1), await at(a2)]).toEqual([0, 4]);
    expect(await allocations(order.lineIds)).toEqual([{ location_id: a2, lot_id: null, qty: 4 }]);
  });

  it("(2, 3) RG-4: a blocked or expired lot is refused at the pick; a lot blocked before the allocation is short, recorded on its own pick line", async () => {
    const product = (await h.run<{ id: string }>("core.product.create", good(`RL-${randomUUID().slice(0, 6)}`))).id;
    await h.runStepUp("inventory.product_tracking.set", { productId: product, tracking: "lot" });
    await receive([
      { productId: product, locationId: a1, qty: 5, unitCost: 100, lot: { code: "X", expiresOn: `${h.year + 1}-06-01` } },
      { productId: product, locationId: a2, qty: 5, unitCost: 100, lot: { code: "Y", expiresOn: `${h.year + 1}-12-01` } },
    ]);
    const lot = async (code: string) => (await h.sql<{ id: string }[]>`select id from inventory.lots where product_id = ${product} and code = ${code}`)[0]!.id;
    const [x, y] = [await lot("X"), await lot("Y")];
    const order = await confirmedOrder(h, [{ productId: product, qty: 2 }]);
    const [pick] = await picksOf(order.id);
    const [line] = await linesOf(pick!.id);
    expect(line).toMatchObject({ location_id: a1, lot_id: x });

    // Blocked: refused at the pick (update and confirm).
    await h.run("inventory.lot.update", { id: x, status: "blocked" });
    const blocked = await h.refusal(h.run("warehouse.pick.confirm", { id: pick!.id }));
    expect(blocked?.message).toMatch(/^lot_blocked/);
    expect((await h.refusal(h.run("warehouse.pick.update", { id: pick!.id, lines: [{ pickLineId: line!.id, lotId: x, locationId: a1, qtyPicked: 2 }] })))?.message).toMatch(/^lot_blocked/);
    await h.run("inventory.lot.update", { id: x, status: "active" });

    // Split over Y (line 1) and X (line 2); X is blocked after the confirmation, before inventory allocates: X is not free stock.
    await h.run("warehouse.pick.confirm", { id: pick!.id, lines: [
      { pickLineId: line!.id, locationId: a2, lotId: y, qtyPicked: 1 },
      { pickLineId: line!.id, locationId: a1, lotId: x, qtyPicked: 1 },
    ] });
    await h.run("inventory.lot.update", { id: x, status: "blocked" });
    expect(await h.drain()).toEqual([]);
    const [answer] = await h.outbox("inventory.reservation.allocated", "pickId", pick!.id);
    expect(answer!.payload).toMatchObject({ status: "short", short: [{ orderLineId: order.lineIds[0], qty: 1, available: 0, locationId: a1, lotId: x }] });
    expect(await allocations(order.lineIds)).toEqual([]);
    const lines = await linesOf(pick!.id);
    expect(lines.map((l) => [l.lot_id, l.short_qty === null ? null : Number(l.short_qty)])).toEqual([[y, null], [x, 1]]);

    // Expired (the product blocks expired lots by default): refused at the pick.
    await h.run("inventory.lot.update", { id: y, expiresOn: `${h.year - 1}-01-01` });
    const expired = await h.refusal(h.run("warehouse.pick.confirm", { id: pick!.id, lines: [{ pickLineId: lines[1]!.id, qtyPicked: 0 }] }));
    expect(expired?.message).toMatch(/^lot_expired/);
  });

  it("(4) put-away moves only what is left of the receipt: a receiving ubicación holding other stock is not relocated again", async () => {
    const rec = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "RC", name: "Recepción" })).id;
    const shelf = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "ES", name: "Estante S" })).id;
    await h.run("warehouse.putaway_rule.create", { warehouseId: h.warehouseId, locationId: shelf, priority: 10 });
    const product = (await h.run<{ id: string }>("core.product.create", good(`PW-${randomUUID().slice(0, 6)}`))).id;
    // Recepción already holds 6 of the product (an earlier receipt nobody put away).
    await receive([{ productId: product, locationId: rec, qty: 6, unitCost: 100 }]);
    const receipt = await receive([{ productId: product, locationId: rec, qty: 4, unitCost: 100 }]);
    const suggestion = await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: receipt });
    expect(suggestion.lines.map((l) => [l.qty, l.fromLocationId, l.toLocationId])).toEqual([[4, rec, shelf]]);
    const confirm = () => h.run("warehouse.putaway.confirm", { movementId: receipt, lines: [{ productId: product, qty: 4, fromLocationId: rec, toLocationId: shelf }] });
    await confirm();
    expect(await h.drain()).toEqual([]);
    const at = async (locationId: string) =>
      Number((await h.sql<{ q: string }[]>`select coalesce(sum(on_hand), 0)::text as q from inventory.stock_levels where product_id = ${product} and location_id = ${locationId}`)[0]!.q);
    expect([await at(rec), await at(shelf)]).toEqual([6, 4]);
    // Nothing is left of this receipt in Recepción: nothing is suggested, and confirming again is refused before any event.
    expect((await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: receipt })).lines).toEqual([]);
    expect((await h.refusal(confirm()))?.message).toMatch(/^putaway_exceeds_stock/);
    expect([await at(rec), await at(shelf)]).toEqual([6, 4]);
  });

  it("(4b) the tally follows inventory's answer: a refused relocation counts nothing posted and the line is suggested again; a second confirm waits for it", async () => {
    const rec = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "RD", name: "Recepción D" })).id;
    const shelf = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "ED", name: "Estante D" })).id;
    const product = (await h.run<{ id: string }>("core.product.create", good(`PX-${randomUUID().slice(0, 6)}`))).id;
    const receipt = await receive([{ productId: product, locationId: rec, qty: 4, unitCost: 100 }]);
    const confirm = () => h.run("warehouse.putaway.confirm", { movementId: receipt, lines: [{ productId: product, qty: 4, fromLocationId: rec, toLocationId: shelf }] });
    const posted = async () =>
      Number((await h.sql<{ q: string }[]>`select coalesce(sum(qty), 0)::text as q from warehouse.putaway_moves where movement_id = ${receipt} and relocation_id is not null`)[0]!.q);
    await confirm();
    // Before inventory relocates, 2 of the 4 leave Recepción: inventory refuses the relocation (never below zero).
    await h.run("inventory.movement.post", { kind: "issue", date: h.day(2, 11), warehouseId: h.warehouseId, lines: [{ productId: product, locationId: rec, qty: -2 }] });
    const failures = await h.drain();
    expect(failures.map((f) => f.event)).toEqual(["warehouse.putaway.confirmed"]);
    expect(await posted()).toBe(0);
    expect((await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: receipt })).lines.map((l) => l.qty)).toEqual([2]);
    // The refused confirmation is still in flight (retried by the dispatcher): a second one cannot move the same units twice.
    const twice = await h.refusal(h.run("warehouse.putaway.confirm", { movementId: receipt, lines: [{ productId: product, qty: 2, fromLocationId: rec, toLocationId: shelf }] }));
    expect(twice?.message).toMatch(/^putaway_exceeds_stock/);
    // The dispatcher gives up on it (dead letter): the later drains of this file do not retry it.
    await h.sql`update kernel.outbox set dispatched_at = now() where company_id = ${h.companyId} and event = 'warehouse.putaway.confirmed' and payload->>'movementId' = ${receipt}`;
  });

  it("(5) a cancelled pedido voids the open empaque of its alistamiento; the voided empaque does not change", async () => {
    const product = (await h.run<{ id: string }>("core.product.create", good(`PK-${randomUUID().slice(0, 6)}`))).id;
    await receive([{ productId: product, locationId: a1, qty: 2, unitCost: 100 }]);
    const order = await confirmedOrder(h, [{ productId: product, qty: 2 }]);
    const [pick] = await picksOf(order.id);
    await h.run("warehouse.pick.confirm", { id: pick!.id });
    expect(await h.drain()).toEqual([]);
    const pack = await h.run<{ id: string }>("warehouse.pack.create", { pickId: pick!.id });
    for (const d of await openDeliveries(order.id)) await h.run("sales.delivery.void", { id: d.id, reason: "El cliente desistió" });
    await h.run("sales.order.cancel", { id: order.id, reason: "El cliente desistió" });
    expect(await h.drain()).toEqual([]);
    expect((await picksOf(order.id))[0]).toMatchObject({ status: "voided" });
    const [row] = await h.sql<{ status: string }[]>`select status from warehouse.packs where id = ${pack.id}`;
    expect(row!.status).toBe("voided");
    expect((await h.refusal(h.run("warehouse.pack.update", { id: pack.id, notes: "x" })))?.message).toMatch(/^pack_voided/);
    expect((await h.refusal(h.run("warehouse.pack.close", { id: pack.id })))?.message).toMatch(/^pack_voided/);
  });
});
