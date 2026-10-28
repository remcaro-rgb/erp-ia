import { describe, expect, it } from "vitest";
import { gtinValid } from "../gtin";
import { UOM_CODES } from "../item-tables";
import { validateProduct } from "../validate-product";

const good = { sku: "CAF-500", description: "Café tostado molido 500 g", kind: "good", idScheme: "010", standardCode: "7702001005000", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, standardCost: 16200, trackStock: true } as const;

describe("validateProduct", () => {
  it("accepts a valid GTIN and pads it to 14 digits", () => {
    const r = validateProduct(good);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.normalized.standardCode).toBe("07702001005000");
  });

  it("rejects a GTIN with a wrong check digit, a UNSPSC that is not 8 digits, and an unknown unit code", () => {
    expect(validateProduct({ ...good, standardCode: "7702001005001" }).errors[0]).toMatch(/GTIN/);
    expect(validateProduct({ ...good, idScheme: "001", standardCode: "9010170" }).errors[0]).toMatch(/UNSPSC/);
    expect(validateProduct({ ...good, uomCode: "PCS" }).errors[0]).toMatch(/unidad/i);
  });

  it("requires price > 0 unless free sample, and a reference price > 0 when free", () => {
    expect(validateProduct({ ...good, listPrice: 0 }).errors[0]).toMatch(/Precio/);
    expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePriceType: "1", referencePrice: 0 }).errors[0]).toMatch(/referencia/);
    expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePriceType: "1", referencePrice: 3500 }).errors).toEqual([]);
    expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePrice: 3500 }).errors[0]).toMatch(/referencia/);
    expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePriceType: "1" }).errors[0]).toMatch(/referencia/);
  });

  it("rejects negative price or cost", () => {
    expect(validateProduct({ ...good, listPrice: -1 }).errors).toEqual(["Precio y costo no pueden ser negativos"]);
    expect(validateProduct({ ...good, standardCost: -5 }).errors).toEqual(["Precio y costo no pueden ser negativos"]);
  });

  it("services cannot track stock; missing standard code with scheme 010 is pending, not an error", () => {
    expect(validateProduct({ ...good, kind: "service", trackStock: true }).errors[0]).toMatch(/servicio/);
    const r = validateProduct({ ...good, standardCode: undefined });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual(["Código GTIN"]);
  });

  it("a valid service without stock tracking has no errors and ignores a missing cost", () => {
    const r = validateProduct({ ...good, kind: "service", trackStock: false, idScheme: "001", standardCode: "90101700", uomCode: "HUR", standardCost: undefined, ivaRate: "19" });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("a good without standard cost is pending, not an error", () => {
    const r = validateProduct({ ...good, standardCost: undefined });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual(["Costo estándar"]);
  });

  it("names the pending standard code of every scheme and accepts code 999 without one", () => {
    expect(validateProduct({ ...good, idScheme: "001", standardCode: "" }).missing).toEqual(["Código UNSPSC"]);
    expect(validateProduct({ ...good, idScheme: "020", standardCode: undefined }).missing).toEqual(["Partida arancelaria"]);
    expect(validateProduct({ ...good, idScheme: "999", standardCode: undefined })).toMatchObject({ errors: [], missing: [] });
  });

  it("checks UNSPSC and partida arancelaria lengths", () => {
    expect(validateProduct({ ...good, idScheme: "001", standardCode: "90101700" }).errors).toEqual([]);
    expect(validateProduct({ ...good, idScheme: "020", standardCode: "0901119000" }).errors).toEqual([]);
    expect(validateProduct({ ...good, idScheme: "020", standardCode: "090111900" }).errors[0]).toMatch(/Partida arancelaria/);
    expect(validateProduct({ ...good, idScheme: "001", standardCode: "9010170A" }).errors[0]).toMatch(/UNSPSC/);
  });

  it("requires sku and description, limits their length, restricts sku characters", () => {
    expect(validateProduct({ ...good, sku: "", description: "" }).missing).toEqual(["Código interno", "Descripción para la factura"]);
    expect(validateProduct({ ...good, sku: "x".repeat(51) }).errors).toContain("Código: máximo 50 caracteres");
    expect(validateProduct({ ...good, sku: "CAF 500" }).errors).toContain("Código: solo letras, números, punto, guion y guion bajo");
    expect(validateProduct({ ...good, description: "x".repeat(301) }).errors).toContain("Descripción: máximo 300 caracteres");
  });

  it("limits brand and model to 100", () => {
    const r = validateProduct({ ...good, brand: "b".repeat(101), model: "m".repeat(101) });
    expect(r.errors).toEqual(["Marca: máximo 100 caracteres", "Modelo: máximo 100 caracteres"]);
  });

  it("validates IVA, INC and other-tax codes", () => {
    for (const iva of ["19", "5", "0", "EXC"] as const) expect(validateProduct({ ...good, ivaRate: iva }).errors).toEqual([]);
    expect(validateProduct({ ...good, ivaRate: "16" as never }).errors).toEqual(["Tarifa de IVA inválida"]);
    for (const inc of ["2", "4", "8", "16"] as const) expect(validateProduct({ ...good, incRate: inc }).errors).toEqual([]);
    expect(validateProduct({ ...good, incRate: "7" as never }).errors).toEqual(["Tarifa de INC inválida"]);
    expect(validateProduct({ ...good, otherTaxes: ["22", "32", "33", "34", "35", "23"] }).errors).toEqual([]);
    expect(validateProduct({ ...good, otherTaxes: ["99"] }).errors).toEqual(["Impuesto adicional inválido: 99"]);
  });

  it("validates the reference price type of a free sample", () => {
    expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePriceType: "4" as never, referencePrice: 100 }).errors[0]).toMatch(/Tipo de precio de referencia/);
  });

  it("rejects a negative minimum stock and an unknown id scheme", () => {
    expect(validateProduct({ ...good, minStock: -1 }).errors).toEqual(["Existencias mínimas no pueden ser negativas"]);
    expect(validateProduct({ ...good, idScheme: "777" as never }).errors).toEqual(["Esquema de identificación inválido"]);
  });

  it("ships the curated UN/ECE unit table", () => {
    for (const c of ["94", "EA", "KGM", "GRM", "LTR", "MLT", "MTR", "CMT", "MTK", "MTQ", "HUR", "DAY", "MON", "BX", "PK", "BG", "BO", "DZN", "PR", "SET", "TNE"]) {
      expect(UOM_CODES.some((u) => u.code === c), c).toBe(true);
    }
  });

  it("does not mutate the input; a service is normalized to not tracking stock", () => {
    const input = { ...good, kind: "service", trackStock: true } as const;
    const r = validateProduct(input);
    expect(input.trackStock).toBe(true);
    expect(r.normalized.trackStock).toBe(false);
  });
});

describe("gtinValid (GS1 mod-10)", () => {
  it("accepts valid 8, 12, 13 and 14 digit codes", () => {
    expect(gtinValid("96385074")).toBe(true); // GTIN-8
    expect(gtinValid("036000291452")).toBe(true); // UPC-A
    expect(gtinValid("4006381333931")).toBe(true); // EAN-13
    expect(gtinValid("7702001005000")).toBe(true); // EAN-13 (demo)
    expect(gtinValid("07702001005000")).toBe(true); // GTIN-14
  });

  it("rejects a wrong check digit and a wrong length", () => {
    expect(gtinValid("96385075")).toBe(false);
    expect(gtinValid("036000291453")).toBe(false);
    expect(gtinValid("4006381333932")).toBe(false);
    expect(gtinValid("7702001005001")).toBe(false);
    expect(gtinValid("1234567")).toBe(false);
    expect(gtinValid("123456789")).toBe(false);
    expect(gtinValid("77020010050001")).toBe(false);
    expect(gtinValid("77020010O5000")).toBe(false);
    expect(gtinValid("")).toBe(false);
  });
});
