import { describe, expect, it } from "vitest";
import { createProcess, emptyLine, masterStockDraft, masterStockInput, masterStockMissing, parseQty, stockDraft, stockInput, stockMissing, type StockDraft } from "../stock-form-model";

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
  });

  it("a bodega and a ubicación: the ubicación's bodega goes on creation only", () => {
    const stored = masterStockDraft({ code: "A1", name: "Estante", warehouse_id: "w1", kind: "storage", is_active: true });
    expect(masterStockInput("location", stored, "id1")).toEqual({ id: "id1", code: "A1", name: "Estante", isActive: true, kind: "storage" });
    expect(masterStockInput("location", stored, null)).toEqual({ code: "A1", name: "Estante", isActive: true, warehouseId: "w1", kind: "storage" });
    expect(masterStockInput("warehouse", masterStockDraft({ code: "PRIN", name: "Principal" }), null)).toEqual({ code: "PRIN", name: "Principal", isActive: true, allowBackorders: false });
    expect(masterStockMissing("location", masterStockDraft({ code: "A1", name: "E" }), true)).toBe(true);
  });
});
