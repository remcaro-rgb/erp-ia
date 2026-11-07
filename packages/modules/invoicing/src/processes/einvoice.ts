import { infra } from "@erp/infra";
import { defineProcess, fileStore, ProcessError, renderPrint, translatorFor, type EventConsumer, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { SUBMISSION_STATUSES, type SubmissionStatus } from "../entities";
import { FEATURE_INVOICES, id, markInvoiceLinksVoided, num, packOf, refuseState, round2, settingsOf } from "./common";
import { label, readInvoice } from "./invoice";
import { noteLabel, readNote } from "./note";
import { einvoiceSubmission } from "../workflows/einvoice.workflow";

// The DIAN submission of an issued invoice (plan 2B Task 17; design §18a, §19, OD-1: direct submission behind the EInvoiceTransport seam)
// and of an issued credit or debit note (Task 18: the same workflow, one submission per note, its CUDE computed when its XML is built).
//
// invoicing.invoice.issued / invoicing.note.issued → the consumers below run invoicing.einvoice_submission.request (one submission per
// invoice, one per note: a redelivered event finds it) and start the e-invoice workflow (workflows/einvoice.workflow.ts, through the
// DurableRunner, rule 6). The workflow's steps change nothing themselves: every write is one of these processes, run as the event's system
// user on the issue's chain (origin event):
//   - invoicing.einvoice_submission.record: the run claims the submission, notes a submit about to be sent (attempts, and the signed XML
//     kept before it is sent; for a note its CUDE, stored once on the note), the trackId the DIAN acknowledged (dian_status submitted only
//     then), each poll, or why it stopped (failed);
//   - invoicing.einvoice_submission.document: reads the invoice (or the note) as issued (its frozen lines and taxes; current master data
//     only for what the CUFE / CUDE does not cover: names, address, e-mail, product descriptions) as the electronic document carries it, in
//     its currency with its TRM (Task 18: export and foreign-currency invoices; the CUFE is the one «Emitir» computed);
//   - invoicing.invoice.dian_result / invoicing.note.dian_result: the DIAN's verdict, with its errors and the stored files: dian_status
//     accepted or rejected, and the events. An accepted annulment note voids its invoice in ONE statement (stage voided and the note named:
//     the check constraint invoices_voided_has_note) and emits invoicing.invoice.annulled (sales recomputes invoiced_qty from it). The
//     invoice's number is never reused; invoicing.invoice.voided is never emitted (the annulment note posted the reversal itself).
// «Reintentar envío» (invoicing.invoice.resubmit, invoicing.note.resubmit, normal) sends again a rejected document (same number, same
// CUFE / CUDE: DIAN keeps no rejected document, the number is not consumed; the document is built again from the frozen record and the
// corrected master data, and refused if that would change its CUFE), or resumes a submission that failed (a document already sent is polled
// by its trackId, never sent twice) or that waited for the software to be registered, or whose run stopped without recording why (a stale
// run: no longer running). invoicing.invoice.resubmit_failed is the bulk sweep: every issued invoice (and note) whose sending stopped
// (failed: e.g. currency_not_supported before Task 18) or that waited for the software to be registered (not_configured: Task 19's
// «Reintentar todos»), queued again at once.

export const INVOICE_ACCEPTED = "invoicing.invoice.accepted";
export const INVOICE_REJECTED = "invoicing.invoice.rejected";
export const RESUBMIT_REQUESTED = "invoicing.invoice.resubmit_requested";
export const NOTE_ACCEPTED = "invoicing.note.accepted";
export const NOTE_REJECTED = "invoicing.note.rejected";
/** An invoice voided by its accepted annulment note (OD-7): sales gives the entregas back (invoiced_qty). */
export const INVOICE_ANNULLED = "invoicing.invoice.annulled";

const NOT_CONFIGURED = "La empresa no tiene registrado el software de facturación electrónica ante la DIAN (Parámetros de facturación): la factura no se envió";

export interface SubmissionRow {
  id: string; invoice_id: string; note_id: string | null; status: SubmissionStatus; round: number; attempts: number; polls: number; track_id: string | null; run_id: string | null;
  cufe: string | null; errors: string[]; last_error: string | null; xml_path: string | null; response_path: string | null;
}

const SUBMISSION_COLUMNS = "id, invoice_id, note_id, status, round, attempts, polls, track_id, run_id, cufe, errors, last_error, xml_path, response_path";

async function submissionById(ctx: ProcessContext, submissionId: string, lock = false): Promise<SubmissionRow> {
  const rows = await ctx.tx.unsafe(`select ${SUBMISSION_COLUMNS} from invoicing.einvoice_submissions where id = $1${lock ? " for update" : ""}`, [submissionId]) as SubmissionRow[];
  if (!rows[0]) throw new ProcessError("not_found", `einvoice submission ${submissionId} not found`);
  return rows[0];
}

const submissionOutput = z.object({
  id: z.string(), invoiceId: z.string(), noteId: z.string().nullable(), status: z.enum(SUBMISSION_STATUSES), round: z.number(), attempts: z.number(), polls: z.number(),
  trackId: z.string().nullable(), runId: z.string().nullable(), cufe: z.string().nullable(), errors: z.array(z.string()), lastError: z.string().nullable(),
  xmlPath: z.string().nullable(),
});
type SubmissionOutput = z.output<typeof submissionOutput>;
const out = (s: SubmissionRow): SubmissionOutput => ({
  id: s.id, invoiceId: s.invoice_id, noteId: s.note_id, status: s.status, round: s.round, attempts: s.attempts, polls: s.polls, trackId: s.track_id, runId: s.run_id,
  cufe: s.cufe, errors: s.errors, lastError: s.last_error, xmlPath: s.xml_path,
});

/** Whether the company registered its software with the DIAN (the document needs it; its PIN is checked by the workflow). */
async function softwareRegistered(ctx: ProcessContext): Promise<boolean> {
  const [row] = await ctx.tx<{ software_id: string | null }[]>`select software_id from invoicing.settings where company_id = ${ctx.companyId}`;
  return !!row?.software_id;
}

/** The submission row of an invoice of its own (note_id null) or of a note. */
async function submissionOf(ctx: ProcessContext, target: { invoiceId: string } | { noteId: string }, lock = false): Promise<SubmissionRow | undefined> {
  const [column, value] = "noteId" in target ? ["note_id", target.noteId] : ["invoice_id", target.invoiceId];
  const rows = await ctx.tx.unsafe(
    `select ${SUBMISSION_COLUMNS} from invoicing.einvoice_submissions where ${column} = $1${"noteId" in target ? "" : " and note_id is null"}${lock ? " for update" : ""}`,
    [value],
  ) as SubmissionRow[];
  return rows[0];
}

const target = z.union([z.object({ invoiceId: id }).strict(), z.object({ noteId: id }).strict()]);

export const submissionRequest = defineProcess({
  id: "invoicing.einvoice_submission.request",
  module: "invoicing",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  description:
    "Registra el envío a la DIAN de una factura o una nota emitida (uno por documento) y dice si hay que iniciar su envío; solo lo ejecuta el evento de documento emitido o de reintento",
  input: target,
  output: z.object({ submissionId: z.string(), status: z.enum(SUBMISSION_STATUSES), created: z.boolean(), start: z.boolean() }),
  handler: async (ctx, input) => {
    const configured = await softwareRegistered(ctx);
    const status = configured ? "queued" : "not_configured";
    const lastError = configured ? null : NOT_CONFIGURED;
    let inserted: { id: string; status: SubmissionStatus } | undefined;
    if ("noteId" in input) {
      const note = await readNote(ctx, input.noteId, true);
      if (note.stage !== "issued" || !note.number) refuseState("note_not_issued", [`La nota ${noteLabel(note)} no está emitida: no se envía a la DIAN`]);
      [inserted] = await ctx.tx<{ id: string; status: SubmissionStatus }[]>`
        insert into invoicing.einvoice_submissions ${ctx.tx({ company_id: ctx.companyId, invoice_id: note.invoice_id, note_id: note.id, status, last_error: lastError })}
        on conflict (note_id) where note_id is not null do nothing returning id, status`;
    } else {
      const invoice = await readInvoice(ctx, input.invoiceId, true);
      if (invoice.stage === "draft" || !invoice.cufe) refuseState("invoice_not_issued", [`La factura ${label(invoice)} no está emitida: no se envía a la DIAN`]);
      [inserted] = await ctx.tx<{ id: string; status: SubmissionStatus }[]>`
        insert into invoicing.einvoice_submissions ${ctx.tx({ company_id: ctx.companyId, invoice_id: invoice.id, cufe: invoice.cufe, status, last_error: lastError })}
        on conflict (invoice_id) where note_id is null do nothing returning id, status`;
    }
    if (inserted) return { submissionId: inserted.id, status: inserted.status, created: true, start: inserted.status === "queued" };
    const existing = (await submissionOf(ctx, input))!;
    // A queued submission no run has claimed (the start was lost, or «Reintentar envío»): start one. A run that finds it claimed exits.
    return { submissionId: existing.id, status: existing.status, created: false, start: existing.status === "queued" && existing.run_id === null };
  },
});

const runId = z.string().min(1).max(200);
const recordInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), id, runId }).strict(),
  /** `code`: a note's CUDE, computed by the workflow as it builds the XML (it needs the software PIN); stored once on the note. */
  z.object({ action: z.literal("submitting"), id, runId, xmlPath: z.string().min(1).max(500), code: z.string().regex(/^[0-9a-f]{96}$/).optional() }).strict(),
  z.object({ action: z.literal("submitted"), id, runId, trackId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("polled"), id, runId }).strict(),
  z.object({ action: z.literal("failed"), id, runId, error: z.string().min(1) }).strict(),
]);

export const submissionRecord = defineProcess({
  id: "invoicing.einvoice_submission.record",
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  description:
    "Anota el avance del envío de una factura o una nota a la DIAN (inicio, intento de envío, número de seguimiento, consultas, falla); solo lo ejecuta el flujo de envío",
  input: recordInput,
  output: z.object({ owned: z.boolean(), submission: submissionOutput }),
  handler: async (ctx, input) => {
    const s = await submissionById(ctx, input.id, true);
    if (input.action === "claim") {
      if (s.run_id === input.runId) return { owned: true, submission: out(s) };
      if (s.status !== "queued" || s.run_id !== null) return { owned: false, submission: out(s) };
      const [claimed] = await ctx.tx<SubmissionRow[]>`
        update invoicing.einvoice_submissions
        -- A round whose document the DIAN already has (a resumed failure) waits for its verdict: submitted, polled by its trackId.
        set status = case when track_id is null then 'processing' else 'submitted' end, run_id = ${input.runId}, last_error = null
        where id = ${s.id} returning *`;
      return { owned: true, submission: out(claimed!) };
    }
    // Only the run that claimed the submission writes it: a stale run (a redelivery that lost the claim) changes nothing.
    if (s.run_id !== input.runId) return { owned: false, submission: out(s) };
    let row: SubmissionRow | undefined;
    switch (input.action) {
      case "submitting": {
        // About to send: counted BEFORE the transport is called, so an attempt whose answer is lost is not sent again unless the DIAN says
        // it never received it (polled by its trackId: not_found). The signed XML sent is kept first (the file the DIAN validates). The
        // document's dian_status does not move yet: nothing says the DIAN has it. A note's CUDE is kept the first time (it never changes).
        if (s.note_id && input.code) {
          if (s.cufe && s.cufe !== input.code) throw new ProcessError("invalid_input", "cude_changed: el documento de la nota tendría otro CUDE que el de su primer envío");
          await ctx.tx`update invoicing.notes set cude = ${input.code} where id = ${s.note_id} and cude is null`;
        }
        [row] = await ctx.tx<SubmissionRow[]>`
          update invoicing.einvoice_submissions set attempts = attempts + 1, xml_path = ${input.xmlPath}, cufe = coalesce(cufe, ${input.code ?? null}) where id = ${s.id} returning *`;
        break;
      }
      case "submitted":
        // The DIAN acknowledged the document (it answered a trackId, or a poll found it): Enviada.
        [row] = await ctx.tx<SubmissionRow[]>`
          update invoicing.einvoice_submissions set status = 'submitted', track_id = ${input.trackId}, submitted_at = coalesce(submitted_at, now()) where id = ${s.id} returning *`;
        if (s.note_id) await ctx.tx`update invoicing.notes set dian_status = 'submitted' where id = ${s.note_id} and dian_status in ('draft', 'rejected')`;
        else await ctx.tx`update invoicing.invoices set dian_status = 'submitted' where id = ${s.invoice_id} and dian_status in ('draft', 'rejected')`;
        break;
      case "polled":
        [row] = await ctx.tx<SubmissionRow[]>`update invoicing.einvoice_submissions set polls = polls + 1 where id = ${s.id} returning *`;
        break;
      case "failed":
        [row] = await ctx.tx<SubmissionRow[]>`
          update invoicing.einvoice_submissions set status = 'failed', last_error = ${input.error.slice(0, 2000)} where id = ${s.id} and status not in ('accepted', 'rejected') returning *`;
        break;
    }
    return { owned: true, submission: out(row ?? s) };
  },
});

// ---------------------------------------------------------------------------------------------
// The electronic document of an issued invoice or note
// ---------------------------------------------------------------------------------------------

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });
const opt = (v: unknown) => (v === null || v === undefined || v === "" ? {} : undefined);
const field = <K extends string>(key: K, v: unknown) => (opt(v) ?? { [key]: v }) as Partial<Record<K, string>>;

interface FrozenLine { product_id: string; qty: string; unit_price: string; discount: string; base: string; iva_rate: string | null; iva: string; inc_rate: string | null; inc: string; other_taxes: string; total: string; free_sample: boolean; description: string | null }
interface FrozenTax { family: "IVA" | "INC" | "OTHER"; code: string; rate: string | null; base: string; amount: string }

/**
 * The lines and taxes of a document as it was issued (its frozen lines and its taxes per tax and rate, never computed again from today's
 * products or customer: an issued document must stay sendable; the code check in the workflow guards the amounts). They must add up.
 */
async function frozenParts(ctx: ProcessContext, name: string, lines: FrozenLine[], taxes: FrozenTax[], totals: { subtotal: string; tax_total: string; total: string }) {
  const products = new Map((await ctx.tx<{ id: string; sku: string; description: string; id_scheme: "999" | "010" | "001" | "020"; standard_code: string | null; brand: string | null; model: string | null; uom_code: string }[]>`
    select id, sku, description, id_scheme, standard_code, brand, model, uom_code from core.v_products where id = any(${[...new Set(lines.map((l) => l.product_id))]}::uuid[])`).map((p) => [p.id, p]));
  if (lines.some((l) => !products.has(l.product_id))) return fail("product_not_found", `Un producto de ${name} no es visible`);
  const amount = (v: string) => round2(num(v));
  const other = taxes.filter((t) => t.family === "OTHER");
  const changed = (why: string) =>
    fail("document_changed", `Los valores guardados de ${name} no cuadran (${why}): no se puede armar su documento electrónico; se corrige con una nota`);
  const otherOfLine = (l: FrozenLine) => {
    if (amount(l.other_taxes) === 0) return [];
    // One additional tax on the document: each line's other_taxes is that tax. Several: the per-line split was not kept at the issue.
    if (other.length !== 1) return null;
    return [{ code: other[0]!.code, rate: other[0]!.rate === null ? null : num(other[0]!.rate), amount: amount(l.other_taxes), rateKnown: other[0]!.rate !== null }];
  };
  const taxedLines = lines.map((l) => {
    const otherTaxes = otherOfLine(l);
    return otherTaxes && {
      base: amount(l.base), ivaRate: l.iva_rate === null ? null : num(l.iva_rate), iva: amount(l.iva), incRate: l.inc_rate === null ? null : num(l.inc_rate), inc: amount(l.inc),
      otherTaxes, payable: amount(l.total), freeSample: l.free_sample,
    };
  });
  if (taxedLines.some((t) => t === null)) return changed("varios impuestos adicionales sin su reparto por línea");
  const charged = lines.filter((l) => !l.free_sample);
  const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
  const lineTaxes = sum(charged.map((l) => amount(l.iva) + amount(l.inc) + amount(l.other_taxes)));
  if (sum(charged.map((l) => amount(l.base))) !== round2(num(totals.subtotal))) return changed("subtotal");
  if (lineTaxes !== round2(num(totals.tax_total)) || sum(taxes.map((t) => amount(t.amount))) !== lineTaxes) return changed("impuestos");
  if (sum(charged.map((l) => amount(l.total))) !== round2(num(totals.total))) return changed("total");
  return {
    ok: true as const,
    taxed: {
      lines: taxedLines.map((t) => t!),
      taxes: taxes.map((t) => ({ family: t.family, code: t.code, rate: t.rate === null ? null : num(t.rate), base: amount(t.base), amount: amount(t.amount) })),
      subtotal: round2(num(totals.subtotal)), taxTotal: round2(num(totals.tax_total)), total: round2(num(totals.total)),
      freeSampleBase: sum(lines.filter((l) => l.free_sample).map((l) => amount(l.base))),
      withholdingsSuffered: [],
    },
    lines: lines.map((l) => {
      const p = products.get(l.product_id)!;
      return {
        item: { sku: p.sku, description: l.description ?? p.description, idScheme: p.id_scheme, uomCode: p.uom_code, ...field("standardCode", p.standard_code), ...field("brand", p.brand), ...field("model", p.model) },
        quantity: num(l.qty),
        unitPrice: num(l.unit_price),
        ...(num(l.discount) > 0 ? { discount: num(l.discount) } : {}),
        // A free sample's reference price as it was taxed (its frozen base per unit), not today's.
        ...(l.free_sample ? { referencePrice: round2(num(l.base) / num(l.qty)) } : {}),
      };
    }),
  };
}

type Resolution = { number: string; prefix: string; from: number; to: number; validFrom: string; validTo: string };

/**
 * What every document of the company carries: the software, the environment, the issuer, the customer and, for an invoice, its resolution
 * with its technical key (a note has none: it is numbered by a plain sequence and its CUDE takes the software PIN, fix round 1).
 */
async function documentFrame(ctx: ProcessContext, partyId: string, numbering: { type: "invoice" | "credit_note" | "debit_note"; resolution: Resolution | null; name: string; environment: "habilitacion" | "produccion" | null }) {
  const [settings] = await ctx.tx<{ software_id: string | null; software_provider_tax_id: string | null; test_set_id: string | null; issuer_tax_responsibilities: string[]; issuer_tax_scheme: "01" | "04" | "ZA" | "ZZ"; issuer_department_code: string | null; issuer_municipality_code: string | null }[]>`
    select software_id, software_provider_tax_id, test_set_id, issuer_tax_responsibilities, issuer_tax_scheme, issuer_department_code, issuer_municipality_code
    from invoicing.settings where company_id = ${ctx.companyId}`;
  if (!settings?.software_id) return fail("einvoice_not_configured", NOT_CONFIGURED);
  // The environment frozen at «Emitir» (Task 19 fix round 1; the CUFE / CUDE names it), the Parámetros' for a document issued before.
  const dianEnvironment = numbering.environment ?? (await settingsOf(ctx)).dianEnvironment;
  const [company] = await ctx.tx<{ tax_id: string | null; legal_name: string; trade_name: string | null; country_code: string; currency_code: string; address_line: string | null; phone_cc: string | null; phone: string | null }[]>`
    select tax_id, legal_name, trade_name, country_code, currency_code, address_line, phone_cc, phone from kernel.companies where id = ${ctx.companyId}`;
  if (!company?.tax_id) return fail("issuer_tax_id_missing", "La empresa no tiene su número de identificación tributaria registrado");
  // The resolution (numbering range) the invoice's number was drawn from, with its technical key (never stored on the document): core's
  // published view. Only an invoice needs it.
  const resolution = numbering.resolution;
  let invoiceResolution: (Resolution & { technicalKey: string }) | null = null;
  if (numbering.type === "invoice") {
    // core.v_document_sequences answers only the key's last characters (Task 19 fix round 1): the key itself through core's function,
    // which answers it inside a process run only.
    const [sequence] = await ctx.tx<{ key: string | null }[]>`
      select core.document_technical_key(${ctx.companyId}, ${numbering.type}, ${resolution?.prefix ?? ""}, ${resolution?.number ?? ""}) as key`;
    const technicalKey = sequence?.key;
    if (typeof technicalKey !== "string" || !resolution) return fail("resolution_not_found", `La resolución DIAN de ${numbering.name} ya no está registrada`);
    invoiceResolution = { ...resolution, technicalKey };
  }
  const [customer] = await ctx.tx<Record<string, unknown>[]>`select * from core.v_party_fiscal where id = ${partyId}`;
  if (!customer) return fail("customer_not_found", `El cliente de ${numbering.name} no es visible`);
  return {
    ok: true as const,
    testSetId: settings.test_set_id,
    companyCurrency: company.currency_code,
    companyCountry: company.country_code,
    frame: {
      environment: dianEnvironment,
      ...(invoiceResolution ? { resolution: invoiceResolution } : {}),
      software: { id: settings.software_id, providerTaxId: settings.software_provider_tax_id ?? company.tax_id },
      issuer: {
        taxId: company.tax_id, legalName: company.legal_name, taxResponsibilities: settings.issuer_tax_responsibilities, taxScheme: settings.issuer_tax_scheme,
        countryCode: company.country_code, ...field("tradeName", company.trade_name), ...field("departmentCode", settings.issuer_department_code),
        ...field("municipalityCode", settings.issuer_municipality_code), ...field("addressLine", company.address_line), ...field("phoneCc", company.phone_cc), ...field("phone", company.phone),
      },
      customer: {
        personType: customer.person_type, documentType: customer.document_type, documentNumber: customer.document_number, checkDigit: customer.check_digit ?? null,
        legalName: customer.legal_name ?? customer.document_number, taxResponsibilities: customer.tax_responsibilities ?? [], taxScheme: customer.tax_scheme ?? "ZZ",
        countryCode: customer.country_code ?? company.country_code, ...field("tradeName", customer.trade_name), ...field("departmentCode", customer.department_code),
        ...field("municipalityCode", customer.municipality_code), ...field("addressLine", customer.address_line), ...field("postalCode", customer.postal_code),
        ...field("invoiceEmail", customer.invoice_email), ...field("phoneCc", customer.phone_cc), ...field("phone", customer.phone),
      },
    },
  };
}

/** The document currency and, in another currency than the company's, its TRM (the invoice's exchange-rate snapshot) on the invoice's date. */
const currencyOf = (currency: string, companyCurrency: string, rate: string, date: string) =>
  currency === companyCurrency ? { currency } : { currency, exchangeRate: { rate: num(rate), date } };

const linesSql = "product_id, qty::text, unit_price::text, discount::text, base::text, iva_rate, iva::text, inc_rate, inc::text, other_taxes::text, total::text, free_sample, description";

async function invoiceDocument(ctx: ProcessContext, s: SubmissionRow) {
  const invoice = await readInvoice(ctx, s.invoice_id);
  if (!invoice.number || !invoice.cufe) return fail("invoice_not_issued", `La factura ${label(invoice)} no está emitida`);
  const { einvoice } = await packOf(ctx);
  if (!einvoice.documentCurrencies.includes(invoice.currency)) {
    return fail("currency_not_supported", `La factura ${label(invoice)} está en ${invoice.currency}: el documento electrónico solo lleva las monedas de la tabla del país`);
  }
  const [issued] = await ctx.tx<{ issue_time: string; resolution: Resolution | null; is_export: boolean; dian_environment: "habilitacion" | "produccion" | null }[]>`
    select issue_time, resolution, is_export, dian_environment from invoicing.invoices where id = ${invoice.id}`;
  const name = `la factura ${label(invoice)}`;
  const frame = await documentFrame(ctx, invoice.party_id, { type: "invoice", resolution: issued!.resolution, name, environment: issued!.dian_environment });
  if (!frame.ok) return frame;
  const lines = await ctx.tx.unsafe(`select ${linesSql} from invoicing.invoice_lines where invoice_id = $1 order by line_no`, [invoice.id]) as FrozenLine[];
  const taxes = await ctx.tx<FrozenTax[]>`select family, code, rate::text, base::text, amount::text from invoicing.invoice_taxes where invoice_id = ${invoice.id} order by family, code, rate`;
  const parts = await frozenParts(ctx, name, lines, taxes, invoice);
  if (!parts.ok) return parts;
  return {
    ok: true,
    kind: "invoice",
    currency: invoice.currency,
    cufe: invoice.cufe,
    testSetId: frame.testSetId,
    round: s.round,
    document: {
      ...frame.frame,
      number: invoice.number,
      issueDate: invoice.issue_date,
      issueTime: issued!.issue_time,
      paymentForm: invoice.payment_form,
      paymentMeansCode: invoice.payment_means,
      ...(invoice.due_date ? { dueDate: invoice.due_date } : {}),
      ...currencyOf(invoice.currency, frame.companyCurrency, invoice.exchange_rate, invoice.issue_date),
      // As issued: whether it is an export was frozen at «Emitir» (fix round 1), never today's buyer.
      export: issued!.is_export,
      lines: parts.lines,
      taxed: parts.taxed,
    },
  };
}

async function noteDocument(ctx: ProcessContext, s: SubmissionRow) {
  const note = await readNote(ctx, s.note_id!);
  if (note.stage !== "issued" || !note.number || !note.issue_time) return fail("note_not_issued", `La nota ${noteLabel(note)} no está emitida`);
  const invoice = await readInvoice(ctx, note.invoice_id);
  const [issued] = await ctx.tx<{ resolution: Resolution | null; dian_environment: "habilitacion" | "produccion" | null }[]>`select resolution, dian_environment from invoicing.notes where id = ${note.id}`;
  const [frozen] = await ctx.tx<{ is_export: boolean }[]>`select is_export from invoicing.invoices where id = ${invoice.id}`;
  const name = `la nota ${noteLabel(note)}`;
  const frame = await documentFrame(ctx, note.party_id, { type: note.kind === "credit" ? "credit_note" : "debit_note", resolution: issued!.resolution, name, environment: issued!.dian_environment });
  if (!frame.ok) return frame;
  const lines = await ctx.tx.unsafe(`select ${linesSql} from invoicing.note_lines where note_id = $1 order by line_no`, [note.id]) as FrozenLine[];
  const taxes = await ctx.tx<FrozenTax[]>`select family, code, rate::text, base::text, amount::text from invoicing.note_taxes where note_id = ${note.id} order by family, code, rate`;
  const parts = await frozenParts(ctx, name, lines, taxes, note);
  if (!parts.ok) return parts;
  return {
    ok: true,
    kind: "note",
    currency: note.currency,
    // The CUDE of an earlier sending (null on the first: the workflow computes it with the software PIN).
    cufe: s.cufe,
    testSetId: frame.testSetId,
    round: s.round,
    document: {
      ...frame.frame,
      number: note.number,
      issueDate: note.issue_date,
      issueTime: note.issue_time,
      paymentForm: invoice.payment_form,
      paymentMeansCode: invoice.payment_means,
      ...(note.due_date ? { dueDate: note.due_date } : {}),
      // In the invoice's currency with its TRM (an export's annulment note too, CreditNoteTypeCode 02 by the pack).
      ...currencyOf(note.currency, frame.companyCurrency, note.exchange_rate, invoice.issue_date),
      lines: parts.lines,
      taxed: parts.taxed,
      kind: note.kind,
      concept: note.concept,
      // The invoice was issued as an export (frozen at its «Emitir», fix round 1): the note follows the export rules (the pack's builder).
      export: frozen!.is_export,
      reference: { number: invoice.number!, code: invoice.cufe!, issueDate: invoice.issue_date, export: frozen!.is_export },
    },
  };
}

/** The secret-free parts of the document the workflow builds (the software PIN is added by the workflow from the secret store). */
export const submissionDocument = defineProcess({
  id: "invoicing.einvoice_submission.document",
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  description:
    "Lee una factura o una nota emitida como la lleva el documento electrónico (cliente, productos, impuestos, moneda y TRM, resolución y software); solo lo ejecuta el flujo de envío a la DIAN",
  input: z.object({ id }).strict(),
  output: z.looseObject({ ok: z.boolean() }),
  handler: async (ctx, { id: submissionId }) => {
    const s = await submissionById(ctx, submissionId);
    return s.note_id ? noteDocument(ctx, s) : invoiceDocument(ctx, s);
  },
});

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

const verdictInput = z.object({
  id,
  submissionId: id,
  runId,
  status: z.enum(["accepted", "rejected"]),
  errors: z.array(z.string().max(2000)).max(200),
  xmlPath: z.string().min(1).max(500),
  responsePath: z.string().min(1).max(500).nullable().optional(),
}).strict();

/** Records the verdict on the submission; answers null when it is a replay of the step that already recorded it. */
async function recordSubmissionVerdict(ctx: ProcessContext, s: SubmissionRow, input: z.output<typeof verdictInput>, name: string): Promise<SubmissionRow | null> {
  if (s.status === input.status && s.run_id === input.runId) return null;
  if (s.run_id !== input.runId || s.status !== "submitted") refuseState("einvoice_not_awaiting", [`El envío de ${name} no espera una respuesta de la DIAN`]);
  const [row] = await ctx.tx<SubmissionRow[]>`
    update invoicing.einvoice_submissions set status = ${input.status}, errors = ${ctx.tx.json(input.errors)}, decided_at = now(),
           xml_path = ${input.xmlPath}, response_path = ${input.responsePath ?? null}, last_error = null
    where id = ${s.id} returning *`;
  return row!;
}

export const invoiceDianResult = defineProcess({
  id: "invoicing.invoice.dian_result",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  emits: [INVOICE_ACCEPTED, INVOICE_REJECTED],
  description:
    "Registra la respuesta de la DIAN a una factura enviada (aceptada o rechazada, con sus errores y los archivos guardados) y avisa a los demás módulos; solo lo ejecuta el flujo de envío",
  input: verdictInput,
  output: z.object({ id: z.string(), dianStatus: z.string(), submission: submissionOutput }),
  handler: async (ctx, input) => {
    const invoice = await readInvoice(ctx, input.id, true);
    const s = await submissionById(ctx, input.submissionId, true);
    if (s.invoice_id !== invoice.id || s.note_id) throw new ProcessError("invalid_input", "the submission is not the invoice's");
    // The step that records the verdict may run again: the verdict already recorded is its answer.
    const row = await recordSubmissionVerdict(ctx, s, input, `la factura ${label(invoice)}`);
    if (!row) return { id: invoice.id, dianStatus: invoice.dian_status, submission: out(s) };
    await ctx.tx`update invoicing.invoices set dian_status = ${input.status} where id = ${invoice.id}`;
    const payload = { invoiceId: invoice.id, number: invoice.number, cufe: invoice.cufe, partyId: invoice.party_id, trackId: s.track_id, round: s.round, ...(input.status === "rejected" ? { errors: input.errors } : {}) };
    await ctx.emit(input.status === "accepted" ? INVOICE_ACCEPTED : INVOICE_REJECTED, payload);
    return { id: invoice.id, dianStatus: input.status, submission: out(row) };
  },
});

export const noteDianResult = defineProcess({
  id: "invoicing.note.dian_result",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  emits: [NOTE_ACCEPTED, NOTE_REJECTED, INVOICE_ANNULLED],
  description:
    "Registra la respuesta de la DIAN a una nota enviada (aceptada o rechazada, con sus errores y los archivos guardados); la nota de anulación aceptada anula su factura. Solo lo ejecuta el flujo de envío",
  input: verdictInput,
  output: z.object({ id: z.string(), dianStatus: z.string(), invoiceVoided: z.boolean(), submission: submissionOutput }),
  handler: async (ctx, input) => {
    const note = await readNote(ctx, input.id, true);
    const s = await submissionById(ctx, input.submissionId, true);
    if (s.note_id !== note.id) throw new ProcessError("invalid_input", "the submission is not the note's");
    const row = await recordSubmissionVerdict(ctx, s, input, `la nota ${noteLabel(note)}`);
    if (!row) return { id: note.id, dianStatus: note.dian_status, invoiceVoided: false, submission: out(s) };
    await ctx.tx`update invoicing.notes set dian_status = ${input.status} where id = ${note.id}`;
    let invoiceVoided = false;
    if (input.status === "accepted" && note.annulment) {
      // OD-7: the DIAN accepted the annulment: the invoice is voided and names its note, in ONE statement (invoices_voided_has_note). Its
      // number stays (never reused). No invoicing.invoice.voided: the note's own entry already reversed the invoice's.
      const [voided] = await ctx.tx<{ id: string; number: string | null }[]>`
        update invoicing.invoices set stage = 'voided', annulment_note_id = ${note.id} where id = ${note.invoice_id} and stage = 'issued' returning id, number`;
      // The invoice is no longer issued (paid meanwhile: Task 21 refuses a payment while an annulment is pending): never a silent skip.
      // The verdict is not recorded; the sending stops with this error for someone to look at.
      if (!voided) {
        const [now] = await ctx.tx<{ number: string | null; stage: string }[]>`select number, stage from invoicing.invoices where id = ${note.invoice_id}`;
        refuseState("annulment_invoice_not_issued", [`La DIAN aceptó la nota de anulación ${noteLabel(note)}, pero la factura ${now?.number ?? note.invoice_id} ya no está emitida (${now?.stage ?? "no existe"}): revísala con soporte`]);
      }
      invoiceVoided = true;
      // The void keeps the invoice's links, marked (Task 31).
      await markInvoiceLinksVoided(ctx, voided!.id, `Anulada por la nota ${noteLabel(note)}`);
      const lines = await ctx.tx<{ order_id: string | null; delivery_id: string | null }[]>`select order_id, delivery_id from invoicing.invoice_lines where invoice_id = ${voided!.id}`;
      await ctx.emit(INVOICE_ANNULLED, {
        invoiceId: voided!.id, number: voided!.number, noteId: note.id, noteNumber: note.number, partyId: note.party_id,
        orderIds: [...new Set(lines.flatMap((l) => (l.order_id ? [l.order_id] : [])))],
        deliveryIds: [...new Set(lines.flatMap((l) => (l.delivery_id ? [l.delivery_id] : [])))],
      });
    }
    const [fresh] = await ctx.tx<{ cude: string | null }[]>`select cude from invoicing.notes where id = ${note.id}`;
    const payload = {
      noteId: note.id, invoiceId: note.invoice_id, kind: note.kind, annulment: note.annulment, number: note.number, cude: fresh!.cude, partyId: note.party_id,
      trackId: s.track_id, round: s.round, ...(input.status === "rejected" ? { errors: input.errors } : {}),
    };
    await ctx.emit(input.status === "accepted" ? NOTE_ACCEPTED : NOTE_REJECTED, payload);
    return { id: note.id, dianStatus: input.status, invoiceVoided, submission: out(row) };
  },
});

// ---------------------------------------------------------------------------------------------
// «Reintentar envío»
// ---------------------------------------------------------------------------------------------

/** Queues a submission again: a new round of a rejected document, or the same round resumed (what was sent is polled, never sent again). */
async function requeue(ctx: ProcessContext, s: SubmissionRow, name: string): Promise<SubmissionRow> {
  if (s.status === "accepted") refuseState("einvoice_accepted", [`La DIAN ya aceptó ${name}`]);
  // A sending in flight is waited for; one whose run is no longer running (it stopped without recording why) is resumed like a failure.
  const stale = ["queued", "processing", "submitted"].includes(s.status) && s.run_id !== null && !["pending", "running"].includes(await infra.durableRunner().status(s.run_id));
  if (!stale && !["rejected", "failed", "not_configured"].includes(s.status)) refuseState("einvoice_in_progress", [`${name[0]!.toUpperCase()}${name.slice(1)} se está enviando a la DIAN: espera su respuesta`]);
  if (!(await softwareRegistered(ctx))) refuseState("einvoice_not_configured", [NOT_CONFIGURED]);
  const [row] = s.status === "rejected"
    // A new sending round of the corrected document: a new submit (no trackId yet), the same number and CUFE / CUDE.
    ? await ctx.tx<SubmissionRow[]>`
        update invoicing.einvoice_submissions set status = 'queued', run_id = null, round = round + 1, attempts = 0, polls = 0, track_id = null,
               decided_at = null, last_error = null where id = ${s.id} returning *`
    // The same round resumed: what was already sent (attempts, trackId) is polled, never sent again.
    : await ctx.tx<SubmissionRow[]>`update invoicing.einvoice_submissions set status = 'queued', run_id = null, last_error = null where id = ${s.id} returning *`;
  await ctx.emit(RESUBMIT_REQUESTED, { invoiceId: row!.invoice_id, ...(row!.note_id ? { noteId: row!.note_id } : {}), submissionId: row!.id });
  return row!;
}

async function resubmitInvoice(ctx: ProcessContext, invoiceId: string): Promise<SubmissionRow> {
  const invoice = await readInvoice(ctx, invoiceId, true);
  if (invoice.stage === "draft" || !invoice.cufe) refuseState("invoice_not_issued", [`La factura ${label(invoice)} no está emitida`]);
  if (invoice.stage === "voided") refuseState("invoice_voided", [`La factura ${label(invoice)} está anulada`]);
  let s = await submissionOf(ctx, { invoiceId }, true);
  if (!s) {
    // Issued before its submission was recorded (the event not yet delivered): the same row the consumer would write.
    [s] = await ctx.tx<SubmissionRow[]>`
      insert into invoicing.einvoice_submissions ${ctx.tx({ company_id: ctx.companyId, invoice_id: invoiceId, cufe: invoice.cufe, status: "not_configured", last_error: NOT_CONFIGURED })} returning *`;
  }
  return requeue(ctx, s!, `la factura ${label(invoice)}`);
}

export const invoiceResubmit = defineProcess({
  id: "invoicing.invoice.resubmit",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  emits: [RESUBMIT_REQUESTED],
  description:
    "Reintentar envío: envía de nuevo a la DIAN una factura rechazada, ya corregida, con el mismo número y CUFE, o retoma un envío que falló (lo ya enviado se consulta, no se envía dos veces)",
  input: z.object({ id }).strict(),
  output: z.object({ id: z.string(), submission: submissionOutput }),
  handler: async (ctx, { id: invoiceId }) => ({ id: invoiceId, submission: out(await resubmitInvoice(ctx, invoiceId)) }),
});

export const noteResubmit = defineProcess({
  id: "invoicing.note.resubmit",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  emits: [RESUBMIT_REQUESTED],
  description:
    "Reintentar envío de una nota: la envía de nuevo a la DIAN si fue rechazada (mismo número y CUDE) o retoma un envío que falló (lo ya enviado se consulta, no se envía dos veces)",
  input: z.object({ id }).strict(),
  output: z.object({ id: z.string(), submission: submissionOutput }),
  handler: async (ctx, { id: noteId }) => {
    const note = await readNote(ctx, noteId, true);
    if (note.stage !== "issued") refuseState("note_not_issued", [`La nota ${noteLabel(note)} no está emitida`]);
    const s = await submissionOf(ctx, { noteId }, true);
    if (!s) refuseState("note_not_sent", [`La nota ${noteLabel(note)} aún no tiene su envío a la DIAN: espera unos segundos`]);
    return { id: noteId, submission: out(await requeue(ctx, s, `la nota ${noteLabel(note)}`)) };
  },
});

/**
 * Bulk «Reintentar envío» (Task 18, carried from Task 17): every issued (or paid: still a DIAN document to send) invoice and every issued
 * note whose DIAN sending stopped (failed; `only:
 * "currency_not_supported"` narrows it to the foreign-currency invoices Task 17 could not send) is queued again, oldest first. The same
 * requeue as one «Reintentar envío»: a document already sent is polled, never sent twice.
 */
export const invoiceResubmitFailed = defineProcess({
  id: "invoicing.invoice.resubmit_failed",
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  emits: [RESUBMIT_REQUESTED],
  description:
    "Reintentar todos: vuelve a enviar a la DIAN todas las facturas (emitidas o pagadas) y notas emitidas cuyo envío se detuvo o que esperaban el registro del software (o solo las detenidas por su moneda, o solo las que esperaban el software), sin reenviar lo que la DIAN ya recibió",
  input: z.object({ only: z.enum(["currency_not_supported", "not_configured"]).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
  output: z.object({ requeued: z.array(z.object({ invoiceId: z.string(), noteId: z.string().nullable(), submissionId: z.string() })) }),
  handler: async (ctx, { only, limit }) => {
    if (!(await softwareRegistered(ctx))) refuseState("einvoice_not_configured", [NOT_CONFIGURED]);
    const stuck = await ctx.tx<SubmissionRow[]>`
      select s.* from invoicing.einvoice_submissions s
      join invoicing.invoices i on i.id = s.invoice_id
      left join invoicing.notes n on n.id = s.note_id
      where s.company_id = ${ctx.companyId}
        and (case when s.note_id is null then i.stage in ('issued', 'paid') else n.stage = 'issued' end)
        and (case ${only ?? "all"}::text
               when 'not_configured' then s.status = 'not_configured'
               when 'all' then s.status in ('failed', 'not_configured')
               else s.status = 'failed' and s.last_error like ${`${only ?? ""}%`} end)
      order by s.seq
      limit ${limit ?? 100}
      for update of s`;
    const requeued = [];
    for (const s of stuck) {
      const row = await requeue(ctx, s, s.note_id ? "la nota" : "la factura");
      requeued.push({ invoiceId: row.invoice_id, noteId: row.note_id, submissionId: row.id });
    }
    return { requeued };
  },
});

/**
 * The PDF of an accepted document (Task 19; Task 17's pdf_path slot): its template (the company's default, else the module's: CUFE / CUDE,
 * the QR of the DIAN's query, the resolution legend), printed as of the verdict's instant (decided_at: the same bytes on a retry), kept in
 * the file store next to the round's XML and named on the submission ONCE (migration 0101 refuses a second path). A submission that has its
 * PDF answers it (a retried step); a file already kept (a crash between the write and the row) is the one named.
 */
export const submissionStorePdf = defineProcess({
  id: "invoicing.einvoice_submission.store_pdf",
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  description: "Guarda el PDF (representación gráfica con CUFE, código QR y leyenda de la resolución) de una factura o nota aceptada por la DIAN; solo lo ejecuta el flujo de envío",
  input: z.object({ id }).strict(),
  output: z.object({ id: z.string(), pdfPath: z.string(), stored: z.boolean() }),
  handler: async (ctx, { id: submissionId }) => {
    const [s] = await ctx.tx<{ id: string; invoice_id: string; note_id: string | null; status: string; round: number; pdf_path: string | null; decided_at: Date | null }[]>`
      select id, invoice_id, note_id, status, round, pdf_path, decided_at from invoicing.einvoice_submissions where id = ${submissionId} for update`;
    if (!s) throw new ProcessError("not_found", `einvoice submission ${submissionId} not found`);
    if (s.pdf_path) return { id: s.id, pdfPath: s.pdf_path, stored: false };
    if (s.status !== "accepted") refuseState("einvoice_not_accepted", ["Solo el documento que la DIAN aceptó guarda su representación gráfica"]);
    const note = s.note_id !== null;
    const [doc] = note
      ? await ctx.tx<{ number: string | null; kind: string }[]>`select number, kind from invoicing.notes where id = ${s.note_id}`
      : await ctx.tx<{ number: string | null; kind: string }[]>`select number, 'invoice' as kind from invoicing.invoices where id = ${s.invoice_id}`;
    const t = translatorFor(ctx.locale);
    const title = t(note ? (doc!.kind === "debit" ? "invoicing.print.title_debit" : "invoicing.print.title_credit") : "invoicing.print.title_invoice");
    const printed = await renderPrint(ctx, { entity: note ? "invoicing.note" : "invoicing.invoice", recordId: note ? s.note_id! : s.invoice_id, ...(title ? { title } : {}) }, t, { printedAt: s.decided_at ?? new Date() });
    const base = note ? `einvoice/${ctx.companyId}/${s.invoice_id}/notas/${s.note_id}/envio-${s.round}` : `einvoice/${ctx.companyId}/${s.invoice_id}/envio-${s.round}`;
    const pdfPath = `${base}/${note ? "nota" : "factura"}-${doc!.number}.pdf`;
    const store = await fileStore();
    try {
      await store.put(pdfPath, printed.pdf, "application/pdf");
    } catch (error) {
      // Kept by an earlier attempt whose row was not written: that file is the document's PDF (the store never overwrites).
      const kept = await store.get(pdfPath).then(() => true, () => false);
      if (!kept) throw error;
    }
    await ctx.tx`update invoicing.einvoice_submissions set pdf_path = ${pdfPath} where id = ${s.id}`;
    return { id: s.id, pdfPath, stored: true };
  },
});

export const submissionConsult = defineProcess({
  id: "invoicing.einvoice_submission.consult",
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_INVOICES,
  description: "Consulta el envío a la DIAN de una factura o una nota: estado, número de seguimiento, intentos y errores, con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: rowId }) => {
    const [row] = await ctx.tx`select * from invoicing.v_einvoice_submissions where id = ${rowId}`;
    if (!row) throw new ProcessError("not_found", `invoicing.einvoice_submission ${rowId} not found`);
    return { ...row, id: rowId };
  },
});

/** Starts the e-invoice workflow of a queued submission (rule 6: through the DurableRunner). */
async function startRun(ctx: Parameters<EventConsumer>[0], what: { invoiceId: string; noteId?: string | undefined }): Promise<void> {
  const requested = (await ctx.runProcess(submissionRequest.id, what.noteId ? { noteId: what.noteId } : { invoiceId: what.invoiceId })) as { submissionId: string; start: boolean };
  if (!requested.start) return;
  await infra.durableRunner().start(einvoiceSubmission, [{
    companyId: ctx.companyId, invoiceId: what.invoiceId, ...(what.noteId ? { noteId: what.noteId } : {}), submissionId: requested.submissionId, chainId: ctx.chainId,
  }]);
}

/** invoicing.invoice.issued: one submission per invoice, and its workflow run. */
export const onInvoiceIssued: EventConsumer = async (ctx, payload) => {
  const { invoiceId } = z.object({ invoiceId: id }).loose().parse(payload);
  await startRun(ctx, { invoiceId });
};

/** invoicing.note.issued: one submission per note, and its workflow run. */
export const onNoteIssued: EventConsumer = async (ctx, payload) => {
  const { invoiceId, noteId } = z.object({ invoiceId: id, noteId: id }).loose().parse(payload);
  await startRun(ctx, { invoiceId, noteId });
};

/** invoicing.invoice.resubmit_requested («Reintentar envío»): the run of the queued submission. */
export const onResubmitRequested: EventConsumer = async (ctx, payload) => {
  const { invoiceId, noteId } = z.object({ invoiceId: id, noteId: id.optional() }).loose().parse(payload);
  await startRun(ctx, { invoiceId, noteId });
};

export const EINVOICE_PROCESSES = [
  submissionRequest, submissionRecord, submissionDocument, invoiceDianResult, noteDianResult, invoiceResubmit, noteResubmit, invoiceResubmitFailed, submissionConsult, submissionStorePdf,
];
