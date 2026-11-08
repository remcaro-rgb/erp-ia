import { defineProcess, emitAndPostStrict, ProcessError, runLifecycle, type ProcessContext, type TaxLineInput, type TypedHooks, type TypedRecord } from "@erp/kernel";
import { z } from "zod";
import { NOTE_KINDS, noteEntity, type NoteKind } from "../entities";
import { readInvoiceFacts } from "../readiness";
import {
  assertDianAccepted, companyAmounts, DOCUMENT_ENVIRONMENT_MISSING, FEATURE_INVOICES, id, money, num, packOf, qty, refuse, refuseState, round2, round4, settingsOf, today,
} from "./common";
import { INVOICE_PAID, refreshPaid } from "../consumers/payments";
import { ANNULMENT_PROCESS, assertNoPayments, label, readInvoice, type InvoiceRow } from "./invoice";

// Notas crédito y débito de venta (plan 2B Task 18; design §8, §8.1; OD-7 of §22.25). A documento that posts (contabiliza) and never waits
// for approval (own flags), numbered by its own sequence (credit_note / debit_note, core.next_document_number) on «Emitir».
//
// A note corrects ONE issued invoice the DIAN accepted (its CUFE is what the note's BillingReference carries; common.assertDianAccepted
// refuses anything else with what to do), never another note (Oficio DIAN 129 of 2023: a note referencing a note is refused,
// `note_references_note`). Its concept is a code of the pack's correction tables (13.2.4 credit, 13.2.5 debit); the annulment concept (2)
// is only the note of an Anular of the invoice.
//
//  - invoicing.note.create (Borrador): the lines name lines of the invoice (its product, a quantity and a net unit price, by default the
//    invoice line's) and are taxed by the country pack (rule 5) at the invoice line's rates on the invoice's date (what the invoice was
//    taxed with). A line with additional taxes or a free sample is corrected only by the annulment (their per-line split is not kept).
//  - invoicing.note.issue («Emitir», the Grabar of the Borrador, typed lifecycle): under the invoice's lock (FOR UPDATE: two notes of the
//    same invoice count each other) a credit never exceeds what is left of the invoice (total + debits − credits); the note is dated on
//    the company's today (DIAN: the issue date is the date it is generated) and so posts in ITS OWN month, never in the invoice's (accounting
//    §5.5: a closed month of the invoice is not touched); numbered; and posted inline and strict (invoicing.note.issued, the note-issued
//    rule: a credit's amounts are negative, so its entry is Dr revenue / Dr IVA / Cr receivable). The invoice's credited (debited) amount
//    grows by the note's total in the same statement. Its DIAN submission follows (einvoice.ts: one per note, the CUDE computed there).
//  - invoicing.note.issue_annulment: ONLY nested in invoicing.invoice.void (whose step-up covers it; ProcessDef.nestedOnlyFrom), not step-up
//    itself: the FULL credit note of the invoice (every line and tax copied as issued), concept 2, CustomizationID 20, referencing the
//    invoice's CUFE. The invoice stays issued until the DIAN accepts the note (einvoice.ts, invoicing.note.dian_result: stage voided and
//    annulment_note_id in one statement, and invoicing.invoice.annulled for sales). One annulment per invoice (a partial unique index).
//  - invoicing.note.void: refused (a DIAN note is not voided: another note corrects it). A Borrador is deleted (Eliminar).
// Partial credit notes do not change what sales counts as invoiced (invoiced_qty): only the annulment, once accepted, gives the entregas back.
// Payments (Task 23): a credit note is limited by what is left of the invoice (total + debits − credits), never by what receipts paid of it:
// a credit note on a paid invoice is legitimate (a refund); what it credits beyond what was open is the customer's credit balance, and what
// is open of the invoice never goes below zero. Issuing a note recomputes the paid status (consumers/payments.ts). The annulment is refused
// while a posted receipt settles the invoice (void the receipt first).

export const NOTE_ISSUED = "invoicing.note.issued";

/** What Grabar may change of a note (its lines and concept are fixed at creation: a Borrador is deleted and written again). */
const WRITABLE = ["notes", "extra", "extra_free"];

export const noteOutput = z.object({
  id: z.string(),
  kind: z.enum(NOTE_KINDS),
  number: z.string().nullable(),
  cude: z.string().nullable(),
  invoiceId: z.string(),
  partyId: z.string(),
  concept: z.string(),
  annulment: z.boolean(),
  reason: z.string(),
  status: z.string(),
  stage: z.string(),
  dianStatus: z.string(),
  issueDate: z.string(),
  currency: z.string(),
  subtotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
  issuedAt: z.string().nullable(),
});
export type NoteOutput = z.output<typeof noteOutput>;

export interface NoteRow {
  id: string; kind: NoteKind; number: string | null; cude: string | null; invoice_id: string; party_id: string; concept: string; annulment: boolean;
  reason: string; status: string; stage: "draft" | "issued"; dian_status: string; issue_date: string; issue_time: string | null; due_date: string | null;
  currency: string; exchange_rate: string; subtotal: string; tax_total: string; total: string; cost_center_id: string | null; issued_at: string | null;
}

export async function readNote(ctx: ProcessContext, noteId: string, lock = false): Promise<NoteRow> {
  const rows = await ctx.tx.unsafe<NoteRow[]>(
    `select id, kind, number, cude, invoice_id, party_id, concept, annulment, reason, status, stage, dian_status, issue_date::text, issue_time, due_date::text,
            currency, exchange_rate::text, subtotal::text, tax_total::text, total::text, cost_center_id,
            to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at
     from invoicing.notes where id = $1${lock ? " for update" : ""}`,
    [noteId],
  );
  if (!rows[0]) throw new ProcessError("not_found", `note ${noteId} not found`);
  return rows[0];
}

export const noteLabel = (row: { number: string | null; id: string }) => row.number ?? row.id;

export async function noteOutputOf(ctx: ProcessContext, noteId: string): Promise<NoteOutput> {
  const n = await readNote(ctx, noteId);
  return {
    id: n.id, kind: n.kind, number: n.number, cude: n.cude, invoiceId: n.invoice_id, partyId: n.party_id, concept: n.concept, annulment: n.annulment, reason: n.reason,
    status: n.status, stage: n.stage, dianStatus: n.dian_status, issueDate: n.issue_date, currency: n.currency, subtotal: num(n.subtotal), taxTotal: num(n.tax_total),
    total: num(n.total), issuedAt: n.issued_at,
  };
}

/**
 * The invoice a note corrects, locked (FOR UPDATE): issued, not voided, without an annulment note (pending or accepted: fix round 1) and
 * accepted by the DIAN. An id that names a note is refused (note_references_note): a note corrects an invoice, never another note.
 * `self`: the note being issued (an annulment note does not count against itself).
 */
async function invoiceToCorrect(ctx: ProcessContext, invoiceId: string, self?: string): Promise<InvoiceRow> {
  const [found] = await ctx.tx<{ id: string }[]>`select id from invoicing.invoices where id = ${invoiceId}`;
  if (!found) {
    const [note] = await ctx.tx<{ number: string | null }[]>`select number from invoicing.notes where id = ${invoiceId}`;
    if (note) refuse("note_references_note", [`Una nota corrige una factura, no otra nota (${note.number ?? invoiceId}): indica la factura de venta`]);
    throw new ProcessError("not_found", `invoice ${invoiceId} not found`);
  }
  const invoice = await readInvoice(ctx, invoiceId, true);
  if (invoice.stage === "draft") refuseState("invoice_not_issued", [`La factura ${label(invoice)} es un borrador: se corrige antes de emitirla, sin nota`]);
  if (invoice.stage === "voided") refuseState("invoice_voided", [`La factura ${label(invoice)} está anulada: no admite más notas`]);
  // Its annulment note exists (on its way to the DIAN, or rejected and to be sent again): the invoice takes no other note.
  const [annulment] = await ctx.tx<{ number: string | null }[]>`
    select number from invoicing.notes where invoice_id = ${invoiceId} and annulment and id is distinct from ${self ?? null}::uuid`;
  if (annulment) {
    refuseState("invoice_has_note", [`La factura ${label(invoice)} tiene su nota de anulación${annulment.number ? ` (${annulment.number})` : ""}: no admite otras notas`]);
  }
  await assertDianAccepted(ctx, invoice);
  return invoice;
}

/** What is left of the invoice a credit can take: its total plus its debits less its credits. */
const remainingOf = (invoice: InvoiceRow) => round2(num(invoice.total) + num(invoice.debited_amount) - num(invoice.credited_amount));

interface InvoiceLineRow {
  id: string; line_no: number; product_id: string; description: string | null; qty: string; unit_price: string; discount: string; base: string; iva_rate: string | null;
  iva: string; inc_rate: string | null; inc: string; other_taxes: string; total: string; free_sample: boolean; category_id: string | null;
}

const invoiceLinesOf = (ctx: ProcessContext, invoiceId: string) => ctx.tx<InvoiceLineRow[]>`
  select id, line_no, product_id, description, qty::text, unit_price::text, discount::text, base::text, iva_rate, iva::text, inc_rate, inc::text, other_taxes::text,
         total::text, free_sample, category_id
  from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`;

const IVA_RATES = ["19", "5", "0", "EXC"] as const;
const INC_RATES = ["2", "4", "8", "16"] as const;

export const noteLineInput = z.object({
  /** The line of the invoice this line corrects. */
  invoiceLineId: id,
  qty,
  /** The net unit price corrected (absent: the invoice line's, net of its discount). */
  unitPrice: money.optional(),
  description: z.string().trim().min(1).max(300).optional(),
}).strict();

interface NoteParts {
  lines: Record<string, unknown>[];
  taxes: { family: "IVA" | "INC" | "OTHER"; code: string; ledger_code: string; rate: number | null; base: number; amount: number }[];
  subtotal: number;
  taxTotal: number;
  total: number;
}

/**
 * What the OTHER credit notes of the invoice (issued and Borrador, fix round 1) already credit of each of its lines, in quantity and value.
 * Read under the invoice's lock, which every note of the invoice takes first: two credits of the same line count each other.
 */
async function creditedByLine(ctx: ProcessContext, invoiceId: string, self: string | null): Promise<Map<string, { qty: number; base: number }>> {
  const rows = await ctx.tx<{ invoice_line_id: string; qty: string; base: string }[]>`
    select nl.invoice_line_id, sum(nl.qty)::text as qty, sum(nl.base)::text as base
    from invoicing.note_lines nl join invoicing.notes n on n.id = nl.note_id
    where n.invoice_id = ${invoiceId} and n.kind = 'credit' and not n.annulment and n.id is distinct from ${self}::uuid
    group by nl.invoice_line_id`;
  return new Map(rows.map((r) => [r.invoice_line_id, { qty: num(r.qty), base: num(r.base) }]));
}

/**
 * A credit never takes more of an invoice line than was invoiced, counting what the other credit notes take (`credited`): in quantity and
 * in value (its base). Problems are added to `problems`.
 */
function checkLineCredit(problems: string[], at: string, line: InvoiceLineRow, credited: { qty: number; base: number } | undefined, qtyAsked: number, baseAsked: number): void {
  const prior = credited ?? { qty: 0, base: 0 };
  const qtyLeft = round4(num(line.qty) - prior.qty);
  const baseLeft = round2(num(line.base) - prior.base);
  if (qtyAsked > qtyLeft) {
    problems.push(`${at}: de la línea ${line.line_no} de la factura quedan ${qtyLeft} unidades por acreditar${prior.qty > 0 ? ` (otras notas crédito ya toman ${prior.qty})` : ""}`);
  } else if (round2(baseAsked) > baseLeft) {
    problems.push(`${at}: la nota no puede acreditar más que el valor que queda de la línea ${line.line_no} de la factura (${baseLeft})`);
  }
}

/** The lines of a partial note, taxed by the country pack at the rates of the invoice lines they correct, on the invoice's date (rule 5). */
async function priceNoteLines(ctx: ProcessContext, invoice: InvoiceRow, kind: NoteKind, input: z.output<typeof noteLineInput>[]): Promise<NoteParts> {
  const invoiceLines = new Map((await invoiceLinesOf(ctx, invoice.id)).map((l) => [l.id, l]));
  const credited = kind === "credit" ? await creditedByLine(ctx, invoice.id, null) : new Map<string, { qty: number; base: number }>();
  const problems: string[] = [];
  const seen = new Set<string>();
  const picked = input.map((l, i) => {
    const line = invoiceLines.get(l.invoiceLineId);
    const at = `Línea ${i + 1}`;
    if (!line) return problems.push(`${at}: la línea no es de la factura ${label(invoice)}`), null;
    if (seen.has(line.id)) return problems.push(`${at}: la línea ${line.line_no} de la factura ya está en la nota: una nota nombra cada línea una vez`), null;
    seen.add(line.id);
    if (line.free_sample) return problems.push(`${at}: la línea ${line.line_no} de la factura es una muestra gratis: no tiene valor que corregir`), null;
    if (num(line.other_taxes) > 0) return problems.push(`${at}: la línea ${line.line_no} de la factura lleva impuestos adicionales: se corrige anulando la factura`), null;
    const unitPrice = l.unitPrice ?? round4(num(line.base) / num(line.qty));
    if (kind === "credit") {
      const before = problems.length;
      checkLineCredit(problems, at, line, credited.get(line.id), l.qty, l.qty * unitPrice);
      if (problems.length > before) return null;
    }
    return { input: l, line, unitPrice };
  });
  if (problems.length > 0) refuse("invalid_note_line", problems);
  const lines = picked.map((p) => p!);
  const facts = await readInvoiceFacts(ctx, invoice.party_id, [...new Set(lines.map((p) => p.line.product_id))]);
  const { taxes } = await packOf(ctx);
  const taxLines: TaxLineInput[] = lines.map(({ input: l, line, unitPrice }) => {
    const ivaRate = (line.iva_rate ?? "EXC") as (typeof IVA_RATES)[number];
    if (!IVA_RATES.includes(ivaRate)) refuse("invalid_note_line", [`La línea ${line.line_no} de la factura tiene una tarifa de IVA que el paquete del país no conoce`]);
    const incRate = line.inc_rate as (typeof INC_RATES)[number] | null;
    return {
      quantity: l.qty,
      unitPrice,
      discount: 0,
      kind: facts.products.get(line.product_id)?.kind ?? "good",
      ivaRate,
      ...(incRate && INC_RATES.includes(incRate) ? { incRate } : {}),
    };
  });
  const taxed = taxes.computeTaxes({
    lines: taxLines,
    party: { responsibilities: facts.party.responsibilities, ...(facts.party.personType ? { personType: facts.party.personType } : {}) },
    // The invoice's date: the rates it was taxed with.
    date: invoice.issue_date,
  });
  const ledgerCode = taxes.ledgerTaxCode ?? ((t: (typeof taxed.taxes)[number]) => t.code);
  return {
    lines: lines.map(({ input: l, line, unitPrice }, i) => {
      const t = taxed.lines[i]!;
      return {
        line_no: i + 1, invoice_line_id: line.id, product_id: line.product_id, description: l.description ?? line.description, qty: l.qty, unit_price: unitPrice,
        discount: 0, base: t.base, iva_rate: line.iva_rate, iva: t.iva, inc_rate: line.inc_rate, inc: t.inc, other_taxes: 0, total: t.payable, free_sample: false,
        category_id: line.category_id,
      };
    }),
    taxes: taxed.taxes.map((t) => ({ family: t.family, code: t.code, ledger_code: ledgerCode(t), rate: t.rate, base: t.base, amount: t.amount })),
    subtotal: taxed.subtotal,
    taxTotal: taxed.taxTotal,
    total: taxed.total,
  };
}

/** The full credit note of an annulment: every line and tax of the invoice as it was issued (nothing taxed again). */
async function annulmentParts(ctx: ProcessContext, invoice: InvoiceRow): Promise<NoteParts> {
  const lines = await invoiceLinesOf(ctx, invoice.id);
  const taxes = await ctx.tx<{ family: "IVA" | "INC" | "OTHER"; code: string; ledger_code: string; rate: string | null; base: string; amount: string }[]>`
    select family, code, ledger_code, rate::text, base::text, amount::text from invoicing.invoice_taxes where invoice_id = ${invoice.id} order by seq`;
  return {
    lines: lines.map((l) => ({
      line_no: l.line_no, invoice_line_id: l.id, product_id: l.product_id, description: l.description, qty: num(l.qty), unit_price: num(l.unit_price), discount: num(l.discount),
      base: num(l.base), iva_rate: l.iva_rate, iva: num(l.iva), inc_rate: l.inc_rate, inc: num(l.inc), other_taxes: num(l.other_taxes), total: num(l.total),
      free_sample: l.free_sample, category_id: l.category_id,
    })),
    taxes: taxes.map((t) => ({ family: t.family, code: t.code, ledger_code: t.ledger_code, rate: t.rate === null ? null : num(t.rate), base: num(t.base), amount: num(t.amount) })),
    subtotal: num(invoice.subtotal),
    taxTotal: num(invoice.tax_total),
    total: num(invoice.total),
  };
}

/** The concept of the kind's table (the pack's), never the annulment's (only an Anular of the invoice issues it). */
async function assertConcept(ctx: ProcessContext, kind: NoteKind, concept: string, annulment: boolean): Promise<void> {
  const { einvoice } = await packOf(ctx);
  const table = einvoice.noteConcepts[kind];
  if (!table.some((c) => c.code === concept)) {
    refuse("invalid_note_concept", [`El concepto ${concept} no es un concepto de corrección de nota ${kind === "credit" ? "crédito" : "débito"}: ${table.map((c) => `${c.code} ${c.name}`).join("; ")}`]);
  }
  if (kind === "credit" && concept === einvoice.annulmentConcept && !annulment) {
    refuse("annulment_by_void", ["La anulación de una factura se hace con «Anular» en la factura: emite la nota crédito de anulación completa"]);
  }
}

interface WriteNoteArgs { invoice: InvoiceRow; kind: NoteKind; concept: string; annulment: boolean; reason: string; notes?: string | undefined; parts: NoteParts }

/** Writes a Borrador note with its lines and taxes, dated today (the date «Emitir» confirms). */
async function writeNote(ctx: ProcessContext, args: WriteNoteArgs): Promise<string> {
  if (args.parts.lines.length === 0) refuse("nothing_to_note", ["La nota no tiene líneas"]);
  if (args.parts.total <= 0) refuse("nothing_to_note", ["La nota no tiene valor"]);
  const on = await today(ctx);
  const rate = num(args.invoice.exchange_rate);
  const [row] = await ctx.tx<{ id: string }[]>`
    insert into invoicing.notes ${ctx.tx({
      company_id: ctx.companyId,
      kind: args.kind,
      invoice_id: args.invoice.id,
      party_id: args.invoice.party_id,
      concept: args.concept,
      annulment: args.annulment,
      reason: args.reason,
      issue_date: on,
      due_date: on,
      currency: args.invoice.currency,
      exchange_rate: rate,
      subtotal: args.parts.subtotal,
      tax_total: args.parts.taxTotal,
      total: args.parts.total,
      total_company: companyAmounts(args.parts.lines as { base: number; free_sample: boolean }[], args.parts.taxes, rate).total,
      cost_center_id: args.invoice.cost_center_id,
      notes: args.notes ?? null,
      // A note never waits for approval and always posts (ownFlags): explicit, so the Parámetros switches never apply.
      requires_approval: false,
      posts: true,
    })} returning id`;
  await ctx.tx`insert into invoicing.note_lines ${ctx.tx(args.parts.lines.map((l) => ({ company_id: ctx.companyId, note_id: row!.id, ...l })))}`;
  if (args.parts.taxes.length > 0) {
    await ctx.tx`insert into invoicing.note_taxes ${ctx.tx(args.parts.taxes.map((t) => ({ company_id: ctx.companyId, note_id: row!.id, ...t })))}`;
  }
  return row!.id;
}

export const noteCreate = defineProcess({
  id: "invoicing.note.create",
  module: "invoicing",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  description:
    "Crea en borrador una nota crédito o débito de una factura emitida y aceptada por la DIAN: el concepto de corrección, el motivo y las líneas de la factura que corrige (cantidad y precio); los impuestos los calcula el paquete del país con las tarifas de la factura",
  input: z.object({
    invoiceId: id,
    kind: z.enum(NOTE_KINDS),
    /** A code of the pack's correction table of the kind (Colombia: 13.2.4 credit, 13.2.5 debit). */
    concept: z.string().trim().regex(/^[0-9]{1,2}$/),
    reason: z.string().trim().min(1, "Indica el motivo de la nota").max(500),
    lines: z.array(noteLineInput).min(1).max(500),
    notes: z.string().trim().max(2000).optional(),
  }).strict(),
  output: noteOutput,
  handler: async (ctx, input) => {
    await assertConcept(ctx, input.kind, input.concept, false);
    const invoice = await invoiceToCorrect(ctx, input.invoiceId);
    const parts = await priceNoteLines(ctx, invoice, input.kind, input.lines);
    if (input.kind === "credit" && round2(parts.total) > remainingOf(invoice)) {
      refuse("credit_exceeds_invoice", [`La nota crédito (${round2(parts.total)}) supera lo que queda de la factura ${label(invoice)} (${remainingOf(invoice)})`]);
    }
    const noteId = await writeNote(ctx, { invoice, kind: input.kind, concept: input.concept, annulment: false, reason: input.reason, notes: input.notes, parts });
    return noteOutputOf(ctx, noteId);
  },
});

export const noteIssue = defineProcess({
  id: "invoicing.note.issue",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  // A credit note that covers what was still owed makes the invoice paid (refreshPaid, Task 23).
  emits: [NOTE_ISSUED, INVOICE_PAID],
  description:
    "Emite una nota crédito o débito en borrador: revisa que la factura siga aceptada y que el crédito no supere lo que queda de ella, la fecha hoy, la numera y la contabiliza en su propio mes en la misma operación",
  input: z.object({
    id,
    /** One per «Emitir» the user asks for: a retry with the same key answers the first result. */
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
    notes: z.string().trim().max(2000).optional(),
  }).strict(),
  output: noteOutput,
  auditInput: (input) => ({ id: input.id }),
  idempotencyKey: (input) => (input.idempotencyKey ? `issue:${input.id}:${input.idempotencyKey}` : undefined),
  handler: async (ctx, { id: noteId, idempotencyKey, notes }) => {
    const note = await readNote(ctx, noteId, true);
    if (note.stage !== "draft") {
      if (idempotencyKey) {
        const [stored] = await ctx.tx<{ result: NoteOutput }[]>`
          select result from kernel.process_idempotency where company_id = ${ctx.companyId} and process_id = 'invoicing.note.issue' and key = ${`issue:${noteId}:${idempotencyKey}`}`;
        if (stored) return stored.result;
      }
      refuseState("note_issued", [`La nota ${noteLabel(note)} ya se emitió`]);
    }
    await runLifecycle(ctx, ctx.registry.entity(noteEntity.id), noteId, "save", notes === undefined ? {} : { data: { notes } });
    return noteOutputOf(ctx, noteId);
  },
});

export const noteIssueAnnulment = defineProcess({
  id: ANNULMENT_PROCESS,
  module: "invoicing",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  // Only inside Anular of the invoice (step-up there); never on its own, from the assistant or the admin's matrix.
  nestedOnlyFrom: ["invoicing.invoice.void"],
  emits: [NOTE_ISSUED],
  description:
    "Emite la nota crédito de anulación completa de una factura aceptada por la DIAN (concepto 2, con el CUFE de la factura); solo la ejecuta Anular de la factura",
  input: z.object({ invoiceId: id, reason: z.string().trim().min(1).max(500) }).strict(),
  output: noteOutput,
  handler: async (ctx, { invoiceId, reason }) => {
    const invoice = await invoiceToCorrect(ctx, invoiceId);
    // Under the invoice's lock: a second Anular waited for the first and finds its note (the partial unique index backs this).
    const [existing] = await ctx.tx<{ number: string | null }[]>`select number from invoicing.notes where invoice_id = ${invoiceId} and annulment`;
    if (existing || num(invoice.credited_amount) > 0 || num(invoice.debited_amount) > 0) {
      refuseState("invoice_has_note", [`La factura ${label(invoice)} ya tiene una nota${existing?.number ? ` (${existing.number})` : ""}: no se anula de nuevo`]);
    }
    // Under the same lock: no receipt settles it (Anular checked it too; this is the process that writes the note).
    await assertNoPayments(ctx, invoice);
    const { einvoice } = await packOf(ctx);
    const noteId = await writeNote(ctx, { invoice, kind: "credit", concept: einvoice.annulmentConcept, annulment: true, reason, parts: await annulmentParts(ctx, invoice) });
    await runLifecycle(ctx, ctx.registry.entity(noteEntity.id), noteId, "save");
    return noteOutputOf(ctx, noteId);
  },
});

export const noteVoid = defineProcess({
  id: "invoicing.note.void",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  description: "Una nota electrónica emitida no se anula: se corrige con otra nota. Una nota en borrador se elimina",
  input: z.object({ id, reason: z.string().trim().max(500).optional(), expectedUpdatedAt: z.string().optional() }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { id: noteId }) => {
    const note = await readNote(ctx, noteId, true);
    if (note.stage === "draft") refuseState("note_draft_delete", [`La nota ${noteLabel(note)} es un borrador: elimínala`]);
    refuseState("note_not_voidable", [`La nota ${noteLabel(note)} ya se emitió ante la DIAN: no se anula, se corrige con otra nota`]);
  },
});

export const noteConsult = defineProcess({
  id: "invoicing.note.consult",
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_INVOICES,
  description: "Consulta una nota crédito o débito con sus líneas, sus impuestos, su envío a la DIAN (estado y errores) y los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })), taxes: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: noteId }) => {
    const [row] = await ctx.tx`select * from invoicing.v_notes where id = ${noteId}`;
    if (!row) throw new ProcessError("not_found", `note ${noteId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from invoicing.v_note_lines where note_id = ${noteId} order by line_no`;
    const taxes = await ctx.tx<{ id: string }[]>`select * from invoicing.v_note_taxes where note_id = ${noteId} order by seq`;
    const [einvoice] = await ctx.tx`select * from invoicing.v_einvoice_submissions where note_id = ${noteId}`;
    return { ...row, id: noteId, lines, taxes, einvoice: einvoice ?? null };
  },
});

const consultOf = (entity: string, view: string, what: string) => defineProcess({
  id: `${entity}.consult`,
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_INVOICES,
  description: `Consulta ${what} con los campos que el rol puede ver`,
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: rowId }) => {
    const [row] = await ctx.tx.unsafe(`select * from invoicing.${view} where id = $1`, [rowId]);
    if (!row) throw new ProcessError("not_found", `${entity} ${rowId} not found`);
    return { ...row, id: rowId };
  },
});

export const noteLineConsult = consultOf("invoicing.note_line", "v_note_lines", "una línea de una nota");
export const noteTaxConsult = consultOf("invoicing.note_tax", "v_note_taxes", "un impuesto de una nota");

// ---------------------------------------------------------------------------------------------
// The typed hooks of the note: what «Emitir» checks, numbers and posts.
// ---------------------------------------------------------------------------------------------

const KIND_TEXT: Record<NoteKind, string> = { credit: "notas crédito", debit: "notas débito" };
const numberRefusal = (code: string, kind: NoteKind) =>
  ({
    out_of_range: `La numeración de ${KIND_TEXT[kind]} agotó su rango: registra una nueva`,
    expired: `La numeración de ${KIND_TEXT[kind]} está vencida para la fecha de la nota`,
    not_yet_valid: `La numeración de ${KIND_TEXT[kind]} aún no está vigente para la fecha de la nota`,
    no_resolution: `La empresa no tiene numeración de ${KIND_TEXT[kind]} registrada: regístrala en Core › Parámetros › Secuencias de documentos (prefijo y siguiente número)`,
    no_sequence: `La empresa no tiene numeración de ${KIND_TEXT[kind]} registrada: regístrala en Core › Parámetros › Secuencias de documentos (prefijo y siguiente número; las notas no llevan resolución DIAN)`,
  })[code] ?? code;

/** The issue time the CUDE and the XML carry (the invoice's rule: HH:mm:ss and the company's UTC offset). */
async function issueTime(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ t: string; off: number }[]>`
    select to_char(now() at time zone tz, 'HH24:MI:SS') as t,
           round(extract(epoch from ((now() at time zone tz) - (now() at time zone 'UTC'))) / 60)::int as off
    from (select coalesce(timezone, 'America/Bogota') as tz from kernel.companies where id = ${ctx.companyId}) c`;
  const off = row!.off;
  const abs = Math.abs(off);
  return `${row!.t}${off < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export const noteHooks: TypedHooks = {
  async validate(ctx, record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (data) {
      const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
      if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for invoicing.note.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    }
    if (previous.status !== "draft") return;
    const note = await readNote(ctx, record.id as string);
    // The invoice under its lock, as it stands now: still accepted, not voided, no annulment note but this one; what is left of it for a credit.
    const invoice = await invoiceToCorrect(ctx, note.invoice_id, note.id);
    if (note.kind === "credit" && round2(num(note.total)) > remainingOf(invoice)) {
      refuse("credit_exceeds_invoice", [`La nota crédito (${round2(num(note.total))}) supera lo que queda de la factura ${label(invoice)} (${remainingOf(invoice)})`]);
    }
    if (note.kind === "credit" && !note.annulment) {
      // Each line again, against the other credit notes as they stand under the lock (fix round 1).
      const credited = await creditedByLine(ctx, invoice.id, note.id);
      const invoiceLines = new Map((await invoiceLinesOf(ctx, invoice.id)).map((l) => [l.id, l]));
      const lines = await ctx.tx<{ line_no: number; invoice_line_id: string; qty: string; base: string }[]>`
        select line_no, invoice_line_id, qty::text, base::text from invoicing.note_lines where note_id = ${note.id} order by line_no`;
      const problems: string[] = [];
      for (const l of lines) checkLineCredit(problems, `Línea ${l.line_no}`, invoiceLines.get(l.invoice_line_id)!, credited.get(l.invoice_line_id), num(l.qty), num(l.base));
      if (problems.length > 0) refuse("invalid_note_line", problems);
    }
    // Dated today, the company's (DIAN: the date it is generated; accounting §5.5: it posts in its own month, never the invoice's).
    const on = await today(ctx);
    const due = invoice.due_date && invoice.due_date > on && note.kind === "debit" ? invoice.due_date : on;
    await ctx.tx`update invoicing.notes set issue_date = ${on}, due_date = ${due} where id = ${note.id}`;
  },
  async number(ctx, record: TypedRecord) {
    const note = await readNote(ctx, record.id as string);
    const { einvoice } = await packOf(ctx);
    const drawn = await einvoice.nextNumber(ctx.tx as never, ctx.companyId, note.kind === "credit" ? "credit_note" : "debit_note", note.issue_date);
    if (!drawn.ok) {
      const message = numberRefusal(drawn.code, note.kind);
      throw new ProcessError("invalid_input", `${drawn.code}: ${message}`, { details: [message, ...(drawn.resolution ? [JSON.stringify(drawn.resolution)] : [])] });
    }
    // The DIAN environment the note is issued in is frozen here (Task 19 fix round 1): its CUDE, its QR and its sending follow it. It is
    // its invoice's (fix round 2): a note corrects a document of that environment.
    const [frozen] = await ctx.tx<{ dian_environment: string | null }[]>`select dian_environment from invoicing.invoices where id = ${note.invoice_id}`;
    // Task 37 fix round 1 (M2): never the company's current one; an invoice without it (impossible by the check) refuses.
    const dianEnvironment = frozen?.dian_environment;
    if (!dianEnvironment) refuseState("document_environment_missing", [DOCUMENT_ENVIRONMENT_MISSING]);
    await ctx.tx`
      update invoicing.notes set number = ${drawn.full}, prefix = ${drawn.prefix}, consecutive = ${drawn.number}, issue_time = ${await issueTime(ctx)},
             resolution = ${drawn.resolution ? ctx.tx.json(drawn.resolution as never) : null}, dian_environment = ${dianEnvironment}
      where id = ${note.id}`;
    return drawn.full;
  },
  async post(ctx, record) {
    const note = await readNote(ctx, record.id as string);
    const invoice = await readInvoice(ctx, note.invoice_id, true);
    const settings = await settingsOf(ctx);
    const costCenterId = note.cost_center_id ?? settings.defaultCostCenterId;
    const rate = num(note.exchange_rate);
    const lines = await ctx.tx<{ base: string; free_sample: boolean; category_id: string | null }[]>`
      select base::text, free_sample, category_id from invoicing.note_lines where note_id = ${note.id} order by line_no`;
    const taxes = await ctx.tx<{ ledger_code: string; rate: string | null; base: string; amount: string }[]>`
      select ledger_code, rate::text, base::text, amount::text from invoicing.note_taxes where note_id = ${note.id} order by seq`;
    const facts = await readInvoiceFacts(ctx, note.party_id, []);
    const company = companyAmounts(lines, taxes, rate);
    // A credit note reverses the invoice's sides: its amounts are negative (the posting engine flips the side of a negative amount).
    const sign = note.kind === "credit" ? -1 : 1;
    const signed = (n: number) => (n === 0 ? 0 : sign * n);
    await ctx.tx`update invoicing.notes set stage = 'issued', issued_at = now(), total_company = ${company.total} where id = ${note.id}`;
    // What the invoice has been credited (debited) grows in the same transaction, under its lock.
    if (note.kind === "credit") await ctx.tx`update invoicing.invoices set credited_amount = credited_amount + ${num(note.total)} where id = ${invoice.id}`;
    else await ctx.tx`update invoicing.invoices set debited_amount = debited_amount + ${num(note.total)} where id = ${invoice.id}`;
    // What is owed changed: the paid status is recomputed against the receipts' allocations, under the invoice's lock (Task 23). A credit
    // that covers what was still owed makes it paid; a debit makes a paid one owed again; a credit on a paid one (a refund) keeps it paid,
    // and what it credits beyond what was open is the customer's credit balance (an annulment note never reaches here with a payment).
    if (!note.annulment) await refreshPaid(ctx, [invoice.id]);
    const invoiceLines = await ctx.tx<{ order_id: string | null; delivery_id: string | null }[]>`select order_id, delivery_id from invoicing.invoice_lines where invoice_id = ${invoice.id}`;
    await emitAndPostStrict(ctx, NOTE_ISSUED, {
      date: note.issue_date,
      number: note.number,
      noteId: note.id,
      kind: note.kind,
      annulment: note.annulment,
      reasonCode: note.concept,
      dueDate: note.due_date,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      invoiceCufe: invoice.cufe,
      customer: { partyId: note.party_id, legalName: facts.party.name },
      ...(costCenterId ? { costCenterId } : {}),
      totals: { total: signed(company.total) },
      lines: company.revenue.map(({ line, subtotal }) => ({ subtotal: signed(subtotal), categoryId: line.category_id, ...(costCenterId ? { costCenterId } : {}) })),
      taxes: company.taxLines.map(({ tax, amount, base }) => ({ code: tax.ledger_code, rate: tax.rate === null ? null : num(tax.rate), amount: signed(amount), base: signed(base) })),
      currency: note.currency,
      exchangeRate: rate,
      orderIds: [...new Set(invoiceLines.flatMap((l) => (l.order_id ? [l.order_id] : [])))],
      deliveryIds: [...new Set(invoiceLines.flatMap((l) => (l.delivery_id ? [l.delivery_id] : [])))],
    }, { requireRule: true });
  },
};

export const NOTE_PROCESSES = [noteCreate, noteIssue, noteIssueAnnulment, noteVoid, noteConsult, noteLineConsult, noteTaxConsult];
