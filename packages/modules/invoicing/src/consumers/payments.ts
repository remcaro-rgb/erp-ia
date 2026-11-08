import { defineProcess, ProcessError, type EventConsumer, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { FEATURE_INVOICES, id, num } from "../processes/common";

// The paid status of an invoice (plan 2B Task 23; design §8.1 step 7). Payments never writes an invoice (rule 3): invoicing consumes
// payments.received and payments.payment.voided by name and recomputes, for each invoice the receipt allocated, what the POSTED receipts
// settled of it (payments.allocated_amounts, payments' published definer function, every receipt of the company whoever may read it).
// It is recomputed, never added up, so a redelivered event, events out of order (a receipt voided before its received event is consumed)
// and a replay all leave the same paid_amount, the way sales recomputes invoiced_qty.
//
//   paid_amount = Σ allocations of the posted receipts (cash + the withholdings the customer practised: they settle the receivable too);
//   owed        = total + debit notes − credit notes;
//   stage       = paid when paid_amount > 0 and paid_amount ≥ owed, else issued. A Borrador and a voided (annulled) invoice never change.
//
// Both columns move in ONE statement (the check «a paid invoice has a paid amount», 0094; the frozen-invoice trigger lets exactly
// paid_amount and stage move). The invoice is taken FOR UPDATE first, in id order: the lock «Registrar pago»
// (invoicing.lock_invoices_for_payment), a note and Anular take, so the allocations read after it are the ones that committed.
// When an invoice BECOMES paid, invoicing.invoice.paid is emitted with the CRM's payload contract (Task 11): the invoice, its number, the
// customer, what was paid and the oportunidad of the pedido it bills (sales' published view), which the CRM logs a payment activity on.
// A receipt voided after that gives the amount back and the invoice goes back to issued; it is paid again (and the CRM told again, which
// logs once per invoice) when receipts cover it again.
//
// The same recomputation runs when a note changes what is owed (processes/note.ts): a credit note that covers what was still owed after
// a partial payment makes the invoice paid; a debit note on a paid invoice makes it owed again. A credit note on a paid invoice (a refund)
// is allowed: its credit goes beyond what is open, the invoice stays paid, what is open of it never goes below zero (v_open_invoices) and
// the excess is the customer's credit balance in the ledger (the aging's «Anticipos y saldos a favor», Task 22). Anular is refused while a
// posted receipt settles the invoice (void the receipt first): `allocatedTo` is read under the invoice's lock, so a receipt that has not
// reached this consumer yet still counts.

export const INVOICE_PAID = "invoicing.invoice.paid";
export const RECORD_PAYMENTS = "invoicing.invoice.record_payments";

/** What the posted receipts settled of each invoice (payments' published function; 0 when none), read in the caller's transaction. */
export async function allocatedTo(ctx: ProcessContext, invoiceIds: readonly string[]): Promise<Map<string, number>> {
  const settled = new Map(invoiceIds.map((i) => [i, 0]));
  if (invoiceIds.length === 0) return settled;
  const rows = await ctx.tx<{ invoice_id: string; allocated: string }[]>`select invoice_id, allocated::text from payments.allocated_amounts(${[...invoiceIds]}::uuid[])`;
  for (const r of rows) settled.set(r.invoice_id, num(r.allocated));
  return settled;
}

const cents = (n: number) => Math.round(n * 100);

interface InvoiceState { id: string; number: string | null; party_id: string; stage: string; total: string; credited_amount: string; debited_amount: string; paid_amount: string }

/** The oportunidad of the pedido an invoice bills (sales' published view, migration 0113): only when its pedidos name exactly one. */
async function opportunityOf(ctx: ProcessContext, invoiceId: string): Promise<string | undefined> {
  const rows = await ctx.tx<{ opportunity_id: string }[]>`
    select distinct ol.opportunity_id from invoicing.invoice_lines l join sales.v_invoice_order_lines ol on ol.id = l.order_line_id
    where l.invoice_id = ${invoiceId} and ol.opportunity_id is not null`;
  return rows.length === 1 ? rows[0]!.opportunity_id : undefined;
}

/**
 * Recomputes paid_amount and the paid stage of `invoiceIds` under their locks (FOR UPDATE, id order; already held by the caller is fine)
 * and emits invoicing.invoice.paid for each that becomes paid. Answers the invoices whose state changed.
 */
export async function refreshPaid(ctx: ProcessContext, invoiceIds: readonly string[]): Promise<{ id: string; stage: string; paidAmount: number }[]> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return [];
  const invoices = await ctx.tx<InvoiceState[]>`
    select id, number, party_id, stage, total::text, credited_amount::text, debited_amount::text, paid_amount::text
    from invoicing.invoices where id = any(${ids}::uuid[]) order by id for update`;
  const settled = await allocatedTo(ctx, ids);
  const changed: { id: string; stage: string; paidAmount: number }[] = [];
  for (const inv of invoices) {
    // A Borrador is never paid, and an annulled invoice never changes (no receipt can settle either: payments refuses them).
    if (inv.stage !== "issued" && inv.stage !== "paid") continue;
    const paid = settled.get(inv.id) ?? 0;
    const owed = cents(num(inv.total)) + cents(num(inv.debited_amount)) - cents(num(inv.credited_amount));
    const stage = cents(paid) > 0 && cents(paid) >= owed ? "paid" : "issued";
    if (stage === inv.stage && cents(paid) === cents(num(inv.paid_amount))) continue;
    await ctx.tx`update invoicing.invoices set paid_amount = ${paid}, stage = ${stage} where id = ${inv.id}`;
    changed.push({ id: inv.id, stage, paidAmount: paid });
    if (stage === "paid" && inv.stage !== "paid") {
      const opportunityId = await opportunityOf(ctx, inv.id);
      await ctx.emit(INVOICE_PAID, {
        invoiceId: inv.id,
        ...(inv.number ? { number: inv.number } : {}),
        partyId: inv.party_id,
        amount: paid,
        ...(opportunityId ? { opportunityId } : {}),
      });
    }
  }
  return changed;
}

export const invoiceRecordPayments = defineProcess({
  id: RECORD_PAYMENTS,
  module: "invoicing",
  kind: "update",
  // The invoices a receipt named (payments' event): no record of the caller's is changed.
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  emits: [INVOICE_PAID],
  description:
    "Registra en las facturas lo que les pagaron los recibos de caja vigentes (o les devolvió un recibo anulado) y las marca pagadas cuando quedan cubiertas; solo lo ejecuta el evento de pagos",
  input: z.object({ invoiceIds: z.array(id).min(1).max(100) }).strict(),
  output: z.object({ changed: z.array(z.object({ id: z.string(), stage: z.string(), paidAmount: z.number() })) }),
  handler: async (ctx, { invoiceIds }) => {
    // Only the caller's company's invoices exist under its RLS; another id is simply not found and changes nothing.
    return { changed: await refreshPaid(ctx, invoiceIds) };
  },
});

/** What invoicing reads of payments.received, payments.payment.voided and the advance applications' events: the invoices of the allocations. */
const allocationsPayload = z.looseObject({ paymentId: id, allocations: z.array(z.looseObject({ invoiceId: id })).default([]) });

const onAllocations = (event: string): EventConsumer => async (ctx, payload) => {
  const parsed = allocationsPayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${event} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const invoiceIds = [...new Set(parsed.data.allocations.map((a) => a.invoiceId))];
  // A receipt with no invoice (all advance) settles nothing of invoicing's.
  if (invoiceIds.length === 0) return;
  for (let i = 0; i < invoiceIds.length; i += 100) await ctx.runProcess(RECORD_PAYMENTS, { invoiceIds: invoiceIds.slice(i, i + 100) });
};

/** Consumer of payments.received: the invoices it settled are recomputed (paid_amount, the paid stage). */
export const onPaymentReceived: EventConsumer = onAllocations("payments.received");
/** Consumer of payments.payment.voided: the invoices it had settled get the amount back (recomputed; paid → issued). */
export const onPaymentVoided: EventConsumer = onAllocations("payments.payment.voided");

/**
 * Consumer of payments.advance.applied (plan 2B.2 Task 36, R36-4): the invoices an advance was applied to are recomputed, with the same function
 * and the same refreshPaid as a receipt (the payload carries `paymentId` = the application's id and `allocations` per invoice; the application's
 * lines count in payments.allocated_amounts, so paid_amount and the paid stage follow with no second status logic).
 */
export const onAdvanceApplied: EventConsumer = onAllocations("payments.advance.applied");
/** Consumer of payments.advance.unapplied: an undone application gives its amounts back to the invoices (recomputed; paid → issued). */
export const onAdvanceUnapplied: EventConsumer = onAllocations("payments.advance.unapplied");

export const PAYMENT_PROCESSES = [invoiceRecordPayments];
