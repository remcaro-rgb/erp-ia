import { describe, expect, it } from "vitest";
import { CREDIT_NOTE_REASONS } from "../einvoice/constants";
import {
  ANNULMENT_CONCEPT, conceptName, CREDIT_NOTE_CONCEPTS, CREDIT_NOTE_OPERATIONS, CURRENCIES, DEBIT_NOTE_CONCEPTS, DEBIT_NOTE_OPERATIONS, DOCUMENT_TYPES,
  EXPORT_CREDIT_NOTE_TYPE, EXPORT_INVOICE_TYPE, INVOICE_OPERATIONS, NATIONAL_CREDIT_NOTE_TYPE, NATIONAL_INVOICE_TYPE,
} from "../einvoice/tables/dian-tables";

// The DIAN code tables pinned from the Anexo 1.9 toolbox (plan 2B Task 18, step one; source and checksum in the tables' header). A change
// of any code or description must be a reviewed change of the tables file AND of this test.

const pairs = (t: readonly { code: string; name: string }[]) => t.map((c) => [c.code, c.name]);

describe("DIAN tables of the Anexo 1.9 toolbox (Caja-de-herramientas-FE_V19_v2026.zip)", () => {
  it("13.2.4 credit-note correction concepts: 1–6, 2 is the annulment (1.9 replaced the 1.8 «5 Otros» with two commercial discounts)", () => {
    expect(pairs(CREDIT_NOTE_CONCEPTS)).toEqual([
      ["1", "Devolución parcial de los bienes y/o no aceptación parcial del servicio"],
      ["2", "Anulación de factura electrónica"],
      ["3", "Rebaja  o descuento parcial o total"],
      ["4", "Ajuste de precio"],
      ["5", "Descuento comercial por pronto pago"],
      ["6", "Descuento comercial por volumen de ventas"],
    ]);
    expect(ANNULMENT_CONCEPT).toBe("2");
    expect(conceptName("credit", ANNULMENT_CONCEPT)).toBe("Anulación de factura electrónica");
  });

  it("13.2.5 debit-note correction concepts: 1–4", () => {
    expect(pairs(DEBIT_NOTE_CONCEPTS)).toEqual([["1", "Intereses"], ["2", "Gastos por cobrar"], ["3", "Cambio del valor"], ["4", "Otros"]]);
    expect(conceptName("debit", "9")).toBeUndefined();
  });

  it("13.1.5.2 / 13.1.5.3 operation types of the notes: 20 / 30 reference an invoice, 22 / 32 do not", () => {
    expect(CREDIT_NOTE_OPERATIONS.map((c) => c.code)).toEqual(["20", "22"]);
    expect(DEBIT_NOTE_OPERATIONS.map((c) => c.code)).toEqual(["30", "32"]);
    expect(INVOICE_OPERATIONS.map((c) => c.code)).toEqual(["09", "10", "11", "12", "14", "15", "16"]);
  });

  it("13.1.3 document types: 01 national, 02 export, 91 / 92 notes; the credit note type codes chosen from it", () => {
    expect(DOCUMENT_TYPES.map((c) => c.code)).toEqual(["01", "02", "03", "04", "91", "92", "96"]);
    expect([NATIONAL_INVOICE_TYPE, EXPORT_INVOICE_TYPE]).toEqual(["01", "02"]);
    expect([NATIONAL_CREDIT_NOTE_TYPE, EXPORT_CREDIT_NOTE_TYPE]).toEqual(["91", "02"]);
    for (const code of [NATIONAL_INVOICE_TYPE, EXPORT_INVOICE_TYPE, NATIONAL_CREDIT_NOTE_TYPE, EXPORT_CREDIT_NOTE_TYPE]) expect(DOCUMENT_TYPES.some((c) => c.code === code)).toBe(true);
  });

  it("13.3.3 currencies: the 179 ISO 4217 codes of the sheet, COP, USD and EUR among them, no duplicate", () => {
    expect(CURRENCIES).toHaveLength(179);
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    for (const code of ["COP", "USD", "EUR", "XXX"]) expect(CURRENCIES).toContain(code);
    expect(CURRENCIES.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
  });

  it("the older CREDIT_NOTE_REASONS constant (ported from Serena, Anexo 1.8) now reads the 1.9 table", () => {
    expect(CREDIT_NOTE_REASONS).toEqual(Object.fromEntries(pairs(CREDIT_NOTE_CONCEPTS)));
  });
});
