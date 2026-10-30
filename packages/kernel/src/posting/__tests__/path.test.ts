import { describe, expect, it } from "vitest";
import { interpolate, resolvePath } from "../path";
import { invoicePayload as p } from "./fixtures";

describe("posting path resolver", () => {
  it("resolves dot paths, one wildcard and root access inside forEach", () => {
    expect(resolvePath(p, "$.totals.total")).toBe(119000);
    expect(resolvePath(p, "$.lines[*]")).toHaveLength(2);
    expect(resolvePath(p, "$.lines[*].categoryId")).toEqual(["bebidas", "comida"]);
    expect(resolvePath(p, "$$.number", p.lines[0])).toBe("FE-1");
    expect(resolvePath(p, "$.subtotal", p.lines[0])).toBe(50000);
    expect(() => resolvePath(p, "$.a[*].b[*]")).toThrow(/multiple_wildcards/);
  });
  it("passes literals through and returns undefined for missing values", () => {
    expect(resolvePath(p, "Ventas")).toBe("Ventas");
    expect(resolvePath(p, "$.nope.deeper")).toBeUndefined();
  });
  it("refuses malformed paths", () => {
    expect(() => resolvePath(p, "$..a")).toThrow(/invalid_path/);
    expect(() => resolvePath(p, "$.a[0]")).toThrow(/invalid_path/);
  });
  it("interpolates {{path}} and leaves missing values empty", () => {
    expect(interpolate("Factura {{number}} · {{customer.legalName}}", p)).toBe("Factura FE-1 · Tiendas D1 S.A.S.");
    expect(interpolate("x{{nope}}y", p)).toBe("xy");
    expect(interpolate("{{categoryId}}/{{$$.number}}", p, p.lines[1])).toBe("comida/FE-1");
  });
});
