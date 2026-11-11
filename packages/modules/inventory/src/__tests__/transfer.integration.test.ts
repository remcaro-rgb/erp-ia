import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessContext, Tx } from "@erp/kernel";
import { lockStock, lockStockLegs } from "../processes/movement";
import { inventoryHarness, product, stockOf, stockRows, warehouse, type InventoryHarness } from "./helpers";

// inventory.transfer.create / ship / receive (plan 2B Task 7, design §8.1): a traslado moves stock between two bodegas through the
// company's transit ubicación. Ship takes it out of the source into transit, receive takes it out of transit into the destination;
// the stock in transit shows in the stock views between the two. Both steps lock every leg in one ordered pass.

type Created = { id: string; number: string | null; status: string };
type Posted = { id: string; stage: string; movements: string[] };

describe("inventory transfers", () => {
  let h: InventoryHarness;
  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const today = "2026-11-04";
  // Without a ubicación the receipt fills the bodega's own stock, which a traslado line without ubicación takes.
  const receipt = (warehouseId: string, locationId: string | undefined, productId: string, qty: number) =>
    h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId, lines: [{ productId, ...(locationId ? { locationId } : {}), qty }] });
  const create = (input: Record<string, unknown>) => h.run<Created>(h.admin, "inventory.transfer.create", { date: today, ...input });
  const ship = (id: string) => h.run<Posted>(h.admin, "inventory.transfer.ship", { id });
  const receive = (id: string) => h.run<Posted>(h.admin, "inventory.transfer.receive", { id });
  const kindsOf = async (transferId: string) =>
    (await h.sql<{ kind: string; warehouse_id: string; qty: string }[]>`
      select m.kind, m.warehouse_id, l.qty from inventory.movements m join inventory.movement_lines l on l.movement_id = m.id
      where m.source_entity = 'inventory.transfer' and m.source_id = ${transferId} order by m.seq`).map((r) => [r.kind, Number(r.qty)]);
  const failures = (settled: PromiseSettledResult<unknown>[]) =>
    settled.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message ?? String(r));

  it("creates a numbered traslado in stage requested that moves nothing", async () => {
    const productId = await product(h, h.admin, "TR-1");
    const a = await warehouse(h, h.admin, "TA1");
    const b = await warehouse(h, h.admin, "TB1");
    await receipt(a.id, a.locationId, productId, 10);
    const t = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, fromLocationId: a.locationId, toLocationId: b.locationId, qty: 4 }] });
    expect(t).toMatchObject({ status: "saved" });
    expect(t.number).toMatch(/^TR-\d+$/);
    const [row] = await h.sql`select stage, status, requires_approval, posts, shipped_at from inventory.transfers where id = ${t.id}`;
    expect(row).toMatchObject({ stage: "requested", status: "saved", requires_approval: false, posts: false, shipped_at: null });
    expect(await stockOf(h, productId, a.id)).toMatchObject({ onHand: 10 });
    expect(await stockOf(h, productId, b.id)).toMatchObject({ onHand: 0 });
  });

  it("refuses a traslado to the same bodega, a ubicación of another bodega, a service and a product that keeps no stock", async () => {
    const productId = await product(h, h.admin, "TR-2");
    const a = await warehouse(h, h.admin, "TA2");
    const b = await warehouse(h, h.admin, "TB2");
    await expect(create({ fromWarehouseId: a.id, toWarehouseId: a.id, lines: [{ productId, qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^invalid_transfer:/) });
    await expect(create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, fromLocationId: b.locationId, qty: 1 }] })).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_transfer:/) });
    const service = await product(h, h.admin, "TR-2S", { kind: "service", trackStock: false });
    await expect(create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId: service, qty: 1 }] })).rejects.toMatchObject({ message: expect.stringMatching(/^service_product_refused:/) });
    const untracked = await product(h, h.admin, "TR-2U", { trackStock: false });
    await expect(create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId: untracked, qty: 1 }] })).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_transfer:/) });
    expect((await h.sql`select 1 from inventory.transfers where from_warehouse_id = ${a.id}`).length).toBe(0);
  });

  it("ship puts the stock in transit (visible in v_stock as a transit ubicación), receive delivers it; two movements each", async () => {
    const productId = await product(h, h.admin, "TR-3");
    const a = await warehouse(h, h.admin, "TA3");
    const b = await warehouse(h, h.admin, "TB3");
    await receipt(a.id, a.locationId, productId, 10);
    const t = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, fromLocationId: a.locationId, toLocationId: b.locationId, qty: 4 }] });

    const shipped = await ship(t.id);
    expect(shipped).toMatchObject({ id: t.id, stage: "in_transit" });
    expect(shipped.movements).toHaveLength(2);
    const rows = await stockRows(h, productId);
    expect(rows.find((r) => r.warehouseId === a.id)).toMatchObject({ onHand: 6, kind: "storage" });
    expect(rows.filter((r) => r.kind === "transit")).toEqual([expect.objectContaining({ onHand: 4 })]);
    expect(rows.find((r) => r.warehouseId === b.id)).toBeUndefined();
    const [row] = await h.sql`select stage, shipped_at is not null as shipped, transit_location_id is not null as has_transit from inventory.transfers where id = ${t.id}`;
    expect(row).toMatchObject({ stage: "in_transit", shipped: true, has_transit: true });
    expect(await kindsOf(t.id)).toEqual([["transfer_out", -4], ["transfer_in", 4]]);

    const received = await receive(t.id);
    expect(received).toMatchObject({ id: t.id, stage: "received" });
    const after = await stockRows(h, productId);
    expect(after.find((r) => r.warehouseId === a.id)).toMatchObject({ onHand: 6 });
    expect(after.find((r) => r.warehouseId === b.id)).toMatchObject({ onHand: 4, locationId: b.locationId });
    expect(after.filter((r) => r.kind === "transit")).toEqual([]);
    expect(await kindsOf(t.id)).toEqual([["transfer_out", -4], ["transfer_in", 4], ["transfer_out", -4], ["transfer_in", 4]]);
    const events = await h.sql<{ payload: { kind: string; sourceEntity: string } }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'inventory.movement.posted' and payload->>'sourceId' = ${t.id}`;
    expect(events.map((e) => e.payload.kind).sort()).toEqual(["transfer_in", "transfer_in", "transfer_out", "transfer_out"]);
    expect(events.every((e) => e.payload.sourceEntity === "inventory.transfer")).toBe(true);
  });

  it("refuses ship twice, receive before ship and receive twice; a refused ship leaves the stage and the stock", async () => {
    const productId = await product(h, h.admin, "TR-4");
    const a = await warehouse(h, h.admin, "TA4");
    const b = await warehouse(h, h.admin, "TB4");
    await receipt(a.id, undefined, productId, 3);
    const big = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 5 }] });
    await expect(ship(big.id)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^negative_stock_refused:/) });
    expect((await h.sql`select stage from inventory.transfers where id = ${big.id}`)[0]).toMatchObject({ stage: "requested" });
    expect(await stockOf(h, productId, a.id)).toMatchObject({ onHand: 3 });
    expect((await h.sql`select 1 from inventory.movements where source_id = ${big.id}`).length).toBe(0);

    const t = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 2 }] });
    await expect(receive(t.id)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^invalid_transfer_stage:/) });
    await ship(t.id);
    await expect(ship(t.id)).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_transfer_stage:/) });
    await receive(t.id);
    await expect(receive(t.id)).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_transfer_stage:/) });
    expect(await stockOf(h, productId, b.id)).toMatchObject({ onHand: 2 });
  });

  it("two concurrent ships of the same traslado move it once", async () => {
    const productId = await product(h, h.admin, "TR-5");
    const a = await warehouse(h, h.admin, "TA5");
    const b = await warehouse(h, h.admin, "TB5");
    await receipt(a.id, undefined, productId, 10);
    const t = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 6 }] });
    const results = await Promise.allSettled([ship(t.id), ship(t.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(h, productId, a.id)).toMatchObject({ onHand: 4 });
  });

  it("a requested traslado can be voided; a shipped one cannot, and its legs are not voidable on their own", async () => {
    const productId = await product(h, h.admin, "TR-6");
    const a = await warehouse(h, h.admin, "TA6");
    const b = await warehouse(h, h.admin, "TB6");
    await receipt(a.id, undefined, productId, 5);
    const first = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 1 }] });
    await h.run(h.admin, "inventory.transfer.void", { id: first.id, reason: "Pedido duplicado" });
    expect((await h.sql`select status from inventory.transfers where id = ${first.id}`)[0]).toMatchObject({ status: "voided" });
    await expect(ship(first.id)).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_transfer_stage:/) });

    const t = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 2 }] });
    await ship(t.id);
    await expect(h.run(h.admin, "inventory.transfer.void", { id: t.id, reason: "Ya salió" })).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_transfer_stage:/) });
    const [leg] = await h.sql<{ id: string }[]>`select id from inventory.movements where source_id = ${t.id} order by seq limit 1`;
    await expect(h.run(h.admin, "inventory.movement.void", { id: leg!.id, reason: "x" })).rejects.toMatchObject({ message: expect.stringMatching(/^movement_kind_not_voidable:/) });
  });

  it("opposite-direction traslados ship and receive concurrently without deadlock (every leg locked in one ordered pass)", async () => {
    const products = [await product(h, h.admin, "TR-7A"), await product(h, h.admin, "TR-7B"), await product(h, h.admin, "TR-7C")];
    const a = await warehouse(h, h.admin, "TA7");
    const b = await warehouse(h, h.admin, "TB7");
    for (const p of products) {
      await receipt(a.id, undefined, p, 100);
      await receipt(b.id, undefined, p, 100);
    }
    const lines = (reverse: boolean) => (reverse ? [...products].reverse() : products).map((productId) => ({ productId, qty: 1 }));
    const ab: Created[] = [];
    const ba: Created[] = [];
    for (let i = 0; i < 6; i++) {
      ab.push(await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: lines(false) }));
      ba.push(await create({ fromWarehouseId: b.id, toWarehouseId: a.id, lines: lines(true) }));
    }
    // Ship everything at once, A→B against B→A; then receive everything at once.
    expect(failures(await Promise.allSettled([...ab, ...ba].map((t) => ship(t.id))))).toEqual([]);
    expect(failures(await Promise.allSettled([...ab, ...ba].map((t) => receive(t.id))))).toEqual([]);
    for (const p of products) {
      expect(await stockOf(h, p, a.id)).toMatchObject({ onHand: 100 });
      expect(await stockOf(h, p, b.id)).toMatchObject({ onHand: 100 });
      expect((await stockRows(h, p)).filter((r) => r.kind === "transit")).toEqual([]);
    }
  });

  it("the ship of A→B races the receive of B→A (A then transit against transit then A) without deadlock", async () => {
    const productId = await product(h, h.admin, "TR-8");
    const a = await warehouse(h, h.admin, "TA8");
    const b = await warehouse(h, h.admin, "TB8");
    await receipt(a.id, undefined, productId, 50);
    await receipt(b.id, undefined, productId, 50);
    const inbound: Created[] = [];
    for (let i = 0; i < 8; i++) {
      const t = await create({ fromWarehouseId: b.id, toWarehouseId: a.id, lines: [{ productId, qty: 1 }] });
      await ship(t.id);
      inbound.push(t);
    }
    const outbound: Created[] = [];
    for (let i = 0; i < 8; i++) outbound.push(await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 1 }] }));
    const settled = await Promise.allSettled([...outbound.map((t) => ship(t.id)), ...inbound.map((t) => receive(t.id))]);
    expect(failures(settled)).toEqual([]);
    expect(await stockOf(h, productId, a.id)).toMatchObject({ onHand: 50 });
    expect((await stockRows(h, productId)).filter((r) => r.kind === "transit")).toEqual([expect.objectContaining({ onHand: 8 })]);
  });

  // The company's counter row already queues two movements of a company, so a race cannot show the lock order; this does: a waiter on the
  // lower bodega must hold nothing of the higher one, whatever order the legs were requested in.
  it("lockStockLegs takes the lower bodega first whatever the request order: a transaction waiting on it holds nothing of the higher one", async () => {
    const productId = await product(h, h.admin, "TR-9");
    const a = await warehouse(h, h.admin, "TA9");
    const b = await warehouse(h, h.admin, "TB9");
    const [low, high] = [a.id, b.id].sort() as [string, string];
    const ctxOf = (tx: unknown) => ({ tx: tx as Tx, companyId: h.companyId }) as unknown as ProcessContext;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const lowHeld = new Promise<void>((resolve) => (held = resolve));
    const holder = h.sql.begin(async (tx) => {
      await lockStock(ctxOf(tx), low, [productId]);
      held();
      await gate;
    });
    await lowHeld;
    let waiterDone = false;
    const waiter = h.sql
      .begin((tx) => lockStockLegs(ctxOf(tx), [{ warehouseId: high, productIds: [productId] }, { warehouseId: low, productIds: [productId] }]))
      .finally(() => (waiterDone = true));
    waiter.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [probe] = await h.sql.begin((tx) => tx<{ got: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${`inventory.stock:${h.companyId}:${high}:${productId}`}, 0)) as got`);
    const waited = !waiterDone;
    release();
    await holder;
    await waiter;
    expect(waited).toBe(true);
    expect(probe!.got).toBe(true);
  });

  it("the transit bodega is used only by traslados: movement.post, adjustment.post, transfer.create and count.create refuse it", async () => {
    const productId = await product(h, h.admin, "TR-10");
    const a = await warehouse(h, h.admin, "TA10");
    const b = await warehouse(h, h.admin, "TB10");
    await receipt(a.id, undefined, productId, 5);
    const t = await create({ fromWarehouseId: a.id, toWarehouseId: b.id, lines: [{ productId, qty: 1 }] });
    await ship(t.id);
    const [transit] = await h.sql<{ warehouse_id: string; id: string }[]>`select warehouse_id, id from inventory.locations where kind = 'transit' and company_id = ${h.companyId}`;
    const refused = { message: expect.stringMatching(/^transit_warehouse_refused:/) };
    await expect(h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId: transit!.warehouse_id, lines: [{ productId, locationId: transit!.id, qty: 1 }] })).rejects.toMatchObject(refused);
    await expect(h.runStepUp(h.admin, "inventory.adjustment.post", { date: today, warehouseId: transit!.warehouse_id, reason: "Intento", lines: [{ productId, locationId: transit!.id, qty: -1 }] })).rejects.toMatchObject(refused);
    await expect(create({ fromWarehouseId: transit!.warehouse_id, toWarehouseId: b.id, lines: [{ productId, qty: 1 }] })).rejects.toMatchObject(refused);
    await expect(create({ fromWarehouseId: a.id, toWarehouseId: transit!.warehouse_id, lines: [{ productId, qty: 1 }] })).rejects.toMatchObject(refused);
    await expect(h.run(h.admin, "inventory.count.create", { date: today, warehouseId: transit!.warehouse_id, lines: [{ productId, locationId: transit!.id }] })).rejects.toMatchObject(refused);
    // The traslado itself still completes.
    await receive(t.id);
    expect(await stockOf(h, productId, b.id)).toMatchObject({ onHand: 1 });
  });
});
