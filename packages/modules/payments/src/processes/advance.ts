import { defineProcess, dismissParkedEvents, emitAndPostStrict, emitStatusChanged, genericProcess, ProcessError, runLifecycle, visibleExtra, writeSnapshot, type ProcessContext, type ProcessDef, type RecordStatus, type TypedHooks, type TypedRecord } from "@erp/kernel";
import { z } from "zod";
import { applicationEntity } from "../entities";
import { cents, date, id, idInput, markApplicationLinksVoided, money, num, pesos, refuse, refuseState, syncApplicationLinks, today } from "./common";
import { FEATURE_RECEIPTS, lockInvoices, openOf, payability, readyCustomer } from "./receipt";

// Aplicar anticipo a factura (plan 2B.2 Task 36, owner decisions item 23; accounting design 2026-10-28, advances and receivables; main design
// §8.1 step 7, §22.27). A receipt that received more than it applied leaves an advance (payments.receipts.advance, Cr customer_advances 280505).
// This applies it, later, to the customer's invoices, by an APPLICATION: a documento (AP-n) with lines (advance receipt, invoice, amount), many to
// many, that contabiliza and never waits for approval (own flags), exactly like the receipt.
//
// «Aplicar» (payments.advance.apply, no step-up, as the receipt's creation) in ONE transaction:
//   1. the customer must be a customer and invoice_ready (rule 10); the date defaults to today and is not after it;
//   2. the advance receipts are taken FOR UPDATE in id order, then the invoices under invoicing.lock_invoices_for_payment (FOR UPDATE in id
//      order): the lock order is always receipts then invoices (`receive` takes only invoices: no deadlock). Each receipt must be the customer's,
//      posted, in COP and dated on or before the application; each invoice must be payable (the receipt's own `payability`, called with the
//      application date) and in COP;
//   3. applicationPlan over cents: per receipt within what its advance has left (receipts.advance − the posted applications), per invoice
//      within what is open (total + debit notes − credit notes − what the posted receipts AND applications settled), one line per pair;
//   4. header and lines are written already applied, numbered AP-n on save, the links (invoice_to_application, receipt_to_application) and the
//      event payments.advance.applied posted INLINE and STRICT (emitAndPostStrict): Dr customer_advances / Cr receivable for the total, the
//      customer as party, the application as source. A closed period or a missing mapping refuses the whole application with nothing written.
//      Under the asynchronous posting mode (Task 33) it commits and the ledger entry follows.
// Invoicing recomputes the paid stage in its consumer of payments.advance.applied (`refreshPaid`, untouched).
//
// «Deshacer aplicación» (payments.advance.undo, STEP-UP) keeps the application (voided, never deleted), reverses its entry inline and strict
// through the rule `reverseOf` on payments.advance.unapplied, marks its links voided and dismisses a still-parked event. Both balances are
// derived, so voiding the row restores them. A receipt cannot be annulled while a live application draws on it (receipt.ts).

export const ADVANCE_APPLIED = "payments.advance.applied";
export const ADVANCE_UNAPPLIED = "payments.advance.unapplied";
/** The prefix of an application's number (company sequence, D9): Aplicación. */
export const APPLICATION_PREFIX = "AP-";
export const FEATURE_ADVANCES = FEATURE_RECEIPTS;

const positive = money.refine((n) => n > 0, "Debe ser mayor que cero");

export const applyInput = z.object({
  partyId: id,
  /** The date of the application (the entry's); defaults to the company's today. */
  date: date.optional(),
  lines: z.array(z.object({ receiptId: id, invoiceId: id, amount: positive }).strict()).min(1).max(100),
  /** One per «Aplicar» the user asks for (a form submit): a retry with the same key answers the first result. */
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
}).strict();

export const applicationOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  date: z.string(),
  partyId: z.string(),
  total: z.number(),
  lines: z.array(z.object({ receiptId: z.string(), receiptNumber: z.string().nullable(), invoiceId: z.string(), invoiceNumber: z.string().nullable(), amount: z.number() })),
});
export type ApplicationOutput = z.output<typeof applicationOutput>;

export interface PlanLine { receiptId: string; invoiceId: string; amount: number }
export interface PlanAdvance { receiptId: string; number: string | null; date: string; remaining: number }
export interface PlanInvoice { invoiceId: string; number: string | null; open: number }
export type ApplicationPlan =
  | {
      ok: true;
      total: number;
      byInvoice: { invoiceId: string; invoiceNumber: string | null; amount: number }[];
      byReceipt: { receiptId: string; receiptNumber: string | null; amount: number }[];
    }
  | { ok: false; code: string; details: string[] };

/**
 * The plan of an application (pure, in cents so the sums are exact): `lines` over the `advances` (what each receipt's advance has left) and the
 * `invoices` (what each has open). Refuses an application of nothing, a pair (receipt, invoice) said twice, an advance or an invoice that was not
 * loaded, a date before an advance's receipt or after today, an advance drawn beyond what it has left and an invoice settled beyond what is open
 * (the lines' sums per receipt and per invoice, so two lines of one invoice add up). The first refusal's code leads; `details` lists them all.
 */
export function applicationPlan(
  lines: readonly PlanLine[],
  advances: readonly PlanAdvance[],
  invoices: readonly PlanInvoice[],
  dates: { on: string; today: string },
): ApplicationPlan {
  if (lines.length === 0 || lines.every((l) => cents(l.amount) <= 0)) return { ok: false, code: "nothing_applied", details: ["La aplicación no tiene valor: indica cuánto del anticipo se aplica a cada factura"] };
  if (dates.on > dates.today) return { ok: false, code: "application_in_future", details: [`La aplicación no puede tener fecha posterior a hoy (${dates.today})`] };
  const seen = new Set<string>();
  for (const l of lines) {
    const key = `${l.receiptId}|${l.invoiceId}`;
    if (seen.has(key)) return { ok: false, code: "duplicate_pair", details: ["Un anticipo va una sola vez por factura en la aplicación: suma lo que se aplica en una línea"] };
    seen.add(key);
  }
  const advanceOf = new Map(advances.map((a) => [a.receiptId, a]));
  const invoiceOf = new Map(invoices.map((i) => [i.invoiceId, i]));
  const errors: { code: string; message: string }[] = [];
  const fail = (code: string, message: string) => errors.push({ code, message });
  lines.forEach((l, i) => {
    if (!advanceOf.has(l.receiptId)) fail("advance_not_found", `Línea ${i + 1}: el recibo del anticipo no existe o no es visible`);
    if (!invoiceOf.has(l.invoiceId)) fail("invoice_not_found", `Línea ${i + 1}: la factura no existe o no es visible`);
  });
  if (errors.length === 0) {
    for (const a of advances) {
      if (a.date > dates.on) fail("application_before_receipt", `El recibo ${a.number ?? a.receiptId} es del ${a.date}, posterior a la aplicación (${dates.on})`);
    }
    const drawn = new Map<string, number>();
    const settled = new Map<string, number>();
    for (const l of lines) {
      drawn.set(l.receiptId, (drawn.get(l.receiptId) ?? 0) + cents(l.amount));
      settled.set(l.invoiceId, (settled.get(l.invoiceId) ?? 0) + cents(l.amount));
    }
    for (const [receiptId, sum] of drawn) {
      const a = advanceOf.get(receiptId)!;
      if (sum > cents(a.remaining)) fail("advance_exceeds_open", `El anticipo del recibo ${a.number ?? receiptId} tiene un saldo de ${pesos(Math.max(a.remaining, 0))}: no se le pueden sacar ${pesos(sum / 100)}`);
    }
    for (const [invoiceId, sum] of settled) {
      const inv = invoiceOf.get(invoiceId)!;
      if (sum > cents(inv.open)) fail("allocation_exceeds_open", `La factura ${inv.number ?? invoiceId} tiene un saldo de ${pesos(Math.max(inv.open, 0))}: no se le puede aplicar ${pesos(sum / 100)}`);
    }
  }
  if (errors.length > 0) return { ok: false, code: errors[0]!.code, details: errors.map((e) => e.message) };
  const byInvoice = new Map<string, number>();
  const byReceipt = new Map<string, number>();
  for (const l of lines) {
    byInvoice.set(l.invoiceId, (byInvoice.get(l.invoiceId) ?? 0) + cents(l.amount));
    byReceipt.set(l.receiptId, (byReceipt.get(l.receiptId) ?? 0) + cents(l.amount));
  }
  return {
    ok: true,
    total: lines.reduce((s, l) => s + cents(l.amount), 0) / 100,
    byInvoice: [...byInvoice].map(([invoiceId, amount]) => ({ invoiceId, invoiceNumber: invoiceOf.get(invoiceId)!.number, amount: amount / 100 })),
    byReceipt: [...byReceipt].map(([receiptId, amount]) => ({ receiptId, receiptNumber: advanceOf.get(receiptId)!.number, amount: amount / 100 })),
  };
}

interface LineRow { receipt_id: string; receipt_number: string | null; invoice_id: string; invoice_number: string | null; amount: string }
interface ApplicationRow { id: string; number: string | null; status: RecordStatus; date: string; party_id: string; currency: string; total: string; updated_at: Date }

const SELECT_APPLICATION = (ctx: ProcessContext, applicationId: string, lock: boolean) => lock
  ? ctx.tx<ApplicationRow[]>`select id, number, status, date::text as date, party_id, currency, total::text, updated_at from payments.advance_applications where id = ${applicationId} for update`
  : ctx.tx<ApplicationRow[]>`select id, number, status, date::text as date, party_id, currency, total::text, updated_at from payments.advance_applications where id = ${applicationId}`;

async function readApplication(ctx: ProcessContext, applicationId: string, lock = false): Promise<ApplicationRow> {
  const [row] = await SELECT_APPLICATION(ctx, applicationId, lock);
  if (!row) throw new ProcessError("not_found", `payments.advance_application ${applicationId} not found`);
  return row;
}

const linesOf = (ctx: ProcessContext, applicationId: string) => ctx.tx<LineRow[]>`
  select receipt_id, receipt_number, invoice_id, invoice_number, amount::text from payments.advance_application_lines where application_id = ${applicationId} order by line_no`;

async function outputOf(ctx: ProcessContext, applicationId: string): Promise<ApplicationOutput> {
  const a = await readApplication(ctx, applicationId);
  const lines = await linesOf(ctx, applicationId);
  return {
    id: a.id, number: a.number, status: a.status, date: a.date, partyId: a.party_id, total: num(a.total),
    lines: lines.map((l) => ({ receiptId: l.receipt_id, receiptNumber: l.receipt_number, invoiceId: l.invoice_id, invoiceNumber: l.invoice_number, amount: num(l.amount) })),
  };
}

/** What each invoice and each advance receipt of an application's lines moves, summed (the event payloads' shapes). */
function aggregate(lines: readonly LineRow[]) {
  const invoices = new Map<string, { invoiceId: string; invoiceNumber: string | null; cents: number }>();
  const receipts = new Map<string, { receiptId: string; receiptNumber: string | null; cents: number }>();
  for (const l of lines) {
    const i = invoices.get(l.invoice_id) ?? { invoiceId: l.invoice_id, invoiceNumber: l.invoice_number, cents: 0 };
    i.cents += cents(num(l.amount));
    invoices.set(l.invoice_id, i);
    const r = receipts.get(l.receipt_id) ?? { receiptId: l.receipt_id, receiptNumber: l.receipt_number, cents: 0 };
    r.cents += cents(num(l.amount));
    receipts.set(l.receipt_id, r);
  }
  return {
    allocations: [...invoices.values()].map((i) => ({ invoiceId: i.invoiceId, invoiceNumber: i.invoiceNumber, amount: i.cents / 100 })),
    advances: [...receipts.values()].map((r) => ({ receiptId: r.receiptId, receiptNumber: r.receiptNumber, amount: r.cents / 100 })),
  };
}

/**
 * The payload of payments.advance.applied: the document's date and number, its id (`applicationId`, and `paymentId` = the same id: invoicing's consumer
 * of payments.received reads that name), the customer, the total and currency (what the rule posts: Dr customer_advances / Cr receivable), the
 * allocations per invoice (invoicing recomputes the paid stage from them) and the advances per receipt.
 */
export function appliedPayload(input: { applicationId: string; number: string; date: string; currency: string; total: number; customer: { partyId: string; legalName: string }; lines: readonly LineRow[] }) {
  const { allocations, advances } = aggregate(input.lines);
  return {
    date: input.date,
    number: input.number,
    applicationId: input.applicationId,
    paymentId: input.applicationId,
    customer: { partyId: input.customer.partyId, legalName: input.customer.legalName },
    total: input.total,
    currency: input.currency,
    allocations,
    advances,
  };
}

/** The payload of payments.advance.unapplied: the date and number, the application, the reason, the customer and what it gives back per invoice. */
export function unappliedPayload(input: { applicationId: string; number: string; date: string; reason: string; partyId: string; lines: readonly LineRow[] }) {
  return {
    date: input.date,
    number: input.number,
    applicationId: input.applicationId,
    paymentId: input.applicationId,
    reason: input.reason,
    partyId: input.partyId,
    allocations: aggregate(input.lines).allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
  };
}

interface AdvanceReceipt { id: string; number: string | null; status: string; date: string; party_id: string; currency: string; advance: string }

/** A replay of an application with this key that committed while this run waited for the key (the kernel's own check runs before the lock). */
async function storedApplication(ctx: ProcessContext, key: string): Promise<ApplicationOutput | null> {
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`payments.advance.apply:${ctx.companyId}:${key}`}, 0))`;
  const [stored] = await ctx.tx<{ result: ApplicationOutput }[]>`
    select result from kernel.process_idempotency where company_id = ${ctx.companyId} and process_id = 'payments.advance.apply' and key = ${`apply:${key}`}`;
  return stored?.result ?? null;
}

export const advanceApply = defineProcess({
  id: "payments.advance.apply",
  module: "payments",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_ADVANCES,
  emits: [ADVANCE_APPLIED],
  description:
    "Aplica el anticipo de uno o más recibos de caja de un cliente a una o más de sus facturas emitidas y aceptadas por la DIAN, sin superar lo que le queda a cada anticipo ni el saldo de cada factura. Numera la aplicación y la contabiliza en la misma operación (Dr anticipos de clientes / Cr cuentas por cobrar); la factura queda pagada si el anticipo la cubre",
  input: applyInput,
  output: applicationOutput,
  idempotencyKey: (input) => (input.idempotencyKey ? `apply:${input.idempotencyKey}` : undefined),
  handler: async (ctx, input) => {
    if (input.idempotencyKey) {
      const stored = await storedApplication(ctx, input.idempotencyKey);
      if (stored) return stored;
    }
    const now = await today(ctx);
    const on = input.date ?? now;
    if (on > now) refuse("application_in_future", [`La aplicación no puede tener fecha posterior a hoy (${now}): aplica el anticipo cuando corresponda`]);
    await readyCustomer(ctx, input.partyId);
    const pairs = new Set<string>();
    for (const l of input.lines) {
      const key = `${l.receiptId}|${l.invoiceId}`;
      if (pairs.has(key)) refuse("duplicate_pair", ["Un anticipo va una sola vez por factura en la aplicación: suma lo que se aplica en una línea"]);
      pairs.add(key);
    }
    const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
    const currency = company!.currency_code.trim();
    if (currency !== "COP") refuse("currency_not_supported", [`La empresa lleva su contabilidad en ${currency}: aplicar anticipos solo está disponible en pesos colombianos (COP)`]);

    // The advance receipts first (FOR UPDATE, id order), then the invoices: one lock order for every application and receipt.
    const receiptIds = [...new Set(input.lines.map((l) => l.receiptId))].sort();
    const receipts = new Map((await ctx.tx<AdvanceReceipt[]>`
      select id, number, status, date::text as date, party_id, currency, advance::text from payments.receipts where id = any(${receiptIds}::uuid[]) order by id for update`).map((r) => [r.id, r]));
    const errors: { code: string; message: string }[] = [];
    for (const [i, l] of input.lines.entries()) {
      const r = receipts.get(l.receiptId);
      const fail = (code: string, message: string) => errors.push({ code, message });
      if (!r) fail("advance_not_found", `Línea ${i + 1}: el recibo del anticipo no existe o no es visible`);
      else {
        const name = r.number ?? `de la línea ${i + 1}`;
        if (r.party_id !== input.partyId) fail("advance_other_customer", `El recibo ${name} es de otro cliente`);
        else if (r.status !== "posted") fail("advance_not_posted", `El recibo ${name} no está registrado (estado ${r.status}): solo se aplica el anticipo de un recibo contabilizado`);
        else if (r.currency.trim() !== "COP") fail("currency_not_supported", `El recibo ${name} está en ${r.currency}: aplicar anticipos solo está disponible en pesos colombianos (COP)`);
        else if (r.date > on) fail("application_before_receipt", `El recibo ${name} es del ${r.date}, posterior a la aplicación (${on})`);
        else if (cents(num(r.advance)) <= 0) fail("advance_exceeds_open", `El recibo ${name} no dejó anticipo por aplicar`);
      }
    }
    if (errors.length > 0) refuse(errors[0]!.code, errors.map((e) => e.message));
    const applied = new Map((await ctx.tx<{ receipt_id: string; applied: string }[]>`
      select receipt_id, applied::text from payments.advance_applied_amounts(${receiptIds}::uuid[])`).map((r) => [r.receipt_id, num(r.applied)]));
    const advances = receiptIds.map((receiptId): { receiptId: string; number: string | null; date: string; remaining: number } => {
      const r = receipts.get(receiptId)!;
      return { receiptId, number: r.number, date: r.date, remaining: (cents(num(r.advance)) - cents(applied.get(receiptId) ?? 0)) / 100 };
    });

    const { locked, settled } = await lockInvoices(ctx, input.lines.map((l) => l.invoiceId));
    const invoices = [...locked.values()].map((inv) => ({ invoiceId: inv.id, number: inv.number, open: openOf(inv, settled.get(inv.id) ?? 0) }));
    for (const [i, l] of input.lines.entries()) {
      const inv = locked.get(l.invoiceId);
      if (!inv) errors.push({ code: "invoice_not_found", message: `Línea ${i + 1}: la factura no existe o no es visible` });
      else {
        const blocked = payability(inv, input.partyId, currency, on, inv.number ?? `de la línea ${i + 1}`);
        if (blocked) errors.push(blocked);
      }
    }
    if (errors.length > 0) refuse(errors[0]!.code, errors.map((e) => e.message));

    const plan = applicationPlan(input.lines, advances, invoices, { on, today: now });
    if (!plan.ok) refuse(plan.code, plan.details);

    const [header] = await ctx.tx<{ id: string }[]>`
      insert into payments.advance_applications ${ctx.tx({
        company_id: ctx.companyId,
        date: on,
        party_id: input.partyId,
        currency,
        total: plan.total,
        // Applied in this very action: the validate hook (Grabar) refuses a Borrador that was never applied.
        applied_at: new Date(),
        // An application never waits for approval and always posts (ownFlags): explicit, so the Parámetros switches never apply.
        requires_approval: false,
        posts: true,
      })}
      returning id`;
    const applicationId = header!.id;
    await ctx.tx`insert into payments.advance_application_lines ${ctx.tx(input.lines.map((l, i) => ({
      company_id: ctx.companyId,
      application_id: applicationId,
      line_no: i + 1,
      receipt_id: l.receiptId,
      receipt_number: receipts.get(l.receiptId)!.number,
      invoice_id: l.invoiceId,
      invoice_number: locked.get(l.invoiceId)!.number,
      amount: l.amount,
    })))}`;
    // invoice_to_application and receipt_to_application, in this transaction (Task 31).
    await syncApplicationLinks(ctx, applicationId, input.lines.map((l) => l.invoiceId), input.lines.map((l) => l.receiptId));
    // Grabar: the number (on save) and the posting (Contabiliza): the post hook emits payments.advance.applied, posted inline.
    await runLifecycle(ctx, ctx.registry.entity(applicationEntity.id), applicationId, "save");
    return outputOf(ctx, applicationId);
  },
});

export const advanceUndo = defineProcess({
  id: "payments.advance.undo",
  module: "payments",
  kind: "update",
  feature: FEATURE_ADVANCES,
  sensitivity: "step-up",
  recordAccess: { entity: applicationEntity.id, idField: "id", right: "void" },
  emits: [ADVANCE_UNAPPLIED],
  description:
    "Deshace una aplicación de anticipo con el motivo: el anticipo y las facturas recuperan sus saldos y su asiento se revierte en la misma operación; la aplicación queda anulada, nunca se borra",
  input: z.object({
    id,
    reason: z.string().trim().min(1, "Indica por qué se deshace la aplicación").max(1000),
    /** The date of the reversal; defaults to the company's today. */
    date: date.optional(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
  output: z.object({ id: z.string(), status: z.literal("voided"), number: z.string().nullable() }),
  handler: async (ctx, { id: applicationId, reason, date: given, expectedUpdatedAt }) => {
    const application = await readApplication(ctx, applicationId, true);
    if (expectedUpdatedAt && new Date(application.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ProcessError("stale_record", `payments.advance_application ${applicationId} changed since it was read`);
    }
    // The lifecycle's own table (D3) refuses a void from posted; a posted application is undone here, through the reversal path.
    if (application.status !== "posted") {
      throw new ProcessError("invalid_state", `payments.advance_application ${applicationId}: undo is not allowed in status ${application.status}`, { details: { from: application.status, action: "undo" } });
    }
    const on = given ?? (await today(ctx));
    if (on < application.date) refuse("undo_before_application", [`La anulación (${on}) no puede ser anterior a la aplicación (${application.date})`]);
    const lines = await linesOf(ctx, applicationId);
    const [voided] = await ctx.tx<TypedRecord[]>`
      update payments.advance_applications set status = 'voided', void_reason = ${reason}, voided_at = now() where id = ${applicationId} returning *`;
    const entity = ctx.registry.entity(applicationEntity.id);
    await writeSnapshot(ctx, entity, applicationId, "voided", reason);
    await emitStatusChanged(ctx, entity, { id: applicationId, number: voided!.number }, "posted", "voided");
    // Undo keeps the application's links, marked (Task 31).
    await markApplicationLinksVoided(ctx, applicationId, reason);
    // An application whose event is still parked (accounting off, or the asynchronous mode) must never reach the ledger after this undo: dismiss it.
    await dismissParkedEvents(ctx, ADVANCE_APPLIED, { applicationId });
    // The reversal of the application's entry, inline and strict: a closed period (or any refusal) undoes the whole undo.
    await emitAndPostStrict(ctx, ADVANCE_UNAPPLIED, unappliedPayload({
      applicationId, number: application.number ?? applicationId, date: on, reason, partyId: application.party_id, lines,
    }), { requireRule: true });
    return { id: applicationId, status: "voided" as const, number: application.number };
  },
});

/** The fields of the customer's receipts the consult needs: without them the figures would be guessed or blank (rule 14, R36-10). */
const OPEN_FIELDS = ["number", "date", "advance", "party_id", "status"] as const;

export const advanceOpen = defineProcess({
  id: "payments.advance.open",
  module: "payments",
  kind: "consult",
  feature: FEATURE_ADVANCES,
  description: "Consulta los recibos de caja de un cliente que tienen anticipo por aplicar: su número, fecha, medio de pago, el anticipo, lo aplicado y lo que queda",
  input: z.object({ partyId: id }).strict(),
  output: z.object({
    advances: z.array(z.object({
      receiptId: z.string(), number: z.string().nullable(), date: z.string().nullable(), method: z.string().nullable(), advance: z.number(), applied: z.number(), remaining: z.number(),
    })),
  }),
  handler: async (ctx, { partyId }) => {
    const [party] = await ctx.tx<{ id: string }[]>`select id from core.v_party_sales where id = ${partyId}`;
    if (!party) refuse("invalid_party", ["El cliente no existe o no es visible"]);
    // Masked fields never filter nor answer guessed figures: a caller who does not see the receipt's number, date or advance (nor the
    // customer and status the list is filtered by) is forbidden, as for the open invoices list (R40-2).
    for (const field of OPEN_FIELDS) {
      const [visible] = await ctx.tx<{ visible: boolean }[]>`select kernel.field_visible('payments.receipt', ${field}) as visible`;
      if (visible?.visible !== true) throw new ProcessError("forbidden", `payments.advance.open: the caller may not see payments.receipt.${field}`);
    }
    // `applied` is the sum of the applications' lines (a definer function): it is a figure of payments.advance_application_line.amount, so a
    // caller who may not see that field gets no figure either (rule 14, no side channel).
    const [lineAmount] = await ctx.tx<{ visible: boolean }[]>`select kernel.field_visible('payments.advance_application_line', 'amount') as visible`;
    if (lineAmount?.visible !== true) throw new ProcessError("forbidden", "payments.advance.open: the caller may not see payments.advance_application_line.amount");
    const rows = await ctx.tx<{ id: string; number: string | null; date: string | null; method_code: string | null; advance: string }[]>`
      select id, number, date::text as date, method_code, advance::text from payments.v_receipts
      where party_id = ${partyId} and status = 'posted' and advance > 0 order by date, number`;
    if (rows.length === 0) return { advances: [] };
    const applied = new Map((await ctx.tx<{ receipt_id: string; applied: string }[]>`
      select receipt_id, applied::text from payments.advance_applied_amounts(${rows.map((r) => r.id)}::uuid[])`).map((r) => [r.receipt_id, num(r.applied)]));
    return {
      advances: rows.flatMap((r) => {
        const used = applied.get(r.id) ?? 0;
        const remaining = (cents(num(r.advance)) - cents(used)) / 100;
        return remaining > 0 ? [{ receiptId: r.id, number: r.number, date: r.date, method: r.method_code, advance: num(r.advance), applied: used, remaining }] : [];
      }),
    };
  },
});

export const applicationConsult = defineProcess({
  id: "payments.advance_application.consult",
  module: "payments",
  kind: "consult",
  feature: FEATURE_ADVANCES,
  description: "Consulta una aplicación de anticipo con las facturas a las que se aplicó, los recibos de los que salió y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: applicationId }) => {
    const [row] = await ctx.tx`select * from payments.v_advance_applications where id = ${applicationId}`;
    if (!row) throw new ProcessError("not_found", `payments.advance_application ${applicationId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from payments.v_advance_application_lines where application_id = ${applicationId} order by line_no`;
    return { ...row, id: applicationId, extra: await visibleExtra(ctx, applicationEntity.id, row.extra), lines };
  },
});

export const applicationLineConsult = defineProcess({
  id: "payments.advance_application_line.consult",
  module: "payments",
  kind: "consult",
  feature: FEATURE_ADVANCES,
  description: "Consulta una línea de una aplicación de anticipo: el recibo del anticipo, la factura y el valor aplicado",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from payments.v_advance_application_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `payments.advance_application_line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The lifecycle hooks of an application (Grabar): it reaches the ledger only through payments.advance.apply (a Borrador never applied is
 * refused), once applied it does not change (undoing it is payments.advance.undo), it numbers on save, and its post step emits the event
 * the ledger rule posts.
 */
export const applicationHooks: TypedHooks = {
  async validate(_ctx, record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (previous.status === "draft" && !record.applied_at) {
      refuse("invalid_application", ["Una aplicación de anticipo se registra con «Aplicar a facturas», que valida los saldos"]);
    }
    if (previous.status !== "draft" && data && Object.keys(data).length > 0) {
      refuseState("application_posted", ["Una aplicación de anticipo registrada no cambia: deshazla y aplica de nuevo"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select payments.next_document_number(${ctx.companyId}, ${APPLICATION_PREFIX}) as number`;
    return row!.number;
  },
  async post(ctx, record) {
    const a = await readApplication(ctx, record.id);
    const lines = await linesOf(ctx, record.id);
    const [fiscal] = await ctx.tx<{ legal_name: string | null; document_number: string | null }[]>`select legal_name, document_number from core.v_party_fiscal where id = ${a.party_id}`;
    const payload = appliedPayload({
      applicationId: a.id,
      number: a.number ?? (record.number as string),
      date: a.date,
      currency: a.currency,
      total: num(a.total),
      customer: { partyId: a.party_id, legalName: fiscal?.legal_name ?? fiscal?.document_number ?? a.party_id },
      lines,
    });
    // Inline and strict (D8): the entry is in the ledger when this action commits, or the action does not happen.
    await emitAndPostStrict(ctx, ADVANCE_APPLIED, payload, { requireRule: true });
  },
};

/**
 * Eliminar of the record frame (a Borrador only, design §22.23): the generic `payments.advance_application.delete`, still a delete process (same
 * id, same audit label), with the application's links taken away first (Task 31).
 */
const genericDelete = genericProcess({ id: applicationEntity.id, module: "payments", entityType: "documento" }, "delete");
export const applicationDelete = {
  ...genericDelete,
  feature: FEATURE_ADVANCES,
  handler: async (ctx: ProcessContext, input: unknown) => {
    const application = await readApplication(ctx, (input as { id: string }).id, true);
    await syncApplicationLinks(ctx, application.id, [], []);
    return genericDelete.handler(ctx, input);
  },
} as ProcessDef;

export const ADVANCE_PROCESSES = [applicationDelete, advanceApply, advanceUndo, advanceOpen, applicationConsult, applicationLineConsult];
