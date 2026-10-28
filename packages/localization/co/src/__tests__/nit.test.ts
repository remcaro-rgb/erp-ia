import { describe, expect, it } from "vitest";
import { co } from "../index";
import { nitCheckDigit } from "../nit";

describe("DIAN NIT check digit", () => {
  it("matches known NIT-DV pairs", () => {
    expect(nitCheckDigit("900373115")).toBe(3); // demo company Café del Norte
    expect(nitCheckDigit("800197268")).toBe(4); // DIAN's own NIT
  });

  it("returns 0 or 1 when the remainder is 0 or 1", () => {
    const results = new Set<number>();
    for (let n = 100000; n < 100400; n++) results.add(nitCheckDigit(String(n)));
    expect(results.has(0)).toBe(true);
    expect(results.has(1)).toBe(true);
    expect([...results].every((d) => d >= 0 && d <= 9)).toBe(true);
  });

  it("refuses anything that is not 1 to 15 digits", () => {
    expect(() => nitCheckDigit("90037311A")).toThrow();
    expect(() => nitCheckDigit("")).toThrow();
    expect(() => nitCheckDigit("1".repeat(16))).toThrow();
  });
});

describe("co.validateTaxId", () => {
  it("normalizes a NIT with a correct DV to the number without DV", () => {
    expect(co.validateTaxId("900373115-3", "31")).toEqual({ ok: true, normalized: "900373115" });
    expect(co.validateTaxId("800197268-4", "31")).toEqual({ ok: true, normalized: "800197268" });
  });

  it("accepts a NIT without DV", () => {
    expect(co.validateTaxId("900373115", "31")).toEqual({ ok: true, normalized: "900373115" });
  });

  it("rejects a DV that does not match the computed one and says which is right", () => {
    const r = co.validateTaxId("800197268-9", "31");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("dígito de verificación");
    if (!r.ok) expect(r.reason).toContain("4");
  });

  it("rejects letters, dots and spaces in a NIT", () => {
    for (const bad of ["90037311A", "900.373.115", "900 373 115", "900373115 -3", " 900373115"]) {
      expect(co.validateTaxId(bad, "31").ok, bad).toBe(false);
    }
  });

  it("rejects a NIT that is too short or too long", () => {
    expect(co.validateTaxId("12345", "31").ok).toBe(false);
    expect(co.validateTaxId("12345678901", "31").ok).toBe(false);
  });

  it("validates other document types by charset and length", () => {
    expect(co.validateTaxId("79456123", "13")).toEqual({ ok: true, normalized: "79456123" });
    expect(co.validateTaxId("12AB", "13").ok).toBe(false);
    expect(co.validateTaxId("AB123456", "41")).toEqual({ ok: true, normalized: "AB123456" });
    expect(co.validateTaxId("AB-123", "41").ok).toBe(false);
    expect(co.validateTaxId("1".repeat(11), "13").ok).toBe(false);
    expect(co.validateTaxId("1".repeat(15), "47").ok).toBe(true);
  });

  it("rejects the reserved consumidor final number", () => {
    const r = co.validateTaxId("222222222222", "13");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/consumidor final/);
  });
});

describe("co pack", () => {
  it("exposes the 12 DIAN document types, COP and es-CO", () => {
    expect(co.code).toBe("CO");
    expect(co.documentTypes).toHaveLength(12);
    expect(co.documentTypes).toContain("31");
    expect(co.defaultCurrency).toBe("COP");
    expect(co.locale).toBe("es-CO");
  });
});
