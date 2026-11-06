import { describe, expect, it } from "vitest";
import { einvoicePack } from "@erp/loc-co/einvoice";
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
const t = (key: string, params?: Record<string, string | number>) => {
  let text = COPY[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};
const deps = { representation: einvoicePack.representation, t, locale: "es-419" };

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
