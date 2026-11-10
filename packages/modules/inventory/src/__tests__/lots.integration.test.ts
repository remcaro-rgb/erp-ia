import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel";
import { inventoryHarness, newId, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// Lots, serials and the tracking parametro (plan 2B.2 Task 28.1, PG §3.1, items 145, 146; RG-2, RG-3). Migration 0162: inventory.lots and
// inventory.serials (maestros), inventory.product_tracking (parametro, one row per product), the FKs of the line and stock lot / serial
// columns, the serial check on stock_levels and the empty reservation_allocations. A lot belongs to one product (its code unique per
// product); a product's tracking cannot change while it has stock in any bucket (`tracking_has_stock`).

describe("inventory lots, serials and product tracking (Task 28.1)", () => {
  let h: InventoryHarness;
  const today = "2026-11-10";

  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const setTracking = (input: Record<string, unknown>) => h.runStepUp<{ id: string }>(h.admin, "inventory.product_tracking.set", input);
  const createLot = (input: Record<string, unknown>) => h.run<{ id: string }>(h.admin, "inventory.lot.create", input);
  const createSerial = (input: Record<string, unknown>) => h.run<{ id: string }>(h.admin, "inventory.serial.create", input);

  it("(1) 0162 tables: company RLS, row audit and seq; the FKs refuse an unknown lot or serial on a movement line and a stock row", async () => {
    const productId = await product(h, h.admin, "LOT-1");
    await setTracking({ productId, tracking: "lot", expiryRequired: true });
    const lot = await createLot({ productId, code: "L-2311", expiresOn: "2027-05-01", producedOn: "2026-11-01" });
    const otherProduct = await product(h, h.admin, "SER-1");
    await setTracking({ productId: otherProduct, tracking: "serial" });
    const serial = await createSerial({ productId: otherProduct, serialNo: "MOL-0001" });

    const lotRow = (await h.sql`select seq, lot_status, status, product_id, code, expires_on::text from inventory.lots where id = ${lot.id}`)[0]!;
    expect(lotRow).toMatchObject({ lot_status: "active", status: "saved", product_id: productId, code: "L-2311", expires_on: "2027-05-01" });
    expect(Number(lotRow.seq)).toBeGreaterThan(0);
    const serialRow = (await h.sql`select seq, serial_status, serial_no from inventory.serials where id = ${serial.id}`)[0]!;
    // A serial created by hand is not in stock: no status until a receipt makes it available (28.2); `available` only by process.
    expect(serialRow).toMatchObject({ serial_status: null, serial_no: "MOL-0001" });
    const trackingRow = (await h.sql`select seq, tracking, fefo, expiry_required, block_expired from inventory.product_tracking where product_id = ${productId}`)[0]!;
    expect(trackingRow).toMatchObject({ tracking: "lot", fefo: true, expiry_required: true, block_expired: true });
    expect(Number(trackingRow.seq)).toBeGreaterThan(0);

    // Row audit with the process that wrote each row.
    for (const [rowId, processId] of [[lot.id, "inventory.lot.create"], [serial.id, "inventory.serial.create"]] as const) {
      const audit = await h.sql`select process_id from kernel.audit_log where company_id = ${h.companyId} and row_id = ${rowId}`;
      expect(audit.map((a) => a.process_id)).toContain(processId);
    }
    // Company RLS: the other company reads none of them, in the tables or the masked views.
    for (const relation of ["inventory.lots", "inventory.serials", "inventory.product_tracking", "inventory.v_lots", "inventory.v_serials", "inventory.v_product_tracking", "inventory.reservation_allocations"]) {
      const own = await withClaims(h.sql, h.admin.claims, (tx) => tx`select count(*)::int as n from ${tx(relation)}`);
      const foreign = await withClaims(h.sql, h.other.claims, (tx) => tx`select count(*)::int as n from ${tx(relation)}`);
      expect(foreign[0]!.n).toBe(0);
      if (relation !== "inventory.reservation_allocations") expect(own[0]!.n).toBeGreaterThan(0);
    }
    // A user session cannot write them outside the processes: the restrictive policy leaves no row to update.
    const direct = await withClaims(h.sql, h.admin.claims, (tx) => tx`update inventory.lots set code = 'X' where id = ${lot.id} returning id`);
    expect(direct).toHaveLength(0);
    expect((await h.sql`select code from inventory.lots where id = ${lot.id}`)[0]!.code).toBe("L-2311");

    // The FKs: a draft movement's line naming an unknown lot or serial, and a stock row likewise, are refused by the database.
    const { id: warehouseId } = await warehouse(h, h.admin, "LW1");
    const [movement] = await h.sql<{ id: string }[]>`
      insert into inventory.movements (company_id, kind, date, warehouse_id, status, requires_approval, posts)
      values (${h.companyId}, 'receipt', ${today}, ${warehouseId}, 'draft', false, false) returning id`;
    const line = (lotId: string | null, serialId: string | null) => h.sql`
      insert into inventory.movement_lines (company_id, movement_id, line_no, product_id, lot_id, serial_id, qty, uom)
      values (${h.companyId}, ${movement!.id}, 1, ${productId}, ${lotId}, ${serialId}, 1, '94')`;
    await expect(line(newId(), null)).rejects.toMatchObject({ code: "23503" });
    await expect(line(null, newId())).rejects.toMatchObject({ code: "23503" });
    // A lot of another product is refused too: the FK names (lot, product).
    await expect(line(null, null).then(() => undefined)).resolves.toBeUndefined();
    await expect(h.sql`
      insert into inventory.movement_lines (company_id, movement_id, line_no, product_id, lot_id, qty, uom)
      values (${h.companyId}, ${movement!.id}, 2, ${otherProduct}, ${lot.id}, 1, '94')`).rejects.toMatchObject({ code: "23503" });
    await expect(h.sql`
      insert into inventory.stock_levels (company_id, product_id, warehouse_id, lot_id, on_hand)
      values (${h.companyId}, ${productId}, ${warehouseId}, ${newId()}, 1)`).rejects.toMatchObject({ code: "23503" });
    await expect(h.sql`
      insert into inventory.stock_levels (company_id, product_id, warehouse_id, serial_id, on_hand)
      values (${h.companyId}, ${productId}, ${warehouseId}, ${newId()}, 1)`).rejects.toMatchObject({ code: "23503" });

    // inventory.movements carries the party a shipped or returned movement answers to (the recall report, PG §3.6).
    const columns = await h.sql`select column_name from information_schema.columns where table_schema = 'inventory' and table_name = 'movements' and column_name = 'party_id'`;
    expect(columns).toHaveLength(1);
  });

  it("(2) a lot code is unique per product, whatever its case; the same code on two products is allowed", async () => {
    const a = await product(h, h.admin, "LOT-2A");
    const b = await product(h, h.admin, "LOT-2B");
    await setTracking({ productId: a, tracking: "lot" });
    await setTracking({ productId: b, tracking: "lot" });
    await createLot({ productId: a, code: "PROV-77" });
    await expect(createLot({ productId: a, code: "prov-77" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^lot_exists:/) });
    await expect(createLot({ productId: b, code: "PROV-77" })).resolves.toMatchObject({ id: expect.any(String) });
    // Serials likewise: unique per product.
    const s = await product(h, h.admin, "SER-2");
    await setTracking({ productId: s, tracking: "serial" });
    await createSerial({ productId: s, serialNo: "SN-1" });
    await expect(createSerial({ productId: s, serialNo: "SN-1" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^serial_exists:/) });
  });

  it("(3) the serial check refuses on_hand = 2 on a serial bucket (RG-3) and allows 0 and 1", async () => {
    const productId = await product(h, h.admin, "SER-3");
    await setTracking({ productId, tracking: "serial" });
    const serial = await createSerial({ productId, serialNo: "SN-3" });
    const { id: warehouseId } = await warehouse(h, h.admin, "LW3");
    await expect(h.sql`
      insert into inventory.stock_levels (company_id, product_id, warehouse_id, serial_id, on_hand)
      values (${h.companyId}, ${productId}, ${warehouseId}, ${serial.id}, 2)`).rejects.toMatchObject({ code: "23514" });
    const [row] = await h.sql<{ id: string }[]>`
      insert into inventory.stock_levels (company_id, product_id, warehouse_id, serial_id, on_hand)
      values (${h.companyId}, ${productId}, ${warehouseId}, ${serial.id}, 1) returning id`;
    await expect(h.sql`update inventory.stock_levels set on_hand = 2 where id = ${row!.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(h.sql`update inventory.stock_levels set on_hand = -1 where id = ${row!.id}`).rejects.toMatchObject({ code: "23514" });
    await h.sql`update inventory.stock_levels set on_hand = 0 where id = ${row!.id}`;
    await h.sql`delete from inventory.stock_levels where id = ${row!.id}`;
  });

  it("(4) product_tracking.set asks for the step-up; refuses tracking_has_stock while the product has stock; allowed once it is out", async () => {
    const productId = await product(h, h.admin, "TRK-4");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "LW4");
    await expect(h.run(h.admin, "inventory.product_tracking.set", { productId, tracking: "lot" })).rejects.toMatchObject({ code: "step_up_required" });
    expect(await h.sql`select 1 from inventory.product_tracking where product_id = ${productId}`).toHaveLength(0);

    await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 5 }] });
    await expect(setTracking({ productId, tracking: "lot" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^tracking_has_stock:/) });
    // Changing only the flags of the current tracking (none) is not a switch: allowed with stock.
    await expect(setTracking({ productId, tracking: "none", fefo: false })).resolves.toMatchObject({ id: expect.any(String) });

    await h.run(h.admin, "inventory.movement.post", { kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -5 }] });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 0 });
    await setTracking({ productId, tracking: "lot", expiryRequired: true, blockExpired: false });
    const [row] = await h.sql`select tracking, fefo, expiry_required, block_expired from inventory.v_product_tracking where product_id = ${productId}`;
    expect(row).toMatchObject({ tracking: "lot", fefo: false, expiry_required: true, block_expired: false });
    // The audit names the step-up process.
    const audit = await h.sql`select process_id from kernel.audit_log where company_id = ${h.companyId} and process_id = 'inventory.product_tracking.set'`;
    expect(audit.length).toBeGreaterThan(0);
  });

  it("(5) a lot on a product not tracked by lot is refused product_not_tracked_by_lot; a serial likewise product_not_tracked_by_serial", async () => {
    const untracked = await product(h, h.admin, "LOT-5");
    await expect(createLot({ productId: untracked, code: "L-1" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^product_not_tracked_by_lot:/) });
    await expect(createSerial({ productId: untracked, serialNo: "S-1" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^product_not_tracked_by_serial:/) });
    const serialTracked = await product(h, h.admin, "SER-5");
    await setTracking({ productId: serialTracked, tracking: "serial" });
    await expect(createLot({ productId: serialTracked, code: "L-1" })).rejects.toMatchObject({ message: expect.stringMatching(/^product_not_tracked_by_lot:/) });
    // A serial may sit inside a lot of the same product only.
    const lotTracked = await product(h, h.admin, "LOT-5B");
    await setTracking({ productId: lotTracked, tracking: "lot" });
    const lot = await createLot({ productId: lotTracked, code: "L-5" });
    await expect(createSerial({ productId: serialTracked, serialNo: "S-2", lotId: lot.id })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.sql`select 1 from inventory.lots where product_id = ${untracked}`).toHaveLength(0);
  });

  it("lot.update changes expiry, produced date, status and note; serial.update only the note; consult reads the masked view", async () => {
    const productId = await product(h, h.admin, "LOT-6");
    await setTracking({ productId, tracking: "lot", expiryRequired: true });
    await expect(createLot({ productId, code: "L-6" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^expiry_required:/) });
    const lot = await createLot({ productId, code: "L-6", expiresOn: "2027-01-31" });
    await h.run(h.admin, "inventory.lot.update", { id: lot.id, status: "blocked", expiresOn: "2027-02-28", note: "Retenido por calidad" });
    const consulted = await h.run<Record<string, unknown>>(h.admin, "inventory.lot.consult", { id: lot.id });
    expect(consulted).toMatchObject({ id: lot.id, code: "L-6", lot_status: "blocked", note: "Retenido por calidad" });
    expect((await h.sql`select expires_on::text from inventory.lots where id = ${lot.id}`)[0]!.expires_on).toBe("2027-02-28");

    const s = await product(h, h.admin, "SER-6");
    await setTracking({ productId: s, tracking: "serial" });
    const serial = await createSerial({ productId: s, serialNo: "SN-6" });
    await h.run(h.admin, "inventory.serial.update", { id: serial.id, note: "Caja abierta" });
    // The status is kept by the processes: update takes no status.
    await expect(h.run(h.admin, "inventory.serial.update", { id: serial.id, status: "available" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.run(h.admin, "inventory.serial.consult", { id: serial.id })).toMatchObject({ serial_no: "SN-6", note: "Caja abierta", serial_status: null });
  });
});
