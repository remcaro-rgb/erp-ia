import { defaultTemplate, ProcessError, translatorFor, type Block, type DefaultPresentation, type EInvoicePack, type EntityDef, type PrintVariables, type ProcessContext, type ResolutionInfo, type Template, type Translate } from "@erp/kernel";
import QRCode from "qrcode";
import { invoiceEntity, noteEntity } from "../entities";
import { DOCUMENT_ENVIRONMENT_MISSING, packOf, refuseState, settingsOf } from "../processes/common";

// The graphic representation of an electronic invoice and of its notes (plan 2B Task 19; entity types spec §6; design §8.1 step 5): the
// template they print with when the company chose none (ModuleDef.printTemplates, Task 12's seam) and what the print adds to the
// record's own fields (ModuleDef.printVariables, this task's seam):
//   fe.qr               the QR code (a PNG) of the tax authority's query of the document by its CUFE / CUDE (the pack's format, rule 5);
//   fe.qr_texto         that query's text;
//   fe.codigo           «CUFE: …» or «CUDE: …»;
//   fe.resolucion       the legend of the invoice's numbering resolution (number, prefix, range, validity), the pack's wording;
//   fe.representacion   «Representación gráfica de la factura electrónica de venta» (or of the note);
//   fe.aviso            a test document of habilitación says it has no fiscal value (the mock's verdicts are not fiscal); a document the
//                       tax authority has not accepted yet says so;
//   fe.referencia       a note names the invoice it corrects (number and CUFE).
// The copy is the app's catalogue (`invoicing.print.*`, rule 24), the fiscal text the pack's. A Borrador prints no QR, code or legend.
// The same template and values are what the e-invoice workflow stores as the accepted document's PDF (pdf_path, Task 17's slot).

/** The print variables of an electronic document. */
export const FE = {
  qr: "fe.qr",
  qrText: "fe.qr_texto",
  code: "fe.codigo",
  legend: "fe.resolucion",
  representation: "fe.representacion",
  notice: "fe.aviso",
  reference: "fe.referencia",
} as const;
export const EINVOICE_TEXT_VARIABLES: readonly string[] = [FE.qrText, FE.code, FE.legend, FE.representation, FE.notice, FE.reference];
export const EINVOICE_IMAGE_VARIABLES: readonly string[] = [FE.qr];

/** The header fields an invoice prints, in this order (what the customer reads; the CUFE goes in the footer). */
export const INVOICE_PRINT_FIELDS = ["number", "party_id", "issue_date", "issue_time", "due_date", "payment_form", "currency", "subtotal", "discount_total", "tax_total", "total", "notes"];
export const INVOICE_PRINT_LINE_COLUMNS = ["line_no", "product_id", "description", "qty", "unit_price", "discount", "base", "iva", "inc", "total"];
/** The header fields a credit or debit note prints. */
export const NOTE_PRINT_FIELDS = ["number", "kind", "invoice_id", "party_id", "issue_date", "issue_time", "reason", "currency", "subtotal", "tax_total", "total", "notes"];
export const NOTE_PRINT_LINE_COLUMNS = ["line_no", "product_id", "description", "qty", "unit_price", "base", "iva", "inc", "total"];

const MARGIN = 40;
const WIDTH = 595.28;
/** Where the footer of the electronic document starts (A4 portrait); the lines table stops above it and flows to the next page. */
const FOOTER_TOP = 660;
const QR_SIZE = 96;

function footer(note: boolean): Block[] {
  const x = MARGIN + QR_SIZE + 12;
  const w = WIDTH - MARGIN - x;
  return [
    { kind: "image", x: MARGIN, y: FOOTER_TOP, w: QR_SIZE, h: QR_SIZE, value: FE.qr },
    { kind: "variable", x, y: FOOTER_TOP, w, h: 20, font: { size: 7 }, value: FE.code },
    note
      ? { kind: "variable", x, y: FOOTER_TOP + 22, w, h: 20, font: { size: 7 }, value: FE.reference }
      : { kind: "variable", x, y: FOOTER_TOP + 22, w, h: 20, font: { size: 7 }, value: FE.legend },
    { kind: "variable", x, y: FOOTER_TOP + 46, w, h: 10, font: { size: 7 }, value: FE.representation },
    { kind: "variable", x, y: FOOTER_TOP + 60, w, h: 24, font: { size: 8, bold: true }, value: FE.notice },
  ];
}

function template(entity: EntityDef, fieldNames: readonly string[], columns: readonly string[], presentation: DefaultPresentation, note: boolean): Template {
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  const fields = fieldNames.map((name) => byName.get(name)!);
  const base = defaultTemplate({ ...entity, fields }, "record", presentation);
  const blocks = base.blocks.map((block): Block => (block.kind === "lines" ? { ...block, columns: [...columns], h: FOOTER_TOP - 12 - block.y } : block));
  return { ...base, blocks: [...blocks, ...footer(note)] };
}

export function invoiceRecordTemplate(presentation: DefaultPresentation): Template {
  return template(invoiceEntity, INVOICE_PRINT_FIELDS, INVOICE_PRINT_LINE_COLUMNS, presentation, false);
}

export function noteRecordTemplate(presentation: DefaultPresentation): Template {
  return template(noteEntity, NOTE_PRINT_FIELDS, NOTE_PRINT_LINE_COLUMNS, presentation, true);
}

/** What the footer is made of: the document's kind, its CUFE / CUDE (null on a Borrador), environment, resolution and DIAN status. */
export interface EInvoicePrintFacts {
  kind: "invoice" | "credit" | "debit";
  code: string | null;
  environment: "habilitacion" | "produccion";
  resolution: ResolutionInfo | null;
  dianStatus: string;
  /** A note's invoice. */
  reference?: { number: string; code: string } | null;
}

type Copy = (key: string, params?: Record<string, string | number>) => string | undefined;

const fill = (t: Copy | Translate, key: string, params: Record<string, string | number> = {}): string => {
  let text = t(key) ?? key;
  for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};

/** The values of the print variables of one document (EINVOICE_TEXT_VARIABLES and EINVOICE_IMAGE_VARIABLES). */
export async function einvoicePrintValues(
  facts: EInvoicePrintFacts,
  deps: { representation: EInvoicePack["representation"]; t: Copy | Translate; locale: string },
): Promise<Record<string, string>> {
  const { t } = deps;
  const values: Record<string, string> = Object.fromEntries([...EINVOICE_TEXT_VARIABLES, ...EINVOICE_IMAGE_VARIABLES].map((name) => [name, ""]));
  values[FE.representation] = fill(t, `invoicing.print.representation_${facts.kind}`);
  if (facts.code) {
    const payload = deps.representation.qrPayload(facts.code, facts.environment);
    values[FE.qrText] = payload;
    // The renderer prints PNG data URIs; error correction M (the DIAN's examples), a quiet zone of 2 modules.
    values[FE.qr] = await QRCode.toDataURL(payload, { type: "image/png", errorCorrectionLevel: "M", margin: 2, width: 300 });
    values[FE.code] = `${fill(t, facts.kind === "invoice" ? "invoicing.print.cufe" : "invoicing.print.cude")}: ${facts.code}`;
    if (facts.environment === "habilitacion") values[FE.notice] = fill(t, "invoicing.print.test_notice");
    else if (facts.dianStatus !== "accepted") values[FE.notice] = fill(t, "invoicing.print.pending_notice");
  }
  if (facts.kind === "invoice" && facts.resolution) values[FE.legend] = deps.representation.resolutionLegend(facts.resolution, deps.locale);
  if (facts.kind !== "invoice" && facts.reference) values[FE.reference] = fill(t, "invoicing.print.reference", { number: facts.reference.number, code: facts.reference.code });
  return values;
}

const asResolution = (v: unknown): ResolutionInfo | null => {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.number !== "string" || typeof r.validFrom !== "string" || typeof r.validTo !== "string") return null;
  return { number: r.number, prefix: typeof r.prefix === "string" ? r.prefix : "", from: Number(r.from), to: Number(r.to), validFrom: r.validFrom, validTo: r.validTo };
};

/** The document as the caller reads it (its masked view: what they may not see is not printed). */
async function factsOf(ctx: ProcessContext, entity: "invoicing.invoice" | "invoicing.note", recordId: string): Promise<EInvoicePrintFacts> {
  // The environment frozen at «Emitir» (Task 19 fix round 1) is the only source of an issued document (Task 37, R37-2): a reprint after a
  // switch to producción still points to the catalogue the CUFE names. A Borrador has none yet (it prints no QR): the company's current one.
  const table = entity === "invoicing.invoice" ? "invoicing.invoices" : "invoicing.notes";
  const [frozen] = await ctx.tx.unsafe(`select dian_environment, stage from ${table} where id = $1`, [recordId]) as { dian_environment: "habilitacion" | "produccion" | null; stage: string }[];
  const environmentOf = async (): Promise<"habilitacion" | "produccion"> => {
    if (frozen?.stage === "draft" || !frozen) return (await settingsOf(ctx)).dianEnvironment;
    if (!frozen.dian_environment) refuseState("document_environment_missing", [DOCUMENT_ENVIRONMENT_MISSING]);
    return frozen.dian_environment;
  };
  const dianEnvironment = await environmentOf();
  if (entity === "invoicing.invoice") {
    const [row] = await ctx.tx<{ cufe: string | null; resolution: unknown; dian_status: string | null; stage: string | null }[]>`
      select cufe, resolution, dian_status, stage from invoicing.v_invoices where id = ${recordId}`;
    if (!row) throw new ProcessError("not_found", `invoicing.invoice ${recordId} not found`);
    const issued = row.stage !== "draft" && !!row.cufe;
    return { kind: "invoice", code: issued ? row.cufe : null, environment: dianEnvironment, resolution: issued ? asResolution(row.resolution) : null, dianStatus: row.dian_status ?? "draft" };
  }
  const [row] = await ctx.tx<{ kind: "credit" | "debit"; cude: string | null; dian_status: string | null; stage: string | null; invoice_number: string | null; invoice_cufe: string | null }[]>`
    select n.kind, n.cude, n.dian_status, n.stage, i.number as invoice_number, i.cufe as invoice_cufe
    from invoicing.v_notes n left join invoicing.v_invoices i on i.id = n.invoice_id where n.id = ${recordId}`;
  if (!row) throw new ProcessError("not_found", `invoicing.note ${recordId} not found`);
  const issued = row.stage !== "draft" && !!row.cude;
  return {
    kind: row.kind, code: issued ? row.cude : null, environment: dianEnvironment, resolution: null, dianStatus: row.dian_status ?? "draft",
    reference: row.invoice_number && row.invoice_cufe ? { number: row.invoice_number, code: row.invoice_cufe } : null,
  };
}

function printVariablesFor(entity: "invoicing.invoice" | "invoicing.note"): PrintVariables {
  return {
    names: EINVOICE_TEXT_VARIABLES,
    images: EINVOICE_IMAGE_VARIABLES,
    async resolve(ctx, recordId, { locale }) {
      const { einvoice } = await packOf(ctx);
      return einvoicePrintValues(await factsOf(ctx, entity, recordId), { representation: einvoice.representation, t: translatorFor(locale), locale });
    },
  };
}

export const invoicePrintVariables = printVariablesFor("invoicing.invoice");
export const notePrintVariables = printVariablesFor("invoicing.note");
