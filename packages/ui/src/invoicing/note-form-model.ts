// A credit or debit note written from the invoice it corrects (plan 2B Task 20, design §8.1, DIAN tables 13.2.4 credit / 13.2.5 debit): its
// concept, its reason and how much of each invoice line it corrects (the quantity, and the net unit price when it is not the line's).
// Pure, so what invoicing.note.create takes and what a draft still misses are unit-tested; the panel only draws them. A credit never takes
// more than the line billed (the process checks it against what is left of the whole invoice: credit_exceeds_invoice).

import { parseQty } from "../inventory/stock-form-model";
import { parseMoney } from "../money/format";

export type NoteKind = "credit" | "debit";

export interface NoteLineDraft {
  invoiceLineId: string;
  lineNo: number;
  label: string;
  /** What the invoice line billed. */
  invoicedQty: number;
  /** As typed; empty or zero: the line is not corrected. */
  qty: string;
  /** As typed; empty: the invoice line's net unit price. */
  unitPrice: string;
}

export interface NoteDraft {
  kind: NoteKind;
  concept: string;
  reason: string;
  lines: NoteLineDraft[];
}

type Row = Readonly<Record<string, unknown>>;

/** The draft of a new note of `kind` over the invoice's lines (as its lines grid reads them). */
export function noteDraft(kind: NoteKind, invoiceLines: readonly Row[]): NoteDraft {
  return {
    kind,
    concept: "",
    reason: "",
    lines: invoiceLines.map((l) => ({
      invoiceLineId: String(l.id),
      lineNo: Number(l.line_no ?? 0),
      label: String(l.description ?? l.product_id_label ?? l.product_id ?? ""),
      invoicedQty: Number(l.qty ?? 0),
      qty: "",
      unitPrice: "",
    })),
  };
}

const typed = (l: NoteLineDraft) => l.qty.trim() !== "" && parseQty(l.qty) !== 0;

/** What the draft misses before it can be created: i18n keys under `invoicing.form.note_missing` (empty when complete). */
export function noteMissing(draft: NoteDraft): string[] {
  const missing: string[] = [];
  if (draft.concept === "") missing.push("concept");
  if (draft.reason.trim() === "") missing.push("reason");
  const chosen = draft.lines.filter(typed);
  // A quantity that is not a number or is negative; a credit above what the line billed.
  const badQty = draft.lines.some((l) => l.qty.trim() !== "" && !(parseQty(l.qty) >= 0)) || chosen.some((l) => draft.kind === "credit" && parseQty(l.qty) > l.invoicedQty);
  if (chosen.length === 0 && !badQty) missing.push("lines");
  if (badQty) missing.push("qty");
  if (chosen.some((l) => l.unitPrice.trim() !== "" && !((parseMoney(l.unitPrice) ?? Number.NaN) >= 0))) missing.push("price");
  return missing;
}

/** The input of invoicing.note.create: only the lines with a quantity typed. */
export function noteInput(invoiceId: string, draft: NoteDraft): { invoiceId: string; kind: NoteKind; concept: string; reason: string; lines: { invoiceLineId: string; qty: number; unitPrice?: number }[] } {
  return {
    invoiceId,
    kind: draft.kind,
    concept: draft.concept,
    reason: draft.reason.trim(),
    lines: draft.lines.filter(typed).map((l) => ({
      invoiceLineId: l.invoiceLineId,
      qty: parseQty(l.qty),
      ...(l.unitPrice.trim() !== "" ? { unitPrice: parseMoney(l.unitPrice) ?? Number.NaN } : {}),
    })),
  };
}

/** A stored note as Duplicar copies it: its kind, concept, reason and lines (the invoice line each corrects, its quantity and price). */
export interface NoteSource {
  kind: NoteKind;
  concept: string;
  reason: string;
  lines: readonly Row[];
}

/** A decimal as the panel's inputs show it (`1,5`). */
const typedNumber = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(n).replace(".", ",") : "";
};

/**
 * Duplicar a note (rule 37, Task 20 fix round 1): the invoice's note panel starts from the source note's concept, reason and quantities;
 * its identity (number, CUDE, dates, DIAN state) is never copied. A price is copied only when it is not the invoice line's own; a concept
 * the panel does not offer (`concepts`: the annulment's is Anular's alone) is left for the user to pick.
 */
export function noteCopy(source: NoteSource, invoiceLines: readonly Row[], concepts?: readonly string[]): NoteDraft {
  const base = noteDraft(source.kind, invoiceLines);
  const byLine = new Map(source.lines.map((l) => [String(l.invoice_line_id), l]));
  const priceOf = new Map(invoiceLines.map((l) => [String(l.id), Number(l.unit_price)]));
  return {
    ...base,
    concept: concepts && !concepts.includes(source.concept) ? "" : source.concept,
    reason: source.reason,
    lines: base.lines.map((l) => {
      const copied = byLine.get(l.invoiceLineId);
      if (!copied) return l;
      const price = Number(copied.unit_price);
      return { ...l, qty: typedNumber(copied.qty), unitPrice: Number.isFinite(price) && price !== priceOf.get(l.invoiceLineId) ? typedNumber(price) : "" };
    }),
  };
}
