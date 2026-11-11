import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inventoryHarness, newId, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// Inbound and internal movements by lot and serial (plan 2B.2 Task 28.2, PG §3.2; RG-2, RG-3, Review Focus 1). A receipt of a lot-tracked
// product names its lot (an existing one or a new code, created nested through inventory.lot.create in the same chain); a serial-tracked
// line lists one serial per unit, each its own bucket at 1. Issues, transfers, adjustments and counts move the same buckets: stock is
// keyed by product, ubicación, lot and serial, and a serial is never on hand twice.

type Posted = { id: string | null; number: string | null; status: string };
type CountCreated = { id: string; lines: { id: string; productId: string; lotId: string | null; serialId: string | null }[] };

describe("inventory movements by lot and serial (Task 28.2)", () => {
  let h: InventoryHarness;
  const today = "2026-11-10";
  let w: { id: string; locationId: string };
  let lotProduct: string;
  let serialProduct: string;

  beforeAll(async () => {
    h = await inventoryHarness();
    w = await warehouse(h, h.admin, "LTW");
    lotProduct = await product(h, h.admin, "LT-CAFE");
    serialProduct = await product(h, h.admin, "SR-MOLINO");
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId: lotProduct, tracking: "lot", expiryRequired: true });
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId: serialProduct, tracking: "serial" });
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const post = (kind: string, lines: Record<string, unknown>[], warehouseId = w.id) =>
    h.run<Posted>(h.admin, "inventory.movement.post", { kind, date: today, warehouseId, lines: lines.map((l) => ({ locationId: w.locationId, ...l })) });
  const lotId = async (code: string) => (await h.sql<{ id: string }[]>`select id from inventory.lots where product_id = ${lotProduct} and code = ${code}`)[0]?.id;
  const serialRow = async (no: string) => (await h.sql<{ id: string; serial_status: string | null }[]>`select id, serial_status from inventory.serials where product_id = ${serialProduct} and serial_no = ${no}`)[0];
  const bucket = async (where: { lotId?: string | null; serialId?: string | null; locationId?: string | null; warehouseId?: string }) => {
    const rows = await h.sql<{ on_hand: string }[]>`
      select on_hand::text from inventory.stock_levels where company_id = ${h.companyId} and warehouse_id = ${where.warehouseId ?? w.id}
        and location_id is not distinct from ${where.locationId === undefined ? w.locationId : where.locationId}::uuid
        and lot_id is not distinct from ${where.lotId ?? null}::uuid and serial_id is not distinct from ${where.serialId ?? null}::uuid`;
    return rows.length === 0 ? 0 : Number(rows[0]!.on_hand);
  };
  const refusal = (code: string) => ({ code: "invalid_input", message: expect.stringMatching(new RegExp(`^${code}:`)) });

  it("(1) a receipt with a new lot code creates the lot nested, in the same chain, and a bucket per lot; missing lot or expiry is refused", async () => {
    const posted = await post("receipt", [
      { productId: lotProduct, qty: 10, lot: { code: "L-A", expiresOn: "2027-03-01", producedOn: "2026-10-01" } },
      { productId: lotProduct, qty: 4, lot: { code: "L-B", expiresOn: "2027-06-01" } },
    ]);
    expect(posted.status).toBe("saved");
    const a = await lotId("L-A");
    const b = await lotId("L-B");
    expect(a && b).toBeTruthy();
    expect(await bucket({ lotId: a })).toBe(10);
    expect(await bucket({ lotId: b })).toBe(4);
    // The bodega's untracked bucket of the product is not touched.
    expect(await bucket({})).toBe(0);
    // The nested create ran as its own process in the movement's chain.
    const [lotAudit] = await h.sql<{ chain_id: string; process_id: string }[]>`select chain_id, process_id from kernel.audit_log where row_id = ${a!} and action = 'insert'`;
    const [movementAudit] = await h.sql<{ chain_id: string }[]>`select chain_id from kernel.audit_log where row_id = ${posted.id!} and action = 'insert'`;
    expect(lotAudit).toMatchObject({ process_id: "inventory.lot.create", chain_id: movementAudit!.chain_id });
    // The movement lines name the lots; the event carries lotId.
    const lines = await h.sql<{ lot_id: string | null; qty: string }[]>`select lot_id, qty from inventory.movement_lines where movement_id = ${posted.id!} order by line_no`;
    expect(lines.map((l) => [l.lot_id, Number(l.qty)])).toEqual([[a, 10], [b, 4]]);
    const [event] = await h.sql<{ payload: { lines: { lotId?: string; serialId?: string }[] } }[]>`
      select payload from kernel.outbox where event = 'inventory.movement.posted' and payload->>'movementId' = ${posted.id!}`;
    expect(event!.payload.lines.map((l) => l.lotId)).toEqual([a, b]);

    // A second receipt of an existing lot (by id, or by its code) adds to its bucket.
    await post("receipt", [{ productId: lotProduct, qty: 2, lotId: a }]);
    await post("receipt", [{ productId: lotProduct, qty: 1, lot: { code: "l-a", expiresOn: "2027-03-01" } }]);
    expect(await bucket({ lotId: a })).toBe(13);
    expect(await h.sql`select 1 from inventory.lots where product_id = ${lotProduct} and lower(code) = 'l-a'`).toHaveLength(1);

    await expect(post("receipt", [{ productId: lotProduct, qty: 1 }])).rejects.toMatchObject(refusal("lot_required"));
    await expect(post("receipt", [{ productId: lotProduct, qty: 1, lot: { code: "L-NOEXP" } }])).rejects.toMatchObject(refusal("expiry_required"));
    expect(await lotId("L-NOEXP")).toBeUndefined();
    // An untracked product refuses a lot or serials.
    const plain = await product(h, h.admin, "LT-PLAIN");
    await expect(post("receipt", [{ productId: plain, qty: 1, lotId: a }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(post("receipt", [{ productId: plain, qty: 1, serials: [{ serialNo: "X" }] }])).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("(2) a receipt of 3 serials creates 3 buckets at 1, each serial available; a count mismatch and an available serial again are refused", async () => {
    const posted = await post("receipt", [{ productId: serialProduct, qty: 3, serials: [{ serialNo: "M-1" }, { serialNo: "M-2" }, { serialNo: "M-3" }] }]);
    const lines = await h.sql<{ serial_id: string; qty: string }[]>`select serial_id, qty from inventory.movement_lines where movement_id = ${posted.id!} order by line_no`;
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => Number(l.qty) === 1)).toBe(true);
    for (const no of ["M-1", "M-2", "M-3"]) {
      const s = await serialRow(no);
      expect(s?.serial_status).toBe("available");
      expect(await bucket({ serialId: s!.id })).toBe(1);
    }
    expect((await stockOf(h, serialProduct, w.id)).onHand).toBe(3);

    await expect(post("receipt", [{ productId: serialProduct, qty: 3, serials: [{ serialNo: "M-4" }, { serialNo: "M-5" }] }])).rejects.toMatchObject(refusal("serials_count_mismatch"));
    await expect(post("receipt", [{ productId: serialProduct, qty: 1 }])).rejects.toMatchObject(refusal("serials_required"));
    await expect(post("receipt", [{ productId: serialProduct, qty: 1, serials: [{ serialNo: "m-2" }] }])).rejects.toMatchObject(refusal("serial_exists"));
    expect(await serialRow("M-4")).toBeUndefined();
  });

  it("(3) an issue of a serial not on hand is refused serial_not_in_stock; the second issue of the same serial too", async () => {
    const m1 = (await serialRow("M-1"))!;
    await expect(post("issue", [{ productId: serialProduct, qty: -1, serials: [{ serialNo: "NOPE" }] }])).rejects.toMatchObject(refusal("serial_not_in_stock"));
    await post("issue", [{ productId: serialProduct, qty: -1, serialIds: [m1.id] }]);
    expect((await serialRow("M-1"))!.serial_status).toBe("issued");
    expect(await bucket({ serialId: m1.id })).toBe(0);
    await expect(post("issue", [{ productId: serialProduct, qty: -1, serialIds: [m1.id] }])).rejects.toMatchObject(refusal("serial_not_in_stock"));
    // An issue of a lot names it; more than the lot holds is lot_short (whatever the bodega's backorders).
    await expect(post("issue", [{ productId: lotProduct, qty: -1 }])).rejects.toMatchObject(refusal("lot_required"));
    await expect(post("issue", [{ productId: lotProduct, qty: -5, lotId: await lotId("L-B") }])).rejects.toMatchObject(refusal("lot_short"));
    await post("issue", [{ productId: lotProduct, qty: -1, lotId: await lotId("L-B") }]);
    expect(await bucket({ lotId: await lotId("L-B") })).toBe(3);
    // A serial issued comes back by a receipt (a return): available again in its bucket.
    await post("receipt", [{ productId: serialProduct, qty: 1, serials: [{ serialNo: "M-1" }] }]);
    expect((await serialRow("M-1"))!.serial_status).toBe("available");
    expect(await bucket({ serialId: m1.id })).toBe(1);
  });

  it("(4) a transfer of lot L-A and of a serial moves the same buckets through transit, in two legs", async () => {
    const dest = await warehouse(h, h.admin, "LTD");
    const a = (await lotId("L-A"))!;
    const m2 = (await serialRow("M-2"))!;
    const created = await h.run<{ id: string; lines: { id: string }[] }>(h.admin, "inventory.transfer.create", {
      date: today, fromWarehouseId: w.id, toWarehouseId: dest.id,
      lines: [
        { productId: lotProduct, fromLocationId: w.locationId, toLocationId: dest.locationId, qty: 3, lotId: a },
        { productId: serialProduct, fromLocationId: w.locationId, toLocationId: dest.locationId, qty: 1, serials: [{ serialNo: "M-2" }] },
      ],
    });
    const tl = await h.sql<{ lot_id: string | null; serial_id: string | null }[]>`select lot_id, serial_id from inventory.transfer_lines where transfer_id = ${created.id} order by line_no`;
    expect(tl).toEqual([{ lot_id: a, serial_id: null }, { lot_id: null, serial_id: m2.id }]);
    await h.run(h.admin, "inventory.transfer.ship", { id: created.id });
    const [transit] = await h.sql<{ id: string; warehouse_id: string }[]>`select id, warehouse_id from inventory.locations where kind = 'transit' and company_id = ${h.companyId}`;
    expect(await bucket({ lotId: a })).toBe(10);
    expect(await bucket({ lotId: a, warehouseId: transit!.warehouse_id, locationId: transit!.id })).toBe(3);
    expect(await bucket({ serialId: m2.id, warehouseId: transit!.warehouse_id, locationId: transit!.id })).toBe(1);
    expect((await serialRow("M-2"))!.serial_status).toBe("available");
    await h.run(h.admin, "inventory.transfer.receive", { id: created.id });
    expect(await bucket({ lotId: a, warehouseId: transit!.warehouse_id, locationId: transit!.id })).toBe(0);
    expect(await bucket({ lotId: a, warehouseId: dest.id, locationId: dest.locationId })).toBe(3);
    expect(await bucket({ serialId: m2.id, warehouseId: dest.id, locationId: dest.locationId })).toBe(1);
    expect((await serialRow("M-2"))!.serial_status).toBe("available");
    // A tracked transfer line names its lot or serials when it is created.
    await expect(h.run(h.admin, "inventory.transfer.create", { date: today, fromWarehouseId: w.id, toWarehouseId: dest.id, lines: [{ productId: lotProduct, qty: 1 }] }))
      .rejects.toMatchObject(refusal("lot_required"));
    await expect(h.run(h.admin, "inventory.transfer.create", { date: today, fromWarehouseId: w.id, toWarehouseId: dest.id, lines: [{ productId: serialProduct, qty: 2, serials: [{ serialNo: "M-3" }] }] }))
      .rejects.toMatchObject(refusal("serials_count_mismatch"));
  });

  it("(5) an adjustment (step-up unchanged) of a lot, and a serial written off is scrapped; a positive adjustment creates a serial", async () => {
    const b = (await lotId("L-B"))!;
    await expect(h.run(h.admin, "inventory.adjustment.post", { date: today, warehouseId: w.id, reason: "Merma", lines: [{ productId: lotProduct, locationId: w.locationId, qty: -1, lotId: b }] }))
      .rejects.toMatchObject({ code: "step_up_required" });
    await h.runStepUp(h.admin, "inventory.adjustment.post", { date: today, warehouseId: w.id, reason: "Merma", lines: [{ productId: lotProduct, locationId: w.locationId, qty: -1, lotId: b }] });
    expect(await bucket({ lotId: b })).toBe(2);
    const m3 = (await serialRow("M-3"))!;
    await h.runStepUp(h.admin, "inventory.adjustment.post", { date: today, warehouseId: w.id, reason: "Dañado", lines: [{ productId: serialProduct, locationId: w.locationId, qty: -1, serialIds: [m3.id] }] });
    expect((await serialRow("M-3"))!.serial_status).toBe("scrapped");
    expect(await bucket({ serialId: m3.id })).toBe(0);
    await h.runStepUp(h.admin, "inventory.adjustment.post", { date: today, warehouseId: w.id, reason: "Sobrante", lines: [{ productId: serialProduct, locationId: w.locationId, qty: 1, serials: [{ serialNo: "M-9" }] }] });
    const m9 = (await serialRow("M-9"))!;
    expect(m9.serial_status).toBe("available");
    expect(await bucket({ serialId: m9.id })).toBe(1);
  });

  it("(6) a count lists each lot and serial on hand; lot short by 2 and a new lot found with 5 give two lines, a missing serial one −1 line", async () => {
    const cw = await warehouse(h, h.admin, "LTC");
    const at = (l: Record<string, unknown>) => ({ locationId: cw.locationId, ...l });
    await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId: cw.id, lines: [
      at({ productId: lotProduct, qty: 10, lot: { code: "L-C", expiresOn: "2027-08-01" } }),
      at({ productId: serialProduct, qty: 2, serials: [{ serialNo: "C-1" }, { serialNo: "C-2" }] }),
    ] });
    const c = (await lotId("L-C"))!;
    const c1 = (await serialRow("C-1"))!;
    const c2 = (await serialRow("C-2"))!;
    const count = await h.run<CountCreated>(h.admin, "inventory.count.create", { date: today, warehouseId: cw.id, lines: [at({ productId: lotProduct }), at({ productId: serialProduct })] });
    expect(count.lines.map((l) => [l.productId, l.lotId, l.serialId]).sort()).toEqual([[lotProduct, c, null], [serialProduct, null, c1.id], [serialProduct, null, c2.id]].sort());
    const lineOf = (key: { lotId?: string; serialId?: string }) => count.lines.find((l) => (key.lotId ? l.lotId === key.lotId : l.serialId === key.serialId))!.id;
    await h.run(h.admin, "inventory.count.record", {
      id: count.id,
      lines: [{ lineId: lineOf({ lotId: c }), countedQty: 8 }, { lineId: lineOf({ serialId: c1.id }), countedQty: 1 }, { lineId: lineOf({ serialId: c2.id }), countedQty: 0 }],
      found: [{ productId: lotProduct, locationId: cw.locationId, lot: { code: "L-M", expiresOn: "2027-09-01" }, countedQty: 5 }],
    });
    const applied = await h.runStepUp<{ adjustmentId: string }>(h.admin, "inventory.count.apply", { id: count.id });
    const m = (await lotId("L-M"))!;
    const adj = await h.sql<{ lot_id: string | null; serial_id: string | null; qty: string }[]>`select lot_id, serial_id, qty from inventory.movement_lines where movement_id = ${applied.adjustmentId} order by line_no`;
    expect(adj.map((l) => [l.lot_id, l.serial_id, Number(l.qty)]).sort()).toEqual([[c, null, -2], [m, null, 5], [null, c2.id, -1]].sort());
    expect(await bucket({ lotId: c, warehouseId: cw.id, locationId: cw.locationId })).toBe(8);
    expect(await bucket({ lotId: m, warehouseId: cw.id, locationId: cw.locationId })).toBe(5);
    expect(await bucket({ serialId: c2.id, warehouseId: cw.id, locationId: cw.locationId })).toBe(0);
    expect((await serialRow("C-2"))!.serial_status).toBe("scrapped");
    expect((await serialRow("C-1"))!.serial_status).toBe("available");
  });

  /** Holds a transaction advisory lock on its own connection until the answer is called (and its transaction ends). */
  const holdLock = async (key: string, shared = false): Promise<() => Promise<void>> => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const done = h.sql.begin(async (tx) => {
      if (shared) await tx`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
      else await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      locked();
      await released;
    });
    await isLocked;
    return async () => {
      release();
      await done;
    };
  };
  /** Whether `p` settles (either way) within `ms`. */
  const settles = (p: Promise<unknown>, ms = 500) =>
    Promise.race([p.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  it("(R1) voiding an issue whose serial was received again in another bodega is refused serial_exists: a serial is never on hand twice", async () => {
    const other = await warehouse(h, h.admin, "LTV");
    await post("receipt", [{ productId: serialProduct, qty: 1, serials: [{ serialNo: "V-1" }] }]);
    const v1 = (await serialRow("V-1"))!;
    const issue = await post("issue", [{ productId: serialProduct, qty: -1, serialIds: [v1.id] }]);
    // The serial comes back through another bodega (a return received there).
    await post("receipt", [{ productId: serialProduct, qty: 1, locationId: other.locationId, serialIds: [v1.id] }], other.id);
    await expect(h.run(h.admin, "inventory.movement.void", { id: issue.id, reason: "Error" })).rejects.toMatchObject(refusal("serial_exists"));
    expect(await bucket({ serialId: v1.id })).toBe(0);
    expect(await bucket({ serialId: v1.id, warehouseId: other.id, locationId: other.locationId })).toBe(1);
    expect((await serialRow("V-1"))!.serial_status).toBe("available");
  });

  it("(R2) a product's tracking change and its movements queue on one product lock (inventory.tracking)", async () => {
    const p = await product(h, h.admin, "LT-RACE");
    const key = `inventory.tracking:${h.companyId}:${p}`;
    // A movement waits for a tracking change in progress before it reads the tracking.
    let release = await holdLock(key);
    const receipt = post("receipt", [{ productId: p, qty: 2 }]);
    let waited: boolean;
    try {
      waited = !(await settles(receipt));
    } finally {
      await release();
    }
    expect(waited).toBe(true);
    await receipt;
    // A tracking change waits for a movement in progress before it checks the stock, then sees it.
    release = await holdLock(key, true);
    const set = h.runStepUp(h.admin, "inventory.product_tracking.set", { productId: p, tracking: "lot" });
    try {
      waited = !(await settles(set));
    } finally {
      await release();
    }
    expect(waited).toBe(true);
    await expect(set).rejects.toMatchObject(refusal("tracking_has_stock"));
  });

  it("(R5) two receipts of the same new lot code at once, in two bodegas, both post into one lot", async () => {
    const second = await warehouse(h, h.admin, "LTR");
    const results = await Promise.allSettled([
      post("receipt", [{ productId: lotProduct, qty: 2, lot: { code: "L-RACE", expiresOn: "2027-05-01" } }]),
      post("receipt", [{ productId: lotProduct, qty: 3, locationId: second.locationId, lot: { code: "l-race", expiresOn: "2027-05-01" } }], second.id),
    ]);
    expect(results.map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : r.status))).toEqual(["fulfilled", "fulfilled"]);
    const lots = await h.sql<{ id: string }[]>`select id from inventory.lots where product_id = ${lotProduct} and lower(code) = 'l-race'`;
    expect(lots).toHaveLength(1);
    expect(await bucket({ lotId: lots[0]!.id })).toBe(2);
    expect(await bucket({ lotId: lots[0]!.id, warehouseId: second.id, locationId: second.locationId })).toBe(3);
  });

  it("(R6) one source line naming the same lot twice (by id and by code) is refused invalid_movement, before the database's key", async () => {
    const a = (await lotId("L-A"))!;
    const sourceLineId = newId();
    await expect(h.run(h.admin, "inventory.movement.post", {
      kind: "receipt", date: today, warehouseId: w.id, sourceEntity: "purchasing.receipt", sourceId: newId(),
      lines: [
        { productId: lotProduct, locationId: w.locationId, qty: 1, sourceLineId, lotId: a },
        { productId: lotProduct, locationId: w.locationId, qty: 1, sourceLineId, lot: { code: "l-a" } },
      ],
    })).rejects.toMatchObject({ ...refusal("invalid_movement"), message: expect.stringContaining("aparece dos veces") });
  });

  it("(7) Review Focus 1: every bucket's on_hand equals the sum of its movement lines, and no serial is on hand twice", async () => {
    const drift = await h.sql`
      select s.id, s.on_hand, s.lot_id, s.serial_id from inventory.stock_levels s
      where s.company_id = ${h.companyId} and s.on_hand <> coalesce((
        select sum(l.qty) from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
        where m.status <> 'voided' and m.warehouse_id = s.warehouse_id and l.product_id = s.product_id
          and l.location_id is not distinct from s.location_id and l.lot_id is not distinct from s.lot_id and l.serial_id is not distinct from s.serial_id), 0)`;
    expect(drift).toEqual([]);
    const twice = await h.sql`select serial_id from inventory.stock_levels where company_id = ${h.companyId} and serial_id is not null group by serial_id having sum(on_hand) > 1`;
    expect(twice).toEqual([]);
    // A serial is available exactly when it is on hand somewhere.
    const mismatched = await h.sql`
      select s.serial_no from inventory.serials s
      where s.company_id = ${h.companyId}
        and (s.serial_status = 'available') <> (coalesce((select sum(on_hand) from inventory.stock_levels b where b.serial_id = s.id), 0) = 1)`;
    expect(mismatched).toEqual([]);
  });
});
