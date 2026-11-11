import { describe, expect, it } from "vitest";
import { resolveVariables } from "@erp/kernel";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { invoiceEntity } from "../entities";
import { renderTemplatePdf } from "../../../../kernel/src/templates/render";
import { pdfText } from "../../../../kernel/src/templates/__tests__/pdf-text";
import { invoicing } from "../index";
import {
  EINVOICE_IMAGE_VARIABLES, EINVOICE_TEXT_VARIABLES, einvoicePrintValues, INVOICE_PRINT_FIELDS, INVOICE_PRINT_LINE_COLUMNS, invoiceRecordTemplate, noteRecordTemplate, FE,
} from "../pdf/invoice-template";

// The graphic representation of an electronic invoice (plan 2B Task 19): the template the invoice prints with when the company chose none
// (ModuleDef.printTemplates, Task 12), with the CUFE, the QR code of the DIAN's query of the document and the legend of its numbering
// resolution, all printed from the country pack (rule 5) through the module's print variables (ModuleDef.printVariables).

const CUFE = "8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4";
const RESOLUTION = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: "2026-01-01", validTo: "2026-12-31" };
const COPY: Record<string, string> = {
  "invoicing.print.cufe": "CUFE",
  "invoicing.print.cude": "CUDE",
  "invoicing.print.representation_invoice": "Representación gráfica de la factura electrónica de venta",
  "invoicing.print.representation_credit": "Representación gráfica de la nota crédito electrónica",
  "invoicing.print.representation_debit": "Representación gráfica de la nota débito electrónica",
  "invoicing.print.test_notice": "Documento de prueba (habilitación DIAN): sin validez fiscal",
  "invoicing.print.pending_notice": "Documento pendiente de validación por la DIAN",
  "invoicing.print.reference": "Factura {number} · CUFE {code}",
};
/** A USD export invoice at the TRM of 2026-11-09 (FX §3): its totals in dollars, the legend of its peso equivalent from the pack. */
const USD = { currency: "USD", rate: 4123.45, rateDate: "2026-11-09", totalCompany: 51543125 };
const t = (key: string, params?: Record<string, string | number>) => {
  let text = COPY[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};
const deps = { representation: einvoicePack.representation, currencyLegend: einvoicePack.currencyLegend, t, locale: "es-419" };

describe("the invoice's print variables", () => {
  it("the QR payload is the DIAN's query of the document by its CUFE (Anexo Técnico format, pinned)", async () => {
    const values = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "produccion", resolution: RESOLUTION, dianStatus: "accepted" }, deps);
    expect(values[FE.qrText]).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${CUFE}`);
    // The image is a PNG of that text (the renderer prints data:image/png URIs only).
    expect(values[FE.qr]).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(values[FE.qr]!.split(",")[1]!, "base64");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(values[FE.code]).toBe(`CUFE: ${CUFE}`);
    // An accepted document in producción carries no notice.
    expect(values[FE.notice]).toBe("");
  });

  it("the legend shows the resolution's number, its range and its validity", async () => {
    const values = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "produccion", resolution: RESOLUTION, dianStatus: "accepted" }, deps);
    expect(values[FE.legend]).toContain("18760000001");
    expect(values[FE.legend]).toContain("del 990000000 al 990000999");
    expect(values[FE.legend]).toContain("vigente del 2026/01/01 al 2026/12/31");
    expect(values[FE.legend]).toContain("prefijo SETP");
  });

  it("habilitación prints the QR on the test catalogue and says the document has no fiscal value (the mock's verdicts are not fiscal)", async () => {
    const values = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "habilitacion", resolution: RESOLUTION, dianStatus: "accepted" }, deps);
    expect(values[FE.qrText]).toBe(`https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${CUFE}`);
    expect(values[FE.notice]).toBe("Documento de prueba (habilitación DIAN): sin validez fiscal");
  });

  it("a document the DIAN has not accepted yet says so; a Borrador prints no QR, code or legend", async () => {
    const pending = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "produccion", resolution: RESOLUTION, dianStatus: "submitted" }, deps);
    expect(pending[FE.notice]).toBe("Documento pendiente de validación por la DIAN");
    const draft = await einvoicePrintValues({ kind: "invoice", code: null, environment: "produccion", resolution: null, dianStatus: "draft" }, deps);
    for (const name of [FE.qr, FE.qrText, FE.code, FE.legend]) expect(draft[name]).toBe("");
  });

  it("a credit note prints its CUDE, its QR and the invoice it corrects, and no numbering legend", async () => {
    const cude = CUFE.replace(/^8/, "9");
    const values = await einvoicePrintValues(
      { kind: "credit", code: cude, environment: "produccion", resolution: null, dianStatus: "accepted", reference: { number: "SETP990000001", code: CUFE } }, deps);
    expect(values[FE.code]).toBe(`CUDE: ${cude}`);
    expect(values[FE.qrText]).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cude}`);
    expect(values[FE.reference]).toBe(`Factura SETP990000001 · CUFE ${CUFE}`);
    expect(values[FE.legend]).toBe("");
    expect(values[FE.representation]).toBe("Representación gráfica de la nota crédito electrónica");
  });
});

describe("the invoice's template (ModuleDef.printTemplates + printVariables)", () => {
  it("the module ships the invoice's and the notes' record templates and their print variables", () => {
    expect(invoicing.printTemplates?.["invoicing.invoice"]?.record).toBe(invoiceRecordTemplate);
    expect(invoicing.printTemplates?.["invoicing.note"]?.record).toBe(noteRecordTemplate);
    for (const entity of ["invoicing.invoice", "invoicing.note"]) {
      expect(invoicing.printVariables?.[entity]?.names).toEqual(EINVOICE_TEXT_VARIABLES);
      expect(invoicing.printVariables?.[entity]?.images).toEqual(EINVOICE_IMAGE_VARIABLES);
    }
  });

  it("prints the commercial fields, the lines, and a footer with the QR, the CUFE, the legend and the notice below the lines", () => {
    const template = invoiceRecordTemplate({ title: "Factura electrónica de venta" });
    const fields = template.blocks.filter((b) => b.kind === "field").map((b) => b.value);
    expect(fields).toEqual(INVOICE_PRINT_FIELDS);
    const lines = template.blocks.find((b) => b.kind === "lines")!;
    expect(lines.columns).toEqual(INVOICE_PRINT_LINE_COLUMNS);
    const qr = template.blocks.find((b) => b.kind === "image" && b.value === FE.qr)!;
    expect(qr).toBeDefined();
    for (const name of [FE.code, FE.legend, FE.representation, FE.notice]) expect(template.blocks.some((b) => b.kind === "variable" && b.value === name)).toBe(true);
    // The lines table stops above the footer (it flows to the next page instead of running under the QR).
    expect(lines.h).toBeDefined();
    expect(lines.y + lines.h!).toBeLessThanOrEqual(qr.y);
  });

  it("renders a PDF that prints the CUFE, the legend and the notice", async () => {
    const values = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "habilitacion", resolution: RESOLUTION, dianStatus: "accepted" }, deps);
    const pdf = await renderTemplatePdf(invoiceRecordTemplate({ title: "Factura electrónica de venta" }), { ...values, number: "SETP990000001" }, undefined, undefined, { printedAt: new Date("2026-11-05T15:00:00Z") });
    const text = pdfText(pdf);
    expect(text).toContain(CUFE.slice(0, 40));
    expect(text).toContain("990000999");
    expect(text).toContain("sin validez fiscal");
  });
});

// Task 34.4 (FX §3, item 129): a foreign-currency invoice prints its totals in its own currency (USD 12.500,00) and, below them, the peso
// equivalent at its rate, in the pack's wording (rule 5); a peso invoice prints no legend.
describe("the foreign-currency invoice's print (Task 34.4)", () => {
  it("the pack's legend gives the COP equivalent at the TRM and its date; a COP invoice has none", () => {
    expect(einvoicePack.currencyLegend(USD, "es-419")).toEqual(["Equivalente en COP a TRM 4.123,45 del 2026-11-09: $ 51.543.125,00"]);
    expect(einvoicePack.currencyLegend(USD, "en")).toEqual(["COP equivalent at TRM 4.123,45 of 2026-11-09: $ 51.543.125,00"]);
    expect(einvoicePack.currencyLegend({ currency: "COP", rate: 1, rateDate: "2026-11-09", totalCompany: 1000 }, "es-419")).toEqual([]);
  });

  it("the print variable fe.moneda carries the legend; the template prints it below the totals", async () => {
    const values = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "produccion", resolution: RESOLUTION, dianStatus: "accepted", currency: USD }, deps);
    expect(values[FE.currency]).toBe("Equivalente en COP a TRM 4.123,45 del 2026-11-09: $ 51.543.125,00");
    const peso = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "produccion", resolution: RESOLUTION, dianStatus: "accepted", currency: { ...USD, currency: "COP", rate: 1 } }, deps);
    expect(peso[FE.currency]).toBe("");
    expect(EINVOICE_TEXT_VARIABLES).toContain(FE.currency);
    expect(invoiceRecordTemplate({ title: "Factura" }).blocks.some((b) => b.kind === "variable" && b.value === FE.currency)).toBe(true);
  });

  it("renders the USD invoice with USD 12.500,00 totals and the peso legend", async () => {
    const money = ["subtotal", "discount_total", "tax_total", "total"].map((field) => ({ field, label: field, type: "money" as const }));
    const record = { currency: "USD", subtotal: "12500.0000", discount_total: "0.0000", tax_total: "0.0000", total: "12500.0000" };
    const ctx = {
      company: { name: "Café del Norte S.A.S.", nit: "900373115-3", address: "", city: "", phone: "", logo: "" }, user: { name: "Ana" },
      printedAt: new Date("2026-11-09T15:00:00Z"), locale: "es-419", timeZone: "America/Bogota", columns: [{ field: "currency", label: "currency", type: "text" as const }, ...money],
    };
    const fields = resolveVariables(ctx, invoiceEntity, record);
    expect(fields.total).toBe("USD 12.500,00");
    expect(fields.subtotal).toBe("USD 12.500,00");
    // A peso invoice prints as rule 23 says.
    expect(resolveVariables(ctx, invoiceEntity, { ...record, currency: "COP", total: "1234567" }).total).toBe("$ 1.234.567,00");
    const values = await einvoicePrintValues({ kind: "invoice", code: CUFE, environment: "habilitacion", resolution: RESOLUTION, dianStatus: "accepted", currency: USD }, deps);
    const pdf = await renderTemplatePdf(invoiceRecordTemplate({ title: "Factura electrónica de venta" }), { ...fields, ...values, number: "SETP990000001" }, undefined, undefined, { printedAt: new Date("2026-11-09T15:00:00Z") });
    const text = pdfText(pdf);
    expect(text).toContain("USD 12.500,00");
    expect(text).toContain("Equivalente en COP a TRM 4.123,45 del 2026-11-09: $ 51.543.125,00");
  });
});
