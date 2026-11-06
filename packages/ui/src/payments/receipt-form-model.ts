// «Registrar pago» (plan 2B Task 24b; accounting design §5.4: the withholdings a customer practises are recognised when it pays): the
// draft the form keeps while the user types (the customer, the medio de pago, the caja, the date, the money received, what to apply to each
// open invoice of the customer and the withholdings practised on it), the live totals (cash applied, withholdings, advance) and the input of
// payments.payment.receive. Pure, so the arithmetic is unit-tested; the server checks everything again (rule 1).

export type WithholdingKindDraft = "" | "income" | "vat" | "ica";

export interface WithholdingDraft {
  /** A stable key for React. */
  key: string;
  kind: WithholdingKindDraft;
  /** The concept code of the customer's certificate (RTEFTE…). */
  code: string;
  /** As typed (es-CO: `2,5`). */
  rate: string;
  base: string;
  amount: string;
  /** The user typed the value: it no longer follows base × rate. */
  typed: boolean;
}

export interface AllocationDraft {
  /** What to apply to the invoice (cash + withholdings), as typed. */
  amount: string;
  withholdings: WithholdingDraft[];
}

export interface ReceiptDraft {
  partyId: string;
  partyLabel: string;
  methodId: string;
  cashBoxId: string;
  date: string;
  amount: string;
  reference: string;
  notes: string;
  /** By invoice id. */
  allocations: Record<string, AllocationDraft>;
}

/** An open invoice of the customer as the form lists it (payments.payment.open_invoices). */
export interface OpenInvoiceRow {
  id: string;
  number: string | null;
  open: number;
  payable: boolean;
}

/** What the form still lacks before «Registrar pago» can run. */
export type ReceiptMissing = "party" | "method" | "amount" | "cash_short" | "over_open" | "withholding";

/** A number as typed in es-CO: `1.234.567,89`, `144.350` (thousands), `2,5`, `2.5`, `144350`; NaN when it is not one. */
export function parseAmount(text: string): number {
  const t = text.trim().replace(/\s/g, "");
  if (t === "") return Number.NaN;
  let normal: string;
  if (t.includes(",")) normal = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) normal = t.replace(/\./g, "");
  else normal = t;
  return /^\d+(\.\d+)?$/.test(normal) ? Number(normal) : Number.NaN;
}

const cents = (n: number) => Math.round(n * 100);

/** A withholding's value: base × rate %, to the cent (the server allows $ 0,50 of rounding). */
export const withholdingAmount = (base: number, rate: number): number => Math.round(cents(base) * rate / 100) / 100;

/** A computed amount as the box shows it (`3350`, `966,01`). */
const shown = (n: number) => String(n).replace(".", ",");

let seq = 0;

/** A new receipt's draft: today, nothing applied. A copy (Duplicar) keeps the customer, the method and the caja only. */
export function receiptDraft(today: string, copy?: Readonly<Record<string, unknown>> | null, labels: Readonly<Record<string, string>> = {}): ReceiptDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const partyId = s(copy?.party_id);
  return {
    partyId,
    partyLabel: partyId ? (labels.party_id ?? partyId) : "",
    methodId: s(copy?.method_id),
    cashBoxId: s(copy?.cash_box_id),
    date: today,
    amount: "",
    reference: "",
    notes: "",
    allocations: {},
  };
}

/** A new empty withholding line on the invoice's allocation. */
export function addWithholding(draft: ReceiptDraft, invoiceId: string): ReceiptDraft {
  const current = draft.allocations[invoiceId] ?? { amount: "", withholdings: [] };
  const line: WithholdingDraft = { key: `w${++seq}`, kind: "income", code: "", rate: "", base: "", amount: "", typed: false };
  return { ...draft, allocations: { ...draft.allocations, [invoiceId]: { ...current, withholdings: [...current.withholdings, line] } } };
}

/** Removes the withholding line `index` of the invoice's allocation. */
export function removeWithholding(draft: ReceiptDraft, invoiceId: string, index: number): ReceiptDraft {
  const current = draft.allocations[invoiceId];
  if (!current) return draft;
  return { ...draft, allocations: { ...draft.allocations, [invoiceId]: { ...current, withholdings: current.withholdings.filter((_, i) => i !== index) } } };
}

/** Changes a withholding line; its value follows base × rate until the user types it. */
export function setWithholding(draft: ReceiptDraft, invoiceId: string, index: number, patch: Partial<Omit<WithholdingDraft, "key" | "typed">>): ReceiptDraft {
  const current = draft.allocations[invoiceId];
  if (!current) return draft;
  const withholdings = current.withholdings.map((w, i) => {
    if (i !== index) return w;
    const next = { ...w, ...patch, typed: w.typed || patch.amount !== undefined };
    if (!next.typed) {
      const base = parseAmount(next.base);
      const rate = parseAmount(next.rate);
      next.amount = Number.isFinite(base) && Number.isFinite(rate) ? shown(withholdingAmount(base, rate)) : "";
    }
    return next;
  });
  return { ...draft, allocations: { ...draft.allocations, [invoiceId]: { ...current, withholdings } } };
}

/** What to apply to an invoice, as typed. */
export function setApplied(draft: ReceiptDraft, invoiceId: string, amount: string): ReceiptDraft {
  const current = draft.allocations[invoiceId] ?? { amount: "", withholdings: [] };
  return { ...draft, allocations: { ...draft.allocations, [invoiceId]: { ...current, amount } } };
}

interface CountedAllocation {
  invoiceId: string;
  applied: number;
  withholdings: { kind: Exclude<WithholdingKindDraft, "">; code: string; rate: number; base: number; amount: number }[];
  complete: boolean;
}

/** The allocations that count: on a payable invoice, with an amount above zero and within what is open. */
function counted(draft: ReceiptDraft, invoices: readonly OpenInvoiceRow[]): { lines: CountedAllocation[]; over: string[] } {
  const lines: CountedAllocation[] = [];
  const over: string[] = [];
  for (const inv of invoices) {
    const a = draft.allocations[inv.id];
    if (!inv.payable || !a) continue;
    const applied = parseAmount(a.amount);
    if (!Number.isFinite(applied) || applied <= 0) continue;
    if (cents(applied) > cents(inv.open)) {
      over.push(inv.id);
      continue;
    }
    let complete = true;
    const withholdings = a.withholdings.flatMap((w) => {
      const rate = parseAmount(w.rate);
      const base = parseAmount(w.base);
      const amount = parseAmount(w.amount);
      if (w.kind === "" || w.code.trim() === "" || !(rate > 0) || !(base > 0) || !(amount > 0)) {
        complete = false;
        return [];
      }
      return [{ kind: w.kind, code: w.code.trim(), rate, base, amount }];
    });
    lines.push({ invoiceId: inv.id, applied, withholdings, complete });
  }
  return { lines, over };
}

export interface ReceiptTotalsView {
  /** What the receipt settles of the invoices (cash + withholdings). */
  applied: number;
  withholdings: number;
  /** What of the money received goes to the invoices. */
  cash: number;
  received: number;
  /** What is left of the money received: the customer's advance. */
  advance: number;
  /** The money received does not cover the cash applied. */
  short: boolean;
  /** Invoices whose amount exceeds what is open (they do not count). */
  over: string[];
}

/** The live totals of the form. */
export function receiptTotals(draft: ReceiptDraft, invoices: readonly OpenInvoiceRow[]): ReceiptTotalsView {
  const { lines, over } = counted(draft, invoices);
  const applied = lines.reduce((s, l) => s + cents(l.applied), 0);
  const held = lines.reduce((s, l) => s + l.withholdings.reduce((t, w) => t + cents(w.amount), 0), 0);
  const typed = parseAmount(draft.amount);
  const received = Number.isFinite(typed) ? cents(typed) : 0;
  const cash = applied - held;
  return { applied: applied / 100, withholdings: held / 100, cash: cash / 100, received: received / 100, advance: Math.max(received - cash, 0) / 100, short: received < cash, over };
}

/** What the form lacks; the totals' checks only when the invoices are given. */
export function receiptMissing(draft: ReceiptDraft, invoices?: readonly OpenInvoiceRow[]): ReceiptMissing[] {
  const missing: ReceiptMissing[] = [];
  if (!draft.partyId) missing.push("party");
  if (!draft.methodId) missing.push("method");
  const amount = parseAmount(draft.amount);
  if (!Number.isFinite(amount)) missing.push("amount");
  if (invoices && missing.length === 0) {
    const totals = receiptTotals(draft, invoices);
    if (totals.short) missing.push("cash_short");
    if (totals.over.length > 0) missing.push("over_open");
    if (counted(draft, invoices).lines.some((l) => !l.complete)) missing.push("withholding");
  }
  return missing;
}

/** The input of payments.payment.receive: the payable invoices with an amount, their withholdings, one idempotency key per form. */
export function receiptInput(draft: ReceiptDraft, invoices: readonly OpenInvoiceRow[], idempotencyKey: string): Record<string, unknown> {
  const { lines } = counted(draft, invoices);
  const reference = draft.reference.trim();
  const notes = draft.notes.trim();
  return {
    partyId: draft.partyId,
    methodId: draft.methodId,
    ...(draft.cashBoxId ? { cashBoxId: draft.cashBoxId } : {}),
    date: draft.date,
    amount: parseAmount(draft.amount),
    ...(reference ? { reference } : {}),
    ...(notes ? { notes } : {}),
    allocations: lines.map((l) => ({ invoiceId: l.invoiceId, amount: l.applied, withholdings: l.withholdings })),
    idempotencyKey,
  };
}
