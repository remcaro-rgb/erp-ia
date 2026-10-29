import { describe, expect, it } from "vitest";
import { co } from "../index";

// How a stored code reads for a person (confirmation cards, design §6): DIAN codes keep the code before the name,
// places read by their DANE / ISO name.

describe("co.codeLabel", () => {
  it("fiscal codes keep the code in front of the name", () => {
    expect(co.codeLabel("documentTypes", "31", "es-419")).toBe("31 · NIT");
    expect(co.codeLabel("taxSchemes", "ZZ", "es-419")).toBe("ZZ · No aplica");
    expect(co.codeLabel("responsibilities", "R-99-PN", "es-419")).toBe("R-99-PN · No responsable · no aplica");
    expect(co.codeLabel("idSchemes", "999", "es-419")).toBe("999 · Código propio del contribuyente");
    expect(co.codeLabel("uoms", "KGM", "es-419")).toMatch(/^KGM · /);
    expect(co.codeLabel("otherTaxes", "34", "es-419")).toBe("34 · IBUA · bebidas azucaradas");
    expect(co.codeLabel("priceTypes", "1", "es-419")).toBe("1 · Valor comercial");
  });

  it("places and rates read by name, countries in the reader's language", () => {
    expect(co.codeLabel("municipalities", "05001", "es-419")).toBe("Medellín");
    expect(co.codeLabel("departments", "05", "es-419")).toBe("Antioquia");
    expect(co.codeLabel("countries", "CO", "es-419")).toBe("Colombia");
    expect(co.codeLabel("countries", "US", "en")).toBe("United States");
    expect(co.codeLabel("countries", "US", "es-419")).toBe("Estados Unidos");
    expect(co.codeLabel("ivaRates", "19", "es-419")).toBe("IVA 19 % (tarifa general)");
    expect(co.codeLabel("incRates", "8", "es-419")).toBe("INC 8 % (tarifa general)");
  });

  it("an unknown code has no label", () => {
    expect(co.codeLabel("municipalities", "99999", "es-419")).toBeUndefined();
    expect(co.codeLabel("documentTypes", "77", "es-419")).toBeUndefined();
  });
});
