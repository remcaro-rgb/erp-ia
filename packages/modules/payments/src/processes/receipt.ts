import { countryPack, defineProcess, dismissParkedEvents, emitAndPostStrict, emitStatusChanged, genericProcess, ProcessError, runLifecycle, visibleExtra, writeSnapshot, type ProcessContext, type ProcessDef, type RecordStatus, type TypedHooks, type TypedRecord } from "@erp/kernel";
import { z } from "zod";
import { receiptEntity, WITHHOLDING_KINDS, type WithholdingKind } from "../entities";
import { cents, date, defaultRate, id, idInput, markReceiptLinksVoided, money, moneyAmount, num, refuse, refuseState, syncReceiptLinks, today } from "./common";

// Recibos de caja (plan 2B Task 21; design §8 and §8.1 step 7; accounting design §5.4 and §10a.7: the withholdings a customer practises are
// recognised when it pays, never on the invoice). A documento that posts (contabiliza) and never waits for approval (own flags).
//
// «Registrar pago» (payments.payment.receive) in ONE transaction:
//   1. the customer must be a customer and invoice_ready (rule 10, main §5.17: the receivable and the advances are accounts the ledger takes
//      only with a ready tercero), the method and the caja usable maestros (the lifecycle's gate);
//   2. each allocation names an issued invoice of the same customer (invoicing's published view invoicing.v_receivable_invoices, rule 3) that
//      the DIAN accepted (the prototype's gate: «La factura debe estar aceptada por la DIAN antes de registrar el pago»), in an allowed pair of
//      currencies (R34-6, FX §6: the receipt's own currency, or a peso receipt against a foreign-currency invoice), not dated after the
//      receipt and without an annulment in progress (Task 18: its credit note of annulment issued and not yet accepted). Under the invoices' locks (invoicing's
//      lock_invoices_for_payment, FOR UPDATE in id order: two receipts of one invoice wait for each other, and for a note or an Anular in
//      flight; never a deadlock) an allocation never exceeds what is open of the invoice: total + debit notes − credit notes − what posted
//      receipts already settled (payments.allocated_amounts, every receipt of the company whoever may read it);
//   3. an allocation settles `amount` of the invoice: the cash it got plus the withholdings the customer practised on it (each with its kind,
//      code, rate and base; amount = base × rate within $ 1). The money received must cover the cash applied; what is left is a customer
//      advance (an anticipo: Cr customer_advances). A receipt with no allocation is all advance;
//   4. it is written already applied, numbered RC-n (company sequence, D9) and posted INLINE and STRICT (D8, emitAndPostStrict): the event
//      payments.received, whose payload is the 2A fixture's shape (date, number, paymentId, method, amount, applied, customer, withholdings
//      by kind) plus the allocations with their invoices and withholdings (Task 23: invoicing sets paid_amount from them) and the advance.
//      A closed period, a customer the ledger cannot take or a missing mapping refuses the whole receipt with nothing written; a company
//      without accounting receives and the event parks; a ledger never started is refused (ledger_not_started).
// A retry with the same idempotency key answers the first result, also when both run at once (they queue on the key).
//
// Foreign currency (plan 2B.2 Task 34.5, FX §5 realized, §6; owner item 125): a receipt has one currency, the money's, which its method must
// receive (method_currency_mismatch), and a rate (typed, else the rate table's on the receipt date, else exchange_rate_missing; 1 in pesos).
// Each allocation keeps three amounts: `amount` in the invoice's currency (what it settles of the open balance), `amount_receipt` in the
// receipt's (equal to `amount`, except pesos received against a foreign invoice, which the user types: amountReceipt) and `amount_company`
// at the invoice's rate (what it takes off the receivable; the allocation that closes the invoice takes exactly what is left of its pesos).
// The pesos the receipt gave for an allocation less its amount_company are the realized exchange difference (fx: gain or loss, per
// allocation), posted to fx_gain / fx_loss with no document amount. A withholding on a foreign-currency invoice is refused
// (withholding_foreign_currency: an export customer abroad practises none).
//
// Anular (payments.payment.void, STEP-UP) keeps the receipt (voided, never deleted), gives its allocations back (only posted receipts settle
// an invoice) and reverses its entry inline and strict through the rule `reverseOf` on payments.payment.voided: a closed period refuses the
// void with nothing written. A receipt whose event is still parked (accounting off) is dismissed so it never posts afterwards.

export const PAYMENT_RECEIVED = "payments.received";
export const PAYMENT_VOIDED = "payments.payment.voided";
/** The prefix of a receipt's number (company sequence, D9): Recibo de Caja. */
export const RECEIPT_PREFIX = "RC-";
export const FEATURE_RECEIPTS = "payments.receipts";
/** Every refusal code of the payments processes (the text after `invalid_input:` / `invalid_state:`); payments.errors.<code> names each one. */
export const PAYMENTS_REFUSAL_CODES = [
  "allocation_exceeds_open", "invoice_other_customer", "invoice_not_issued", "invoice_voided", "invoice_annulment_pending", "invoice_not_accepted", "currency_not_supported", "invoice_after_receipt",
  // Foreign receipts (plan 2B.2 Task 34.5, R34-6).
  "currency_mismatch", "method_currency_mismatch", "withholding_foreign_currency", "amount_receipt_required", "amount_receipt_mismatch", "exchange_rate_missing", "invoice_not_found", "duplicate_invoice", "cash_short", "invalid_withholding", "nothing_received", "not_invoice_ready", "invalid_party", "invalid_method", "invalid_cash_box", "cash_box_not_cash", "method_kind_unmapped", "invalid_means_code", "means_code_kind_mismatch", "receipt_in_future", "void_before_receipt", "invalid_receipt", "receipt_posted",
  // Applying an advance to invoices (plan 2B.2 Task 36): the application's own refusals, and Anular's guard (processes/advance.ts).
  "advance_exceeds_open", "advance_other_customer", "advance_not_found", "advance_not_posted", "duplicate_pair", "application_in_future", "application_before_receipt", "nothing_applied",
  "receipt_has_applications", "invalid_application", "application_posted", "undo_before_application"
] as const;

/** How far a withholding's amount may be from base × rate: the certificate's rounding to the peso ($ 0,50). */
const WITHHOLDING_TOLERANCE_CENTS = 50;

const positive = moneyAmount.refine((n) => n > 0, "Debe ser mayor que cero");

export const withholdingInput = z.object({
  kind: z.enum(WITHHOLDING_KINDS),
  /** The concept code of the customer's certificate (e.g. RTEFTE_SERVICIOS_4), as the ledger line carries it. */
  code: z.string().trim().min(1).max(40),
  rate: z.number().finite().positive().max(100),
  base: positive,
  amount: positive,
}).strict();

export const allocationInput = z.object({
  invoiceId: id,
  /** What the allocation settles of the invoice, in the invoice's currency: the cash plus the withholdings practised on it. */
  amount: positive,
  /** The same in the receipt's currency: required when pesos settle a foreign-currency invoice (the pesos received for it), else `amount`. */
  amountReceipt: positive.optional(),
  withholdings: z.array(withholdingInput).max(10).default([]),
}).strict();

export const receiveInput = z.object({
  partyId: id,
  methodId: id,
  cashBoxId: id.optional(),
  /** The date of the receipt (the entry's); defaults to the company's today. */
  date: date.optional(),
  /** The currency of the money received (ISO 4217); the method's when not given (FX §6). */
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "La moneda es un código ISO de tres letras, como COP o USD").optional(),
  /** Pesos per unit of `currency`; the rate table's on the receipt date when not given (1 for the company's currency). */
  exchangeRate: z.number().finite().positive().max(1e9).optional(),
  /** The money received, in the receipt's currency. */
  amount: moneyAmount,
  reference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
  allocations: z.array(allocationInput).max(100).default([]),
  /** One per «Registrar pago» the user asks for (a form submit): a retry with the same key answers the first result. */
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
}).strict();

export const receiptOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  date: z.string(),
  partyId: z.string(),
  methodId: z.string(),
  currency: z.string(),
  exchangeRate: z.number(),
  amount: z.number(),
  applied: z.number(),
  withholdingTotal: z.number(),
  advance: z.number(),
  allocations: z.array(z.object({
    invoiceId: z.string(), invoiceNumber: z.string().nullable(), currency: z.string(), amount: z.number(), amountReceipt: z.number(), amountCompany: z.number(),
    cashAmount: z.number(), withholdingTotal: z.number(), fx: z.object({ gain: z.number(), loss: z.number() }),
  })),
});
export type ReceiptOutput = z.output<typeof receiptOutput>;

export interface Withholding { kind: WithholdingKind; code: string; rate: number; base: number; amount: number }
/**
 * An allocation as the receipt writes it: `amount` in the invoice's currency, `amountReceipt` in the receipt's (default `amount`) and
 * `amountCompany` in pesos at the invoice's rate (default `amountReceipt` × the receipt's rate: no exchange difference).
 */
export interface PlannedAllocation { invoiceId: string; invoiceNumber: string | null; currency?: string; amount: number; amountReceipt?: number; amountCompany?: number; withholdings: Withholding[] }

/** The pesos of `amount` at `rate`, to the cent. */
export const companyCents = (amount: number, rate: number): number => cents(amount * rate);

/**
 * The realized exchange difference of an allocation (FX §5): the pesos the receipt gave for it (amountReceipt × the receipt's rate) less
 * the pesos it takes off the receivable (amountCompany). Non-negative, at most one of them is not zero.
 */
export function allocationFx(amountReceipt: number, amountCompany: number, rate: number): { gain: number; loss: number } {
  const diff = companyCents(amountReceipt, rate) - cents(amountCompany);
  return { gain: Math.max(diff, 0) / 100, loss: Math.max(-diff, 0) / 100 };
}

export type ReceiptTotals =
  | { ok: true; applied: number; withholdingTotal: number; cashApplied: number; advance: number; lines: { cash: number; withholdingTotal: number }[] }
  | { ok: false; code: string; details: string[] };

/**
 * The totals of a receipt that received `amount` and applies `allocations` (in cents, so they add up to the cent): what it settles, the
 * withholdings, the cash applied, the advance, and each allocation's cash. Refuses a withholding that is not base × rate (within $ 1),
 * withholdings above their allocation, money short of the cash applied, and a receipt of nothing.
 */
export function receiptTotals(amount: number, allocations: readonly Pick<PlannedAllocation, "invoiceNumber" | "amount" | "withholdings">[], currency = "COP"): ReceiptTotals {
  const errors: string[] = [];
  const lines = allocations.map((a, i) => {
    const name = a.invoiceNumber ?? `de la línea ${i + 1}`;
    let held = 0;
    for (const w of a.withholdings) {
      const expected = Math.round((cents(w.base) * w.rate) / 100);
      if (Math.abs(cents(w.amount) - expected) > WITHHOLDING_TOLERANCE_CENTS) {
        errors.push(`La retención ${w.code} de la factura ${name} no corresponde a su base y tarifa: ${money(w.base, currency)} × ${w.rate} % = ${money(expected / 100, currency)}, no ${money(w.amount, currency)}`);
      }
      held += cents(w.amount);
    }
    if (held > cents(a.amount)) errors.push(`Las retenciones de la factura ${name} (${money(held / 100, currency)}) superan lo aplicado (${money(a.amount, currency)})`);
    return { applied: cents(a.amount), held };
  });
  if (errors.length > 0) return { ok: false, code: "invalid_withholding", details: errors };
  const applied = lines.reduce((s, l) => s + l.applied, 0);
  const held = lines.reduce((s, l) => s + l.held, 0);
  const cashApplied = applied - held;
  const received = cents(amount);
  if (received === 0 && applied === 0) return { ok: false, code: "nothing_received", details: ["El recibo no tiene valor recibido ni facturas por aplicar"] };
  if (received < cashApplied) {
    return { ok: false, code: "cash_short", details: [`El valor recibido (${money(received / 100, currency)}) no cubre lo aplicado en efectivo a las facturas (${money(cashApplied / 100, currency)})`] };
  }
  return {
    ok: true,
    applied: applied / 100,
    withholdingTotal: held / 100,
    cashApplied: cashApplied / 100,
    advance: (received - cashApplied) / 100,
    lines: lines.map((l) => ({ cash: (l.applied - l.held) / 100, withholdingTotal: l.held / 100 })),
  };
}

export interface ReceivedPayloadInput {
  receiptId: string; number: string; date: string; methodKind: string; methodCode: string; methodId: string; cashBoxId: string | null; reference: string | null;
  currency: string; exchangeRate: number; amount: number; customer: { partyId: string; legalName: string }; allocations: PlannedAllocation[];
}

/**
 * The payload of payments.received: the 2A fixture `payment-received` (date, number, paymentId, method — the method's kind —, amount, applied, customer,
 * withholdings by kind with code / rate / base / amount) plus what the rule's advance line and the consumers read: `advance` and
 * `advances` (one item when there is an advance: Cr customer_advances), the method's id, the caja, the reference, the currency and the
 * allocations (invoice, number, what each settles, its cash, its withholdings).
 *
 * Both amounts (R34-4, plan 2B.2 Task 34.5): every money field the 2A shape had keeps its company meaning (pesos) and gains its document
 * twin in the receipt's currency with `Doc` appended (`amount` / `amountDoc`, `applied` / `appliedDoc`, `withholdings.*[].amountDoc`,
 * `advances[].amountDoc`); `currency` and `exchangeRate` are the receipt's. The receivable is credited at the invoices' rates (`applied` =
 * Σ amountCompany), the money at the receipt's: each allocation's `fx` is the difference (FX §5). The cash's pesos are the parts' pesos
 * (each allocation's pesos received, the advance's, less the withholdings), so the entry balances to the cent in both currencies.
 */
export function receivedPayload(input: ReceivedPayloadInput) {
  const rate = input.exchangeRate;
  const allocations = input.allocations.map((a) => {
    const amountReceipt = a.amountReceipt ?? a.amount;
    const amountCompany = a.amountCompany ?? companyCents(amountReceipt, rate) / 100;
    return { ...a, currency: a.currency ?? input.currency, amountReceipt, amountCompany, fx: allocationFx(amountReceipt, amountCompany, rate) };
  });
  // What the receipt applies is counted in its own currency: the money received covers the pesos (or dollars) it gave for each invoice.
  const totals = receiptTotals(input.amount, allocations.map((a) => ({ ...a, amount: a.amountReceipt })), input.currency);
  if (!totals.ok) throw new Error(`${totals.code}: ${totals.details.join("; ")}`);
  const byKind = (kind: WithholdingKind) =>
    input.allocations.flatMap((a) => a.withholdings.filter((w) => w.kind === kind).map((w) => ({
      code: w.code, rate: w.rate, base: w.base, amount: companyCents(w.amount, rate) / 100, amountDoc: w.amount, invoiceId: a.invoiceId,
    })));
  const heldCompany = allocations.reduce((s, a) => s + a.withholdings.reduce((t, w) => t + companyCents(w.amount, rate), 0), 0);
  const receivedCompany = allocations.reduce((s, a) => s + companyCents(a.amountReceipt, rate), 0);
  const advanceCompany = companyCents(totals.advance, rate);
  const cashCompany = receivedCompany - heldCompany + advanceCompany;
  return {
    date: input.date,
    number: input.number,
    paymentId: input.receiptId,
    // The dimension of the cash line (payment_method:<kind>, controller ruling of fix round 1): the KIND, which the pack maps for every kind
    // it knows; the method's own code is a snapshot for the reader, never an account key.
    method: input.methodKind,
    methodCode: input.methodCode,
    methodId: input.methodId,
    cashBoxId: input.cashBoxId,
    reference: input.reference,
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    amount: cashCompany / 100,
    amountDoc: input.amount,
    applied: allocations.reduce((s, a) => s + cents(a.amountCompany), 0) / 100,
    appliedDoc: totals.applied,
    advance: totals.advance,
    advances: totals.advance > 0 ? [{ amount: advanceCompany / 100, amountDoc: totals.advance }] : [],
    customer: { partyId: input.customer.partyId, legalName: input.customer.legalName },
    withholdings: { income: byKind("income"), vat: byKind("vat"), ica: byKind("ica") },
    allocations: allocations.map((a, i) => ({
      invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, currency: a.currency, amount: a.amount, amountReceipt: a.amountReceipt, amountCompany: a.amountCompany,
      cash: totals.lines[i]!.cash, withholdingTotal: totals.lines[i]!.withholdingTotal, withholdings: a.withholdings, fx: a.fx,
    })),
  };
}
export type ReceivedPayload = ReturnType<typeof receivedPayload>;

/** The payload of payments.payment.voided: the 2A fixture (date, number, paymentId) plus the reason, the customer and what it gives back. */
export function voidedPayload(input: { receiptId: string; number: string; date: string; reason: string; partyId: string; allocations: { invoiceId: string; amount: number }[] }) {
  return { date: input.date, number: input.number, paymentId: input.receiptId, reason: input.reason, partyId: input.partyId, allocations: input.allocations };
}

interface ReceiptRow {
  id: string; number: string | null; status: RecordStatus; date: string; party_id: string; method_id: string; method_code: string; cash_box_id: string | null;
  reference: string | null; currency: string; exchange_rate: string; amount: string; applied: string; withholding_total: string; advance: string; updated_at: Date;
}
interface AllocationRow {
  invoice_id: string; invoice_number: string | null; invoice_currency: string | null; amount: string; amount_receipt: string; amount_company: string; cash_amount: string;
  withholding_total: string; withholdings: Withholding[] | null;
}

async function readReceipt(ctx: ProcessContext, receiptId: string, lock = false): Promise<ReceiptRow> {
  const rows = lock
    ? await ctx.tx<ReceiptRow[]>`
        select id, number, status, date::text as date, party_id, method_id, method_code, cash_box_id, reference, currency, exchange_rate::text, amount::text, applied::text,
               withholding_total::text, advance::text, updated_at
        from payments.receipts where id = ${receiptId} for update`
    : await ctx.tx<ReceiptRow[]>`
        select id, number, status, date::text as date, party_id, method_id, method_code, cash_box_id, reference, currency, exchange_rate::text, amount::text, applied::text,
               withholding_total::text, advance::text, updated_at
        from payments.receipts where id = ${receiptId}`;
  if (!rows[0]) throw new ProcessError("not_found", `payments.receipt ${receiptId} not found`);
  return rows[0];
}

/** The receipt's allocations, each with its invoice's currency (invoicing's published view; null when the caller cannot see the invoice). */
const allocationsOf = (ctx: ProcessContext, receiptId: string) => ctx.tx<AllocationRow[]>`
  select a.invoice_id, a.invoice_number, i.currency as invoice_currency, a.amount::text, a.amount_receipt::text, a.amount_company::text, a.cash_amount::text,
         a.withholding_total::text, a.withholdings
  from payments.receipt_allocations a left join invoicing.v_receivable_invoices i on i.id = a.invoice_id
  where a.receipt_id = ${receiptId} order by a.line_no`;

async function outputOf(ctx: ProcessContext, receiptId: string): Promise<ReceiptOutput> {
  const r = await readReceipt(ctx, receiptId);
  const lines = await allocationsOf(ctx, receiptId);
  const currency = r.currency.trim();
  const rate = num(r.exchange_rate);
  return {
    id: r.id, number: r.number, status: r.status, date: r.date, partyId: r.party_id, methodId: r.method_id, currency, exchangeRate: rate,
    amount: num(r.amount), applied: num(r.applied), withholdingTotal: num(r.withholding_total), advance: num(r.advance),
    allocations: lines.map((l) => ({
      invoiceId: l.invoice_id, invoiceNumber: l.invoice_number, currency: l.invoice_currency?.trim() ?? currency, amount: num(l.amount),
      amountReceipt: num(l.amount_receipt), amountCompany: num(l.amount_company), cashAmount: num(l.cash_amount), withholdingTotal: num(l.withholding_total),
      fx: allocationFx(num(l.amount_receipt), num(l.amount_company), rate),
    })),
  };
}

interface Readiness { invoice_ready: boolean | null; is_active: boolean | null; dian_missing: string[] | null; missing_files: string[] | null; usable: boolean | null; status: string | null; requires_approval: boolean | null }

/** Why a tercero is not invoice_ready, in the words the screens show (the same reasons the sale documents give). */
function readinessReasons(row: Readiness): string[] {
  const reasons: string[] = [];
  if (row.usable === false && row.is_active !== false) {
    if (row.requires_approval === true && row.status === "rejected") reasons.push("no fue aprobado");
    else if (row.requires_approval === true && row.status !== "approved") reasons.push("está pendiente de aprobación");
    else if (row.status === "draft") reasons.push("está en borrador, sin grabar");
    else reasons.push("no está habilitado para documentos");
  }
  if ((row.dian_missing ?? []).length > 0) reasons.push(`faltan datos DIAN: ${row.dian_missing!.join(", ")}`);
  if ((row.missing_files ?? []).length > 0) reasons.push(`faltan archivos: ${row.missing_files!.join(", ")}`);
  if (row.is_active === false) reasons.push("está inactivo");
  if (reasons.length === 0) reasons.push("revisa sus datos DIAN, sus archivos, que esté activo y aprobado");
  return reasons;
}

/** The customer as core publishes it (core.v_party_sales, core.v_party_fiscal; rule 3): a customer, invoice_ready, with its name. */
export async function readyCustomer(ctx: ProcessContext, partyId: string): Promise<{ partyId: string; legalName: string }> {
  const [party] = await ctx.tx<(Readiness & { kind: string[] | null })[]>`
    select kind, invoice_ready, is_active, dian_missing, missing_files, usable, status, requires_approval from core.v_party_sales where id = ${partyId}`;
  if (!party) refuse("invalid_party", ["El cliente no existe o no es visible"]);
  if (!(party.kind ?? []).includes("customer")) refuse("invalid_party", ["El tercero no es un cliente"]);
  const [fiscal] = await ctx.tx<{ legal_name: string | null; document_number: string | null }[]>`select legal_name, document_number from core.v_party_fiscal where id = ${partyId}`;
  const legalName = fiscal?.legal_name ?? fiscal?.document_number ?? partyId;
  if (party.invoice_ready !== true) refuse("not_invoice_ready", [`El cliente ${legalName} no está listo para recibirle pagos: ${readinessReasons(party).join("; ")}`]);
  return { partyId, legalName };
}

export interface InvoiceFacts {
  id: string; party_id: string; number: string | null; issue_date: string; currency: string; total: string; credited_amount: string; debited_amount: string;
  stage: string; status: string; dian_status: string; annulment_pending: boolean;
  /** The invoice's frozen rate and its pesos (invoicing.v_receivable_invoices): what a foreign allocation is carried at. */
  exchange_rate?: string; total_company?: string;
}

/**
 * Why an invoice cannot receive a payment of `partyId` dated `receiptDate` in `currency` (the first reason, in the words the screens show),
 * or null when it can: the customer's own, issued, not voided, no annulment in progress, accepted by the DIAN, in an allowed pair of
 * currencies and not dated after the receipt. «Registrar pago» refuses with it; the open invoices list (payments.payment.open_invoices)
 * shows it. With `companyCurrency` (a receipt, R34-6) the pairs are the same currency, or a receipt in the company's currency against a
 * foreign-currency invoice (`currency_mismatch` otherwise); without it (an advance application, plan Task 34.6) only the same currency
 * (`currency_mismatch` too).
 */
export function payability(
  inv: Pick<InvoiceFacts, "party_id" | "stage" | "status" | "annulment_pending" | "dian_status" | "currency" | "issue_date">,
  partyId: string,
  currency: string,
  receiptDate: string,
  name: string,
  companyCurrency?: string,
): { code: string; message: string } | null {
  if (inv.party_id !== partyId) return { code: "invoice_other_customer", message: `La factura ${name} es de otro cliente` };
  if (inv.stage === "draft" || inv.status === "draft") return { code: "invoice_not_issued", message: `La factura ${name} está en borrador: se paga una factura emitida` };
  if (inv.stage === "voided" || inv.status === "voided") return { code: "invoice_voided", message: `La factura ${name} está anulada` };
  if (inv.annulment_pending) return { code: "invoice_annulment_pending", message: `La factura ${name} tiene una nota crédito de anulación en curso: no recibe pagos` };
  if (inv.dian_status !== "accepted") return { code: "invoice_not_accepted", message: `La DIAN aún no ha aceptado la factura ${name}: el pago se registra cuando la acepte` };
  const invoiceCurrency = inv.currency.trim();
  if (invoiceCurrency !== currency) {
    if (companyCurrency === undefined) return { code: "currency_mismatch", message: `La factura ${name} está en ${invoiceCurrency}: un anticipo en ${currency} no la paga; se aplica un anticipo en ${invoiceCurrency}` };
    if (currency !== companyCurrency) {
      return { code: "currency_mismatch", message: `La factura ${name} está en ${invoiceCurrency}: un recibo en ${currency} no la paga; se paga en ${invoiceCurrency} o en ${companyCurrency}` };
    }
  }
  if (inv.issue_date > receiptDate) return { code: "invoice_after_receipt", message: `La factura ${name} es del ${inv.issue_date}, posterior al recibo (${receiptDate})` };
  return null;
}

/** What is open of an invoice: total + debit notes − credit notes − what the posted receipts settled (to the cent). */
export const openOf = (inv: Pick<InvoiceFacts, "total" | "debited_amount" | "credited_amount">, settled: number): number =>
  (cents(num(inv.total)) + cents(num(inv.debited_amount)) - cents(num(inv.credited_amount)) - cents(settled)) / 100;

/**
 * The invoices named by `ids` (in the order of the lines, a repeated one is read once), checked visible to the caller (invoicing's published
 * view, security_invoker: an invoice the user cannot read cannot be paid by id; `invoice_not_found` names the lines), locked in id order
 * (invoicing.lock_invoices_for_payment: one lock order, no deadlock between receipts and applications) and read again as they stand under the
 * lock, with what the posted receipts and applications already settled of each (payments.allocated_company_amounts, read after the lock: a document
 * that committed meanwhile counts).
 */
export async function lockInvoices(ctx: ProcessContext, ids: readonly string[]): Promise<{ locked: Map<string, InvoiceFacts>; settled: Map<string, number>; settledCompany: Map<string, number> }> {
  const unique = [...new Set(ids)].sort();
  const visible = new Set((await ctx.tx<{ id: string }[]>`select id from invoicing.v_receivable_invoices where id = any(${unique}::uuid[])`).map((r) => r.id));
  const missing = ids.flatMap((invoiceId, i) => (visible.has(invoiceId) ? [] : [`Línea ${i + 1}: la factura no existe o no es visible`]));
  if (missing.length > 0) refuse("invoice_not_found", missing);
  const locked = new Map((await ctx.tx<InvoiceFacts[]>`
    select id, party_id, number, issue_date::text as issue_date, currency, total::text, credited_amount::text, debited_amount::text, stage, status, dian_status, annulment_pending
    from invoicing.lock_invoices_for_payment(${unique}::uuid[])`).map((r) => [r.id, r]));
  // The frozen rate and pesos of each (an issued invoice never changes them; read under the lock from invoicing's published view).
  for (const r of await ctx.tx<{ id: string; exchange_rate: string; total_company: string }[]>`
    select id, exchange_rate::text, total_company::text from invoicing.v_receivable_invoices where id = any(${unique}::uuid[])`) {
    const inv = locked.get(r.id);
    if (inv) Object.assign(inv, { exchange_rate: r.exchange_rate, total_company: r.total_company });
  }
  const amounts = await ctx.tx<{ invoice_id: string; allocated: string; allocated_company: string }[]>`
    select invoice_id, allocated::text, allocated_company::text from payments.allocated_company_amounts(${unique}::uuid[])`;
  const settled = new Map(amounts.map((r) => [r.invoice_id, num(r.allocated)]));
  const settledCompany = new Map(amounts.map((r) => [r.invoice_id, num(r.allocated_company)]));
  return { locked, settled, settledCompany };
}

/**
 * What a foreign-currency allocation takes off the receivable, in pesos at the invoice's rate (FX §4, §5): `amount` × the rate, to the cent;
 * the allocation that settles what is open takes exactly what is left of the invoice's pesos (its total_company and its notes at its rate,
 * less what the posted receipts and applications already took), so a collection in full always closes the receivable in both currencies.
 */
export function carryingCompany(inv: InvoiceFacts, amount: number, open: number, settledCompany: number): number {
  const rate = num(inv.exchange_rate ?? 1);
  if (cents(amount) !== cents(open)) return companyCents(amount, rate) / 100;
  const notes = companyCents(num(inv.debited_amount), rate) - companyCents(num(inv.credited_amount), rate);
  return (cents(num(inv.total_company ?? inv.total)) + notes - cents(settledCompany)) / 100;
}

/**
 * The invoices of the allocations, locked (invoicing.lock_invoices_for_payment) and checked: the customer's own, issued, accepted by the
 * DIAN, in an allowed pair with the receipt's currency (R34-6), not after the receipt, no annulment in progress, each allocation within what
 * is open, no withholding on a foreign-currency invoice and, when pesos settle a foreign-currency invoice, the pesos received for it. Answers
 * each allocation with its invoice number and its three amounts.
 */
async function checkAllocations(
  ctx: ProcessContext, partyId: string, receiptDate: string, currency: string, companyCurrency: string, allocations: z.output<typeof allocationInput>[],
): Promise<PlannedAllocation[]> {
  if (allocations.length === 0) return [];
  const ids = allocations.map((a) => a.invoiceId);
  const repeated = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (repeated.length > 0) refuse("duplicate_invoice", ["Una factura va una sola vez en el recibo: suma lo que se le aplica en una línea"]);
  const { locked, settled, settledCompany } = await lockInvoices(ctx, ids);

  const errors: { code: string; message: string }[] = [];
  const planned = allocations.map((a, i): PlannedAllocation => {
    const inv = locked.get(a.invoiceId);
    const fail = (code: string, message: string) => errors.push({ code, message });
    const invoiceCurrency = inv?.currency.trim() ?? currency;
    let amountReceipt = a.amountReceipt ?? a.amount;
    let amountCompany = companyCents(a.amount, 1) / 100;
    if (!inv) fail("invoice_not_found", `Línea ${i + 1}: la factura no existe o no es visible`);
    else {
      const name = inv.number ?? `de la línea ${i + 1}`;
      const blocked = payability(inv, partyId, currency, receiptDate, name, companyCurrency);
      const foreign = invoiceCurrency !== companyCurrency;
      if (blocked) fail(blocked.code, blocked.message);
      else if (foreign && a.withholdings.length > 0) {
        fail("withholding_foreign_currency", `La factura ${name} está en ${invoiceCurrency}: un cliente del exterior no practica retenciones; registra el pago sin ellas`);
      } else if (foreign && currency !== invoiceCurrency && a.amountReceipt === undefined) {
        fail("amount_receipt_required", `La factura ${name} está en ${invoiceCurrency}: indica los ${currency} recibidos por los ${money(a.amount, invoiceCurrency)} que se aplican`);
      } else if (currency === invoiceCurrency && a.amountReceipt !== undefined && cents(a.amountReceipt) !== cents(a.amount)) {
        fail("amount_receipt_mismatch", `La factura ${name} está en la moneda del recibo: lo recibido por ella es lo aplicado (${money(a.amount, currency)})`);
      } else {
        const open = openOf(inv, settled.get(inv.id) ?? 0);
        if (cents(a.amount) > cents(open)) fail("allocation_exceeds_open", `La factura ${name} tiene un saldo de ${money(Math.max(open, 0), invoiceCurrency)}: no se le puede aplicar ${money(a.amount, invoiceCurrency)}`);
        if (currency === invoiceCurrency) amountReceipt = a.amount;
        amountCompany = foreign ? carryingCompany(inv, a.amount, open, settledCompany.get(inv.id) ?? 0) : a.amount;
      }
    }
    return { invoiceId: a.invoiceId, invoiceNumber: inv?.number ?? null, currency: invoiceCurrency, amount: a.amount, amountReceipt, amountCompany, withholdings: a.withholdings };
  });
  if (errors.length > 0) refuse(errors[0]!.code, errors.map((e) => e.message));
  return planned;
}

/** A replay of a receipt with this key that committed while this run waited for the key (the kernel's own check runs before the lock). */
async function storedReceipt(ctx: ProcessContext, key: string): Promise<ReceiptOutput | null> {
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`payments.receive:${ctx.companyId}:${key}`}, 0))`;
  const [stored] = await ctx.tx<{ result: ReceiptOutput }[]>`
    select result from kernel.process_idempotency where company_id = ${ctx.companyId} and process_id = 'payments.payment.receive' and key = ${`receive:${key}`}`;
  return stored?.result ?? null;
}

/**
 * The kinds of medio de pago the country pack maps to a cash or bank account (role cash, dimension payment_method:<kind>, its default role
 * mappings). A company that maps another kind itself is not consulted (it is accounting's table): such a kind is refused until the pack maps it.
 */
function mappedKinds(country: string): Set<string> {
  const prefix = "payment_method:";
  return new Set(countryPack(country).accounting.defaultRoleMappings()
    .filter((m) => m.role === "cash" && m.dimension?.startsWith(prefix))
    .map((m) => m.dimension!.slice(prefix.length)));
}

export const paymentReceive = defineProcess({
  id: "payments.payment.receive",
  module: "payments",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_RECEIPTS,
  emits: [PAYMENT_RECEIVED],
  description:
    "Registra un recibo de caja de un cliente: el valor recibido y el medio de pago, lo que se aplica a cada factura emitida y aceptada por la DIAN (sin superar su saldo) con las retenciones que el cliente practicó; lo no aplicado queda como anticipo. Lo numera y lo contabiliza en la misma operación (caja o bancos, retenciones, cuentas por cobrar y anticipos)",
  input: receiveInput,
  output: receiptOutput,
  idempotencyKey: (input) => (input.idempotencyKey ? `receive:${input.idempotencyKey}` : undefined),
  handler: async (ctx, input) => {
    if (input.idempotencyKey) {
      const stored = await storedReceipt(ctx, input.idempotencyKey);
      if (stored) return stored;
    }
    const now = await today(ctx);
    const on = input.date ?? now;
    if (on > now) refuse("receipt_in_future", [`El recibo no puede tener fecha posterior a hoy (${now}): registra el pago cuando se reciba`]);
    await readyCustomer(ctx, input.partyId);
    const [method] = await ctx.tx<{ code: string; kind: string; name: string; currency: string }[]>`select code, kind, name, currency from payments.methods where id = ${input.methodId} and deleted_at is null`;
    if (!method) refuse("invalid_method", ["El medio de pago no existe"]);
    const [company] = await ctx.tx<{ currency_code: string; country_code: string }[]>`select currency_code, country_code from kernel.companies where id = ${ctx.companyId}`;
    // The cash or bank account follows the method's kind (payment_method:<kind>): a kind the country pack maps to no account would fall back
    // to the caja without anyone choosing it, so it is refused.
    if (!mappedKinds(company!.country_code).has(method.kind)) {
      refuse("method_kind_unmapped", [`El medio de pago ${method.name} es de un tipo sin cuenta de caja o bancos asignada: usa un medio de efectivo, transferencia, tarjeta o cheque`]);
    }
    if (input.cashBoxId) {
      const [box] = await ctx.tx`select id from payments.cash_boxes where id = ${input.cashBoxId} and deleted_at is null`;
      if (!box) refuse("invalid_cash_box", ["La caja no existe"]);
      if (method.kind !== "cash") refuse("cash_box_not_cash", [`Una caja recibe efectivo: el medio ${method.name} no es de efectivo`]);
    }
    const companyCurrency = company!.currency_code.trim();
    // The receipt's currency is the money's: its method must receive it (FX §6), so the money lands in that method's account.
    const methodCurrency = method.currency.trim();
    const currency = input.currency ?? methodCurrency;
    if (currency !== methodCurrency) {
      refuse("method_currency_mismatch", [`El medio de pago ${method.name} recibe ${methodCurrency}: un recibo en ${currency} va por un medio de pago en ${currency}`]);
    }
    const exchangeRate = currency === companyCurrency ? 1 : (input.exchangeRate ?? (await defaultRate(ctx.tx, currency, on)));
    if (exchangeRate === null) refuse("exchange_rate_missing", [`No hay tasa de cambio para ${currency} el ${on}; regístrala en Tasas de cambio o escríbela en el recibo`]);
    const planned = await checkAllocations(ctx, input.partyId, on, currency, companyCurrency, input.allocations);
    // Counted in the receipt's currency: what it gave for each invoice (amountReceipt).
    const totals = receiptTotals(input.amount, planned.map((a) => ({ ...a, amount: a.amountReceipt ?? a.amount })), currency);
    if (!totals.ok) refuse(totals.code, totals.details);

    const [header] = await ctx.tx<{ id: string }[]>`
      insert into payments.receipts ${ctx.tx({
        company_id: ctx.companyId,
        date: on,
        party_id: input.partyId,
        method_id: input.methodId,
        method_code: method.code,
        cash_box_id: input.cashBoxId ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        currency,
        exchange_rate: exchangeRate,
        amount: input.amount,
        applied: totals.applied,
        withholding_total: totals.withholdingTotal,
        advance: totals.advance,
        // Applied in this very action: the validate hook (Grabar) refuses a Borrador that was never applied.
        applied_at: new Date(),
        // A receipt never waits for approval and always posts (ownFlags): explicit, so the Parámetros switches never apply.
        requires_approval: false,
        posts: true,
      })}
      returning id`;
    const receiptId = header!.id;
    if (planned.length > 0) {
      await ctx.tx`insert into payments.receipt_allocations ${ctx.tx(planned.map((a, i) => ({
        company_id: ctx.companyId,
        receipt_id: receiptId,
        line_no: i + 1,
        invoice_id: a.invoiceId,
        invoice_number: a.invoiceNumber,
        amount: a.amount,
        amount_receipt: a.amountReceipt ?? a.amount,
        amount_company: a.amountCompany ?? a.amount,
        cash_amount: totals.lines[i]!.cash,
        withholding_total: totals.lines[i]!.withholdingTotal,
        withholdings: ctx.tx.json(a.withholdings as never),
      })))}`;
    }
    // invoice_to_receipt, in this transaction (Task 31): one link per invoice the receipt applies to.
    await syncReceiptLinks(ctx, receiptId, planned.map((a) => a.invoiceId));
    // Grabar: the number (on save) and the posting (Contabiliza): the post hook emits payments.received, posted inline.
    await runLifecycle(ctx, ctx.registry.entity(receiptEntity.id), receiptId, "save");
    return outputOf(ctx, receiptId);
  },
});

/**
 * «Registrar pago»'s list of the customer's invoices (plan 2B Task 24b): the issued, not voided invoices of the customer the caller sees
 * (invoicing's published view, security_invoker, rule 3) with what is still open (payments.allocated_amounts: every posted receipt, the same
 * balance the receipt is checked against), and whether a receipt of `date` (default today) can pay each one, with why not (the same reasons
 * «Registrar pago» refuses with). An invoice fully settled is left out. The screen applies only to the payable ones; the server checks again.
 */
/**
 * The invoice fields the list shows or computes the open balance from (plan 2B Task 40, R40-2): each must be visible to the caller, else the
 * consult is `forbidden` (rule 14: masked figures are never answered, guessed or blanked). The process checks them itself (whole-branch review
 * F-5.4), as payments.advance.open does, so every channel gets the same answer; the web helper checks them too before calling.
 */
export const OPEN_INVOICES_FIELDS = ["number", "total", "paid_amount", "credited_amount", "debited_amount"] as const;

export const openInvoices = defineProcess({
  id: "payments.payment.open_invoices",
  module: "payments",
  kind: "consult",
  feature: FEATURE_RECEIPTS,
  description: "Consulta las facturas emitidas de un cliente con su saldo en su moneda y si un recibo de caja en la moneda indicada (la de la empresa si no se indica) puede pagarlas (aceptadas por la DIAN), o por qué no",
  input: z.object({ partyId: id, date: date.optional(), currency: z.string().trim().regex(/^[A-Z]{3}$/).optional() }).strict(),
  output: z.object({
    invoices: z.array(z.object({
      id: z.string(), number: z.string().nullable(), issueDate: z.string(), dueDate: z.string().nullable(), currency: z.string(), total: z.number(), open: z.number(),
      /** What is open in the invoice's currency (the same as `open`, named for the two-currency screens; plan 2B.2 Task 34.5). */
      openDoc: z.number(),
      payable: z.boolean(), reasonCode: z.string().nullable(), reason: z.string().nullable(),
    })),
  }),
  handler: async (ctx, { partyId, date: given, currency: receiptCurrency }) => {
    const [party] = await ctx.tx<{ id: string }[]>`select id from core.v_party_sales where id = ${partyId}`;
    if (!party) refuse("invalid_party", ["El cliente no existe o no es visible"]);
    // invoicing.v_receivable_invoices is published unmasked: a caller who may not see the invoice's number or amounts gets no list (F-5.4).
    for (const field of OPEN_INVOICES_FIELDS) {
      const [visible] = await ctx.tx<{ visible: boolean }[]>`select kernel.field_visible('invoicing.invoice', ${field}) as visible`;
      if (visible?.visible !== true) throw new ProcessError("forbidden", `payments.payment.open_invoices: the caller may not see invoicing.invoice.${field}`);
    }
    const on = given ?? (await today(ctx));
    const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
    const companyCurrency = company!.currency_code.trim();
    const currency = receiptCurrency ?? companyCurrency;
    const rows = await ctx.tx<(InvoiceFacts & { due_date: string | null })[]>`
      select id, party_id, number, issue_date::text as issue_date, due_date::text as due_date, currency, total::text, credited_amount::text, debited_amount::text,
             stage, status, dian_status, annulment_pending
      from invoicing.v_receivable_invoices
      where party_id = ${partyId} and stage <> 'draft' and status <> 'draft' and stage <> 'voided' and status <> 'voided'
      order by issue_date, number`;
    if (rows.length === 0) return { invoices: [] };
    const settled = new Map((await ctx.tx<{ invoice_id: string; allocated: string }[]>`
      select invoice_id, allocated::text from payments.allocated_amounts(${rows.map((r) => r.id)}::uuid[])`).map((r) => [r.invoice_id, num(r.allocated)]));
    return {
      invoices: rows.flatMap((inv) => {
        const open = openOf(inv, settled.get(inv.id) ?? 0);
        if (open <= 0) return [];
        const blocked = payability(inv, partyId, currency, on, inv.number ?? inv.id, companyCurrency);
        return [{
          id: inv.id, number: inv.number, issueDate: inv.issue_date, dueDate: inv.due_date, currency: inv.currency.trim(), total: num(inv.total), open, openDoc: open,
          payable: blocked === null, reasonCode: blocked?.code ?? null, reason: blocked?.message ?? null,
        }];
      }),
    };
  },
});

export const paymentVoid = defineProcess({
  id: "payments.payment.void",
  module: "payments",
  kind: "update",
  feature: FEATURE_RECEIPTS,
  sensitivity: "step-up",
  recordAccess: { entity: receiptEntity.id, idField: "id", right: "void" },
  emits: [PAYMENT_VOIDED],
  description:
    "Anula un recibo de caja con el motivo: las facturas recuperan su saldo y su asiento se revierte en la misma operación; el recibo queda anulado, nunca se borra",
  input: z.object({
    id,
    reason: z.string().trim().min(1, "Indica por qué se anula el recibo").max(1000),
    /** The date of the reversal; defaults to the company's today. */
    date: date.optional(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
  output: z.object({ id: z.string(), status: z.literal("voided"), number: z.string().nullable() }),
  handler: async (ctx, { id: receiptId, reason, date: given, expectedUpdatedAt }) => {
    const receipt = await readReceipt(ctx, receiptId, true);
    if (expectedUpdatedAt && new Date(receipt.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ProcessError("stale_record", `payments.receipt ${receiptId} changed since it was read`);
    }
    // The lifecycle's own table (D3) refuses a void from posted; a posted receipt is undone here, through the reversal path.
    if (receipt.status !== "posted") {
      throw new ProcessError("invalid_state", `payments.receipt ${receiptId}: void is not allowed in status ${receipt.status}`, { details: { from: receipt.status, action: "void" } });
    }
    // A live application draws on this receipt's advance: undoing it first keeps the advance from going below what the applications moved and the
    // reclass from being orphaned (Task 36, R36-8; the posted applications of the company whoever may read them).
    const [drawn] = await ctx.tx<{ applied: string }[]>`select applied::text from payments.advance_applied_amounts(array[${receiptId}]::uuid[])`;
    if (cents(num(drawn?.applied)) > 0) {
      refuseState("receipt_has_applications", [`El recibo ${receipt.number ?? receiptId} tiene aplicaciones de anticipo vigentes (${money(num(drawn!.applied), receipt.currency.trim())}): deshaz las aplicaciones antes de anularlo`]);
    }
    const on = given ?? (await today(ctx));
    if (on < receipt.date) refuse("void_before_receipt", [`La anulación (${on}) no puede ser anterior al recibo (${receipt.date})`]);
    const lines = await allocationsOf(ctx, receiptId);
    const [voided] = await ctx.tx<TypedRecord[]>`
      update payments.receipts set status = 'voided', void_reason = ${reason}, voided_at = now() where id = ${receiptId} returning *`;
    const entity = ctx.registry.entity(receiptEntity.id);
    await writeSnapshot(ctx, entity, receiptId, "voided", reason);
    await emitStatusChanged(ctx, entity, { id: receiptId, number: voided!.number }, "posted", "voided");
    // The void keeps the receipt's links, marked (Task 31).
    await markReceiptLinksVoided(ctx, receiptId, reason);
    // A receipt whose event is still parked (accounting was off) must never reach the ledger after this void: dismiss it.
    await dismissParkedEvents(ctx, PAYMENT_RECEIVED, { paymentId: receiptId });
    // The reversal of the receipt's entry, inline and strict: a closed period (or any refusal) undoes the whole void.
    await emitAndPostStrict(ctx, PAYMENT_VOIDED, voidedPayload({
      receiptId, number: receipt.number ?? receiptId, date: on, reason, partyId: receipt.party_id,
      allocations: lines.map((l) => ({ invoiceId: l.invoice_id, amount: num(l.amount) })),
    }), { requireRule: true });
    return { id: receiptId, status: "voided" as const, number: receipt.number };
  },
});

export const receiptConsult = defineProcess({
  id: "payments.receipt.consult",
  module: "payments",
  kind: "consult",
  feature: FEATURE_RECEIPTS,
  description: "Consulta un recibo de caja con lo que aplicó a cada factura, sus retenciones, el anticipo y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string(), allocations: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: receiptId }) => {
    const [row] = await ctx.tx`select * from payments.v_receipts where id = ${receiptId}`;
    if (!row) throw new ProcessError("not_found", `payments.receipt ${receiptId} not found`);
    const allocations = await ctx.tx<{ id: string }[]>`select * from payments.v_receipt_allocations where receipt_id = ${receiptId} order by line_no`;
    return { ...row, id: receiptId, extra: await visibleExtra(ctx, receiptEntity.id, row.extra), allocations };
  },
});

export const allocationConsult = defineProcess({
  id: "payments.receipt_allocation.consult",
  module: "payments",
  kind: "consult",
  feature: FEATURE_RECEIPTS,
  description: "Consulta lo que un recibo de caja aplicó a una factura: el valor, el efectivo y las retenciones",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from payments.v_receipt_allocations where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `payments.receipt_allocation ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The lifecycle hooks of a receipt (Grabar): it reaches the ledger only through payments.payment.receive (a Borrador never applied is
 * refused), once received it does not change (correcting it is Anular and receiving again), it numbers on save, and its post step emits the
 * event the ledger rules post.
 */
export const receiptHooks: TypedHooks = {
  async validate(_ctx, record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (previous.status === "draft" && !record.applied_at) {
      refuse("invalid_receipt", ["Un recibo de caja se registra con «Registrar pago», que lo aplica a las facturas"]);
    }
    if (previous.status !== "draft" && data && Object.keys(data).length > 0) {
      refuseState("receipt_posted", ["Un recibo de caja registrado no cambia: anúlalo y registra otro"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select payments.next_document_number(${ctx.companyId}, ${RECEIPT_PREFIX}) as number`;
    return row!.number;
  },
  async post(ctx, record) {
    const r = await readReceipt(ctx, record.id);
    const lines = await allocationsOf(ctx, record.id);
    const [fiscal] = await ctx.tx<{ legal_name: string | null; document_number: string | null }[]>`select legal_name, document_number from core.v_party_fiscal where id = ${r.party_id}`;
    const [method] = await ctx.tx<{ kind: string }[]>`select kind from payments.methods where id = ${r.method_id}`;
    const payload = receivedPayload({
      receiptId: r.id,
      number: r.number ?? (record.number as string),
      date: r.date,
      methodKind: method!.kind,
      methodCode: r.method_code,
      methodId: r.method_id,
      cashBoxId: r.cash_box_id,
      reference: r.reference,
      currency: r.currency.trim(),
      exchangeRate: num(r.exchange_rate),
      amount: num(r.amount),
      customer: { partyId: r.party_id, legalName: fiscal?.legal_name ?? fiscal?.document_number ?? r.party_id },
      allocations: lines.map((l) => ({
        invoiceId: l.invoice_id, invoiceNumber: l.invoice_number, currency: l.invoice_currency?.trim() ?? r.currency.trim(), amount: num(l.amount),
        amountReceipt: num(l.amount_receipt), amountCompany: num(l.amount_company),
        withholdings: (l.withholdings ?? []).map((w) => ({ kind: w.kind, code: w.code, rate: Number(w.rate), base: Number(w.base), amount: Number(w.amount) })),
      })),
    });
    // Inline and strict (D8): the entry is in the ledger when this action commits, or the action does not happen.
    await emitAndPostStrict(ctx, PAYMENT_RECEIVED, payload, { requireRule: true });
  },
};

/**
 * Eliminar of the record frame (a Borrador only, design §22.23): the generic `payments.receipt.delete`, still a delete process (same id,
 * same audit label), with the receipt's links taken away first (Task 31): the kernel lets a delete process unlink its own document
 * (`ctx.links.sync` with `from: []`) and nothing else.
 */
const genericDelete = genericProcess({ id: receiptEntity.id, module: "payments", entityType: "documento" }, "delete");
export const receiptDelete = {
  ...genericDelete,
  feature: FEATURE_RECEIPTS,
  handler: async (ctx: ProcessContext, input: unknown) => {
    const receipt = await readReceipt(ctx, (input as { id: string }).id, true);
    await syncReceiptLinks(ctx, receipt.id, []);
    return genericDelete.handler(ctx, input);
  },
} as ProcessDef;

export const RECEIPT_PROCESSES = [receiptDelete, paymentReceive, paymentVoid, openInvoices, receiptConsult, allocationConsult];
