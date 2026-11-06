import { describe, expect, it } from "vitest";
import { choosePrice, lineDiscount } from "../price";
import { readinessReasons } from "../readiness";

// Price resolution (plan 2B Task 12): the customer's price list, then the company's default price list, then the product's list price.
// A list that does not carry the product (or whose price the caller cannot see) is skipped; the discount is the customer's standing one.

const CUSTOMER_LIST = "01960000-0000-7000-8000-000000000001";
const DEFAULT_LIST = "01960000-0000-7000-8000-000000000002";

describe("choosePrice", () => {
  it("the customer's price list beats the default list and the list price", () => {
    expect(choosePrice({ customer: { priceListId: CUSTOMER_LIST, price: 25000 }, fallback: { priceListId: DEFAULT_LIST, price: 27000 }, listPrice: 28500, discountPct: 0 })).toEqual({
      unitPrice: 25000,
      priceListId: CUSTOMER_LIST,
      discountPct: 0,
      source: "customer_list",
    });
  });

  it("the default list beats the list price when the customer has no list", () => {
    expect(choosePrice({ customer: null, fallback: { priceListId: DEFAULT_LIST, price: 27000 }, listPrice: 28500 })).toEqual({
      unitPrice: 27000,
      priceListId: DEFAULT_LIST,
      discountPct: 0,
      source: "default_list",
    });
  });

  it("skips a list without the product (or whose price is masked) and falls back to the list price", () => {
    expect(choosePrice({ customer: { priceListId: CUSTOMER_LIST, price: null }, fallback: { priceListId: DEFAULT_LIST, price: null }, listPrice: 28500, discountPct: 5 })).toEqual({
      unitPrice: 28500,
      discountPct: 5,
      source: "list_price",
    });
  });

  it("has no price when neither a list nor the product gives one", () => {
    expect(choosePrice({ customer: null, fallback: null, listPrice: null })).toBeNull();
  });

  it("takes a zero price from a list (a free item of the list is a price, not a gap)", () => {
    expect(choosePrice({ customer: { priceListId: CUSTOMER_LIST, price: 0 }, fallback: null, listPrice: 28500 })?.unitPrice).toBe(0);
  });
});

describe("lineDiscount", () => {
  it("is quantity × price × percent, rounded half up to the cent", () => {
    expect(lineDiscount(3, 28500, 10)).toBe(8550);
    expect(lineDiscount(1, 0.05, 50)).toBe(0.03);
    expect(lineDiscount(7, 1000, 0)).toBe(0);
  });
});

describe("readinessReasons", () => {
  const complete = { invoice_ready: false, is_active: true, dian_missing: [], missing_files: [] };
  it("says why a complete record is not usable: pending approval, not approved, draft", () => {
    expect(readinessReasons({ ...complete, usable: false, requires_approval: true, status: "pending" })).toEqual(["está pendiente de aprobación"]);
    expect(readinessReasons({ ...complete, usable: false, requires_approval: true, status: "saved" })).toEqual(["está pendiente de aprobación"]);
    expect(readinessReasons({ ...complete, usable: false, requires_approval: true, status: "rejected" })).toEqual(["no fue aprobado"]);
    expect(readinessReasons({ ...complete, usable: false, requires_approval: false, status: "draft" })).toEqual(["está en borrador, sin grabar"]);
  });
  it("an inactive record says so once; DIAN data and files follow the approval reason", () => {
    expect(readinessReasons({ ...complete, is_active: false, usable: false, status: "saved" })).toEqual(["está inactivo"]);
    expect(readinessReasons({ ...complete, dian_missing: ["Dirección"], missing_files: ["RUT"], usable: false, requires_approval: true, status: "pending" })).toEqual([
      "está pendiente de aprobación", "faltan datos DIAN: Dirección", "faltan archivos: RUT",
    ]);
  });
});
