import { describe, expect, it } from "vitest";
import { countryPack, registerCountryPack, type CountryPack } from "../country-pack";

const fake: CountryPack = {
  code: "CO",
  validateTaxId: (id) => ({ ok: true, normalized: id }),
  documentTypes: ["31"],
  defaultCurrency: "COP",
  locale: "es-CO",
  validateParty: (input) => ({ errors: [], missing: [], normalized: { ...input, checkDigit: null, legalName: "" } }),
  validateProduct: (input) => ({ errors: [], missing: [], normalized: input }),
  codeLabel: (_table, code) => code,
};

describe("country pack registry", () => {
  it("throws for a country with no registered pack", () => {
    expect(() => countryPack("MX")).toThrow("unknown country pack: MX");
  });

  it("returns the pack registered for its code", () => {
    registerCountryPack(fake);
    expect(countryPack("CO")).toBe(fake);
  });
});
