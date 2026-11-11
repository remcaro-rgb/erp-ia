import { describe, expect, it } from "vitest";
import { noteCopy, noteDraft, noteInput, noteMissing } from "../note-form-model";

// The credit or debit note written from its invoice (plan 2B Task 20, DIAN tables 13.2.4 / 13.2.5): the concept, the reason and how much
// of each invoice line it corrects; a credit never takes more than the line billed (the process checks what is left of the invoice).
const lines = [
  { id: "l1", line_no: 1, description: "Café Origen Huila 500 g", qty: "3.0000", unit_price: "28000.0000" },
  { id: "l2", line_no: 2, description: "Instalación de molino", qty: "1", unit_price: "50000" },
];

describe("note drafts", () => {
  it("starts with the invoice's lines, nothing typed, and misses the concept, the reason and a line", () => {
    const draft = noteDraft("credit", lines);
    expect(draft.lines.map((l) => [l.invoiceLineId, l.lineNo, l.invoicedQty, l.qty, l.unitPrice])).toEqual([["l1", 1, 3, "", ""], ["l2", 2, 1, "", ""]]);
    expect(noteMissing(draft)).toEqual(["concept", "reason", "lines"]);
  });

  it("sends only the lines with a quantity, a price only when typed", () => {
    const draft = { ...noteDraft("credit", lines), concept: "1", reason: " Devolución de una bolsa " };
    draft.lines[0]!.qty = "1";
    expect(noteMissing(draft)).toEqual([]);
    expect(noteInput("inv-1", draft)).toEqual({ invoiceId: "inv-1", kind: "credit", concept: "1", reason: "Devolución de una bolsa", lines: [{ invoiceLineId: "l1", qty: 1 }] });
    draft.lines[1]!.qty = "1";
    draft.lines[1]!.unitPrice = "10.000";
    expect(noteInput("inv-1", draft).lines).toEqual([{ invoiceLineId: "l1", qty: 1 }, { invoiceLineId: "l2", qty: 1, unitPrice: 10000 }]);
  });

  it("a credit takes no more than the line billed; a debit may add more; a quantity must be positive", () => {
    const credit = { ...noteDraft("credit", lines), concept: "1", reason: "x" };
    credit.lines[0]!.qty = "4";
    expect(noteMissing(credit)).toEqual(["qty"]);
    const debit = { ...noteDraft("debit", lines), concept: "3", reason: "x" };
    debit.lines[0]!.qty = "4";
    expect(noteMissing(debit)).toEqual([]);
    debit.lines[0]!.qty = "0";
    expect(noteMissing(debit)).toEqual(["lines"]);
    debit.lines[0]!.qty = "-1";
    expect(noteMissing(debit)).toEqual(["qty"]);
  });
});

describe("Duplicar a note (rule 37, Task 20 fix round 1)", () => {
  it("starts the invoice's note panel from the source note: its concept, reason and quantities; a price only when it differs from the line's", () => {
    const source = { kind: "credit" as const, concept: "1", reason: "Devolución", lines: [{ invoice_line_id: "l1", qty: "1.5000", unit_price: "28000.0000" }, { invoice_line_id: "l2", qty: "1", unit_price: "45000" }] };
    const draft = noteCopy(source, lines);
    expect(draft.kind).toBe("credit");
    expect([draft.concept, draft.reason]).toEqual(["1", "Devolución"]);
    expect(draft.lines.map((l) => [l.invoiceLineId, l.qty, l.unitPrice])).toEqual([["l1", "1,5", ""], ["l2", "1", "45000"]]);
    expect(noteInput("inv-1", draft).lines).toEqual([{ invoiceLineId: "l1", qty: 1.5 }, { invoiceLineId: "l2", qty: 1, unitPrice: 45000 }]);
  });

  it("never copies a concept the panel does not offer (the annulment's): the user picks one", () => {
    const draft = noteCopy({ kind: "credit", concept: "2", reason: "x", lines: [] }, lines, ["1", "3"]);
    expect(draft.concept).toBe("");
  });
});
