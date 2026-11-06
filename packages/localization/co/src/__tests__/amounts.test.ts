import { describe, expect, it } from "vitest";
import { round2, splitInclusive } from "../einvoice/amounts";
import { computeNitDv, validateNitOrCedula } from "../einvoice/nit";
import { nitCheckDigit } from "../nit";

// Ported from Serena src/lib/dian/__tests__/amounts.test.ts (splitInclusive) and nit.test.ts.
describe("splitInclusive", () => {
  it("takes INC out of a tax-inclusive price exactly", () => {
    expect(splitInclusive(54000, 8)).toEqual({ gross: 54000, base: 50000, tax: 4000 });
    const odd = splitInclusive(9999, 8);
    expect(odd).toEqual({ gross: 9999, base: 9258.33, tax: 740.67 });
    expect(round2(odd.base + odd.tax)).toBe(9999);
    expect(splitInclusive(10000, 0)).toEqual({ gross: 10000, base: 10000, tax: 0 });
  });
  it("splits an IVA-inclusive price", () => {
    expect(splitInclusive(119000, 19)).toEqual({ gross: 119000, base: 100000, tax: 19000 });
  });
});

describe("round2 is the pack's single rounding", () => {
  it("rounds ties half-up despite binary noise", () => {
    expect(round2(1.005)).toBe(1.01);
  });
});

describe("einvoice nit re-exports the pack's check digit", () => {
  it("computeNitDv is nitCheckDigit", () => {
    expect(computeNitDv("900373115")).toBe(3);
    expect(computeNitDv("900373115")).toBe(nitCheckDigit("900373115"));
    expect(computeNitDv("900.373.115")).toBe(3);
  });
  it("validateNitOrCedula accepts cédula, NIT and NIT-DV, and rejects a wrong DV", () => {
    expect(validateNitOrCedula("1234567890").valid).toBe(true);
    expect(validateNitOrCedula("900373115").valid).toBe(true);
    expect(validateNitOrCedula("900.373.115-3").valid).toBe(true);
    const bad = validateNitOrCedula("900373115-4");
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain("es 3");
    expect(validateNitOrCedula("").valid).toBe(false);
    expect(validateNitOrCedula("abc").valid).toBe(false);
  });
});
