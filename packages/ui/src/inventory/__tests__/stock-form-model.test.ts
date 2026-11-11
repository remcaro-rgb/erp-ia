import { describe, expect, it } from "vitest";
import {
  createProcess,
  emptyFoundRow,
  emptyLine,
  foundRowInput,
  foundRowMissing,
  masterStockCopy,
  masterStockDraft,
  masterStockInput,
  masterStockMissing,
  parseQty,
  serialList,
  splitFoundMessages,
  stockDraft,
  stockInput,
  stockMissing,
  type StockDraft,
} from "../stock-form-model";

const line = (over: Partial<ReturnType<typeof emptyLine>> = {}) => ({ ...emptyLine(), productId: "p1", productLabel: "CAF · Café", qty: "10", ...over });
const draft = (over: Partial<StockDraft> = {}): StockDraft => ({ ...stockDraft("2026-11-05"), warehouseId: "w1", ...over });

describe("stock form model", () => {
  it("reads quantities typed with a decimal comma or dot, and refuses text", () => {
    expect(parseQty("10")).toBe(10);
    expect(parseQty("1.234,5")).toBe(1234.5);
    expect(parseQty("2.5")).toBe(2.5);
    expect(parseQty("-3")).toBe(-3);
    expect(parseQty("abc")).toBeNaN();
    expect(parseQty("")).toBeNaN();
  });

  it("a new draft starts today with the only bodega and one empty line", () => {
    const d = stockDraft("2026-11-05", [{ code: "w1" }]);
    expect(d).toMatchObject({ kind: "receipt", date: "2026-11-05", warehouseId: "w1" });
    expect(d.lines).toHaveLength(1);
    expect(stockDraft("2026-11-05", [{ code: "a" }, { code: "b" }]).warehouseId).toBe("");
  });

  it("an entrada adds the quantity with its cost; a salida takes it; an ajuste keeps the sign and goes to adjustment.post with its reason", () => {
    expect(stockInput("movement", draft({ lines: [line({ unitCost: "7.000,50" })] }))).toEqual({
      date: "2026-11-05", kind: "receipt", warehouseId: "w1", lines: [{ productId: "p1", qty: 10, unitCost: 7000.5 }],
    });
    expect(stockInput("movement", draft({ kind: "issue", lines: [line({ unitCost: "9" })] }))).toEqual({ date: "2026-11-05", kind: "issue", warehouseId: "w1", lines: [{ productId: "p1", qty: -10 }] });
    const adjustment = draft({ kind: "adjustment", reason: "Merma", lines: [line({ qty: "-2" })] });
    expect(createProcess("movement", adjustment)).toBe("inventory.adjustment.post");
    expect(createProcess("movement", draft())).toBe("inventory.movement.post");
    expect(stockInput("movement", adjustment)).toEqual({ date: "2026-11-05", warehouseId: "w1", reason: "Merma", lines: [{ productId: "p1", qty: -2 }] });
  });

  it("a traslado names both bodegas and positive quantities; a conteo names only the products to count", () => {
    expect(stockInput("transfer", draft({ toWarehouseId: "w2", lines: [line({ qty: "4" }), emptyLine()] }))).toEqual({
      date: "2026-11-05", fromWarehouseId: "w1", toWarehouseId: "w2", lines: [{ productId: "p1", qty: 4 }],
    });
    expect(stockInput("count", draft({ lines: [line({ locationId: "l1" })] }))).toEqual({ date: "2026-11-05", warehouseId: "w1", lines: [{ productId: "p1", locationId: "l1" }] });
  });

  it("says what is missing: the bodega, a different destination, a reason of an ajuste, a line, a valid quantity", () => {
    expect(stockMissing("movement", draft({ warehouseId: "", lines: [emptyLine()] }))).toEqual(["warehouse", "lines"]);
    expect(stockMissing("transfer", draft({ toWarehouseId: "w1", lines: [line()] }))).toEqual(["to_warehouse"]);
    expect(stockMissing("movement", draft({ kind: "adjustment", lines: [line({ qty: "-1" })] }))).toEqual(["reason"]);
    expect(stockMissing("movement", draft({ lines: [line({ qty: "-1" })] }))).toEqual(["qty"]);
    expect(stockMissing("count", draft({ lines: [line({ qty: "" })] }))).toEqual([]);
  });

  it("a landed cost names its receipt, amount, basis, offset and the form submit's idempotency key; a payable needs the tercero", () => {
    const d = draft({ movementId: "m1", amount: "150000", basis: "quantity", offsetRole: "cash" });
    expect(stockMissing("landed_cost", d)).toEqual([]);
    expect(stockMissing("landed_cost", { ...d, offsetRole: "payable" })).toEqual(["party"]);
    expect(stockInput("landed_cost", d, "k-1")).toEqual({ movementId: "m1", amount: 150000, basis: "quantity", offsetRole: "cash", date: "2026-11-05", idempotencyKey: "k-1" });
    // Task 45: the cost center of the cost of sales part goes when chosen (optional: the ledger asks for it when units were already sold).
    expect(stockInput("landed_cost", { ...d, costCenterId: "cc1", costCenterLabel: "VTA · Ventas" }, "k-1")).toMatchObject({ costCenterId: "cc1" });
    expect(stockMissing("landed_cost", { ...d, costCenterId: "" })).toEqual([]);
  });

  it("a bodega and a ubicación: the ubicación's bodega goes on creation only", () => {
    const stored = masterStockDraft({ code: "A1", name: "Estante", warehouse_id: "w1", kind: "storage", is_active: true });
    expect(masterStockInput("location", stored, "id1")).toEqual({ id: "id1", code: "A1", name: "Estante", isActive: true, kind: "storage" });
    expect(masterStockInput("location", stored, null)).toEqual({ code: "A1", name: "Estante", isActive: true, warehouseId: "w1", kind: "storage" });
    expect(masterStockInput("warehouse", masterStockDraft({ code: "PRIN", name: "Principal" }), null)).toEqual({ code: "PRIN", name: "Principal", isActive: true, allowBackorders: false });
    expect(masterStockMissing("location", masterStockDraft({ code: "A1", name: "E" }), true)).toBe(true);
  });

  it("lots and serials (Task 28.2): a lot line sends its code and expiry, a serial line its numbers; untracked lines send neither", () => {
    const lot = line({ tracking: "lot", lotCode: " L-1 ", expiresOn: "2027-03-01" });
    const serial = line({ productId: "p2", tracking: "serial", qty: "2", serialNos: "M-1, M-2\n" });
    expect(stockInput("movement", draft({ lines: [lot, serial, line({ productId: "p3" })] }))).toEqual({
      date: "2026-11-05", kind: "receipt", warehouseId: "w1",
      lines: [
        { productId: "p1", qty: 10, lot: { code: "L-1", expiresOn: "2027-03-01" } },
        { productId: "p2", qty: 2, serials: [{ serialNo: "M-1" }, { serialNo: "M-2" }] },
        { productId: "p3", qty: 10 },
      ],
    });
    // A salida and a traslado name an existing lot by its code (no expiry), the serials by number.
    expect(stockInput("movement", draft({ kind: "issue", lines: [lot] }))).toMatchObject({ lines: [{ productId: "p1", qty: -10, lot: { code: "L-1" } }] });
    expect(stockInput("transfer", draft({ toWarehouseId: "w2", lines: [lot, serial] }))).toMatchObject({
      lines: [{ productId: "p1", qty: 10, lot: { code: "L-1" } }, { productId: "p2", qty: 2, serials: [{ serialNo: "M-1" }, { serialNo: "M-2" }] }],
    });
    // A conteo lists its buckets itself: no lot or serial in its input.
    expect(stockInput("count", draft({ lines: [lot] }))).toEqual({ date: "2026-11-05", warehouseId: "w1", lines: [{ productId: "p1" }] });
  });

  it("a lot line without its code, or a serial line whose numbers do not match the quantity, is missing them", () => {
    expect(serialList(" a ,b\n\nc ")).toEqual(["a", "b", "c"]);
    expect(stockMissing("movement", draft({ lines: [line({ tracking: "lot" })] }))).toContain("lot");
    expect(stockMissing("movement", draft({ lines: [line({ tracking: "serial", qty: "3", serialNos: "a,b" })] }))).toContain("serials");
    expect(stockMissing("movement", draft({ lines: [line({ tracking: "serial", qty: "2", serialNos: "a,b" })] }))).toEqual([]);
    expect(stockMissing("count", draft({ lines: [line({ tracking: "lot" })] }))).toEqual([]);
  });

  it("a lot (Task 28.5): product and code go on creation only; an update sends only its dates, status and note; a duplicate clears the code", () => {
    const stored = masterStockDraft({ product_id: "p1", code: "L-1", expires_on: "2027-03-01", produced_on: new Date("2026-11-01T00:00:00Z"), lot_status: "active", note: "Tostión 1" }, { product_id: "CAF · Café" });
    expect(stored).toMatchObject({ productId: "p1", productLabel: "CAF · Café", code: "L-1", expiresOn: "2027-03-01", producedOn: "2026-11-01", lotStatus: "active", note: "Tostión 1" });
    expect(masterStockInput("lot", { ...stored, lotStatus: "blocked" }, "lot1")).toEqual({ id: "lot1", expiresOn: "2027-03-01", producedOn: "2026-11-01", status: "blocked", note: "Tostión 1" });
    // A cleared date or note goes as null (the update clears it); the product and the code never travel on an update.
    expect(masterStockInput("lot", { ...stored, producedOn: "", note: " " }, "lot1")).toEqual({ id: "lot1", expiresOn: "2027-03-01", producedOn: null, status: "active", note: null });
    expect(masterStockInput("lot", { ...stored, code: " L-2 " }, null)).toEqual({ productId: "p1", code: "L-2", expiresOn: "2027-03-01", producedOn: "2026-11-01", note: "Tostión 1" });
    expect(createProcess("lot", null)).toBe("inventory.lot.create");
    const copy = masterStockCopy({ product_id: "p1", code: "L-1", expires_on: "2027-03-01", lot_status: "blocked", note: "Tostión 1" }, { product_id: "CAF · Café" });
    expect(copy).toMatchObject({ productId: "p1", productLabel: "CAF · Café", code: "", expiresOn: "2027-03-01", lotStatus: "active", note: "Tostión 1" });
    expect(masterStockMissing("lot", copy, true)).toEqual(["code"]);
    expect(masterStockMissing("lot", masterStockDraft(null), true)).toEqual(["product", "code"]);
    expect(masterStockMissing("lot", stored, false)).toEqual([]);
  });

  it("a serial (Task 28.5): never sends its status (the movements keep it); an update sends only the note; a duplicate clears the number", () => {
    const stored = masterStockDraft({ product_id: "p2", serial_no: "MOL-1", lot_id: null, serial_status: "available", note: "" }, { product_id: "ACC · Molino" });
    expect(stored).toMatchObject({ productId: "p2", serialNo: "MOL-1", serialStatus: "available" });
    expect(masterStockInput("serial", { ...stored, note: "Revisado" }, "s1")).toEqual({ id: "s1", note: "Revisado" });
    expect(masterStockInput("serial", { ...stored, serialNo: " MOL-9 ", lotId: "lot1" }, null)).toEqual({ productId: "p2", serialNo: "MOL-9", lotId: "lot1" });
    expect(JSON.stringify(masterStockInput("serial", stored, null))).not.toContain("tatus");
    expect(createProcess("serial", null)).toBe("inventory.serial.create");
    const copy = masterStockCopy({ product_id: "p2", serial_no: "MOL-1", serial_status: "issued", note: "Revisado" }, {});
    expect(copy).toMatchObject({ productId: "p2", serialNo: "", serialStatus: "", note: "Revisado" });
    expect(masterStockMissing("serial", copy, true)).toEqual(["serial_no"]);
  });

  it("a product's tracking (Task 28.5): sends the product and its four settings to product_tracking.set; without a product it is missing", () => {
    const fresh = masterStockDraft(null);
    expect(fresh).toMatchObject({ tracking: "none", fefo: true, expiryRequired: false, blockExpired: true });
    expect(masterStockMissing("tracking", fresh, true)).toEqual(["product"]);
    const chosen = { ...fresh, productId: "p1", tracking: "lot", expiryRequired: true };
    expect(masterStockMissing("tracking", chosen, true)).toEqual([]);
    expect(masterStockInput("tracking", chosen, null)).toEqual({ productId: "p1", tracking: "lot", fefo: true, expiryRequired: true, blockExpired: true });
    // A stored row is keyed by its product: the process takes no id.
    const stored = masterStockDraft({ id: "t1", product_id: "p1", tracking: "serial", fefo: false, expiry_required: false, block_expired: false });
    expect(masterStockInput("tracking", stored, "t1")).toEqual({ productId: "p1", tracking: "serial", fefo: false, expiryRequired: false, blockExpired: false });
    expect(createProcess("tracking", null)).toBe("inventory.product_tracking.set");
  });

  it("a found row of a count (Task 28.5): a new lot code with its expiry, an existing lot by id, a serial counted 1; an untracked row names neither", () => {
    const row = (over: Partial<ReturnType<typeof emptyFoundRow>>) => ({ ...emptyFoundRow(), productId: "p1", countedQty: "5", ...over });
    expect(foundRowInput(row({ tracking: "lot", lotCode: " L-NEW ", expiresOn: "2027-01-31", locationId: "loc1" }))).toEqual({ productId: "p1", locationId: "loc1", lot: { code: "L-NEW", expiresOn: "2027-01-31" }, countedQty: 5 });
    expect(foundRowInput(row({ tracking: "lot", lotId: "lot1", lotCode: "ignored" }))).toEqual({ productId: "p1", lotId: "lot1", countedQty: 5 });
    expect(foundRowInput(row({ productId: "p2", tracking: "serial", serialNo: " MOL-7 ", countedQty: "3" }))).toEqual({ productId: "p2", serialNo: "MOL-7", countedQty: 1 });
    expect(foundRowInput(row({ productId: "p3", tracking: "none", lotCode: "x", serialNo: "y" }))).toEqual({ productId: "p3", countedQty: 5 });
    // What a row still misses: the product, its lot or serial, a quantity of zero or more; an untracked product is not found (the count lists it).
    expect(foundRowMissing(emptyFoundRow())).toEqual(["product"]);
    expect(foundRowMissing(row({ tracking: "lot" }))).toEqual(["lot"]);
    expect(foundRowMissing(row({ tracking: "serial", countedQty: "" }))).toEqual(["serial"]);
    expect(foundRowMissing(row({ tracking: "lot", lotCode: "L", countedQty: "-1" }))).toEqual(["qty"]);
    expect(foundRowMissing(row({ tracking: "none" }))).toEqual(["tracked"]);
  });

  it("the refusals of Registrar conteo go to the found row they name (Encontrado N / Línea N); the rest stay on the sheet", () => {
    const split = splitFoundMessages(["Encontrado 2: la ubicación no es de la bodega del conteo", "Línea 1: ACC-MOL-ELE: el serial MOL-1 ya está en existencia", "El lote L-9 necesita fecha de vencimiento", "Otra cosa"], [
      { ...emptyFoundRow(), lotCode: "" },
      { ...emptyFoundRow(), lotCode: "L-9" },
    ]);
    expect(split.rows).toEqual({ 0: ["ACC-MOL-ELE: el serial MOL-1 ya está en existencia"], 1: ["la ubicación no es de la bodega del conteo", "El lote L-9 necesita fecha de vencimiento"] });
    expect(split.rest).toEqual(["Otra cosa"]);
  });
});
