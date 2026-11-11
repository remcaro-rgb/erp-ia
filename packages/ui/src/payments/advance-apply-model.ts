import { parseAmount, type OpenInvoiceRow } from "./receipt-form-model";

// «Aplicar a facturas» on a receipt that holds an advance (plan 2B.2 Task 36, R36-9): what the user types for each of the customer's payable
// invoices, capped by the invoice's open balance and by what is left of the advance (net of the other lines), the live totals and the input of
// payments.advance.apply. Pure, so the arithmetic is unit-tested in cents; the server checks everything again (rule 1).

/** What to apply to each invoice, as typed, by invoice id. */
export type ApplyAmounts = Readonly<Record<string, string>>;

const cents = (n: number) => Math.round(n * 100);

/** The invoice's amount as typed (`300.000`, `20,5`); null for an empty box, a non-number or zero. */
function typed(amounts: ApplyAmounts, invoiceId: string): number | null {
  const value = parseAmount(amounts[invoiceId] ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function setAmount(amounts: ApplyAmounts, invoiceId: string, value: string): ApplyAmounts {
  return { ...amounts, [invoiceId]: value };
}

/** The most the line of `invoice` may take: its open balance, or what the other lines leave of the advance when that is less (never below zero). */
export function applyCap(remaining: number, invoice: OpenInvoiceRow, amounts: ApplyAmounts): number {
  let others = 0;
  for (const key of Object.keys(amounts)) if (key !== invoice.id) others += cents(typed(amounts, key) ?? 0);
  return Math.max(Math.min(cents(invoice.open), cents(remaining) - others), 0) / 100;
}

export interface ApplyTotals {
  /** What the lines add up to. */
  total: number;
  /** What would be left of the advance. */
  left: number;
  /** Invoices whose amount exceeds what they have open. */
  over: string[];
  /** The lines add up to more than the advance has left. */
  exceeds: boolean;
}

/** The lines that count: on a payable invoice, with an amount above zero. */
function counted(invoices: readonly OpenInvoiceRow[], amounts: ApplyAmounts) {
  return invoices.flatMap((inv) => {
    const amount = inv.payable ? typed(amounts, inv.id) : null;
    return amount === null ? [] : [{ inv, amount }];
  });
}

export function applyTotals(remaining: number, invoices: readonly OpenInvoiceRow[], amounts: ApplyAmounts): ApplyTotals {
  const lines = counted(invoices, amounts);
  const total = lines.reduce((s, l) => s + cents(l.amount), 0);
  return {
    total: total / 100,
    left: (cents(remaining) - total) / 100,
    over: lines.filter((l) => cents(l.amount) > cents(l.inv.open)).map((l) => l.inv.id),
    exceeds: total > cents(remaining),
  };
}

/** The input of payments.advance.apply for the advance of `receiptId`; null while there is nothing to apply or a line or the total is over its cap. */
export function applyInput(partyId: string, receiptId: string, invoices: readonly OpenInvoiceRow[], amounts: ApplyAmounts, idempotencyKey: string, remaining = Number.POSITIVE_INFINITY): Record<string, unknown> | null {
  const lines = counted(invoices, amounts);
  if (lines.length === 0) return null;
  if (Number.isFinite(remaining) && applyTotals(remaining, invoices, amounts).exceeds) return null;
  if (lines.some((l) => cents(l.amount) > cents(l.inv.open))) return null;
  return { partyId, lines: lines.map((l) => ({ receiptId, invoiceId: l.inv.id, amount: l.amount })), idempotencyKey };
}

/** «Registrar pago»'s note: an invoice the DIAN has not accepted yet is in the list, so the money may be registered as an advance. */
export function hasNotAcceptedInvoice(invoices: readonly { reasonCode: string | null }[]): boolean {
  return invoices.some((inv) => inv.reasonCode === "invoice_not_accepted");
}
