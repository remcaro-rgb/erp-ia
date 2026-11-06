import { describe, expect, it } from "vitest";
import { addWithholding, parseAmount, receiptDraft, receiptInput, receiptMissing, receiptTotals, setWithholding, withholdingAmount, type ReceiptDraft } from "../receipt-form-model";

// «Registrar pago» (plan 2B Task 24b, accounting design §5.4): what the user types (the money received, what to apply to each open invoice,
// the withholdings the customer practised on it) and the totals the form shows as it is typed: the cash applied, the withholdings and the
// advance (what is not applied). The server checks everything again (payments.payment.receive); this is only what the screen shows.

const invoices = [
  { id: "i1", number: "FE1", open: 147700, payable: true },
  { id: "i2", number: "FE2", open: 238000, payable: false },
];

describe("money as typed", () => {
  it("reads the es-CO forms: thousands dots, a decimal comma, plain digits", () => {
    expect(parseAmount("144350")).toBe(144350);
    expect(parseAmount("144.350")).toBe(144350);
    expect(parseAmount("1.234.567,89")).toBe(1234567.89);
    expect(parseAmount("2,5")).toBe(2.5);
    expect(parseAmount("2.5")).toBe(2.5);
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("12a")).toBeNaN();
  });

  it("a withholding is base × rate, to the cent", () => {
    expect(withholdingAmount(134000, 2.5)).toBe(3350);
    expect(withholdingAmount(100001, 0.966)).toBe(966.01);
  });
});

describe("receipt drafts", () => {
  it("starts today with nothing applied, and misses the customer, the method and the money", () => {
    const draft = receiptDraft("2026-11-05");
    expect(draft).toMatchObject({ date: "2026-11-05", partyId: "", methodId: "", amount: "", allocations: {} });
    expect(receiptMissing(draft)).toEqual(["party", "method", "amount"]);
  });

  it("a copy (Duplicar) keeps the customer, the method and the caja only", () => {
    const draft = receiptDraft("2026-11-05", { party_id: "p1", method_id: "m1", cash_box_id: "b1", amount: 5000, reference: "X" }, { party_id: "Tienda El Maizal S.A.S." });
    expect(draft).toMatchObject({ partyId: "p1", partyLabel: "Tienda El Maizal S.A.S.", methodId: "m1", cashBoxId: "b1", amount: "", reference: "" });
  });

  it("the value of a withholding follows its base and rate until the user types it", () => {
    let draft: ReceiptDraft = { ...receiptDraft("2026-11-05"), allocations: { i1: { amount: "147700", withholdings: [] } } };
    draft = addWithholding(draft, "i1");
    draft = setWithholding(draft, "i1", 0, { kind: "income", code: "RTEFTE", rate: "2,5" });
    draft = setWithholding(draft, "i1", 0, { base: "134000" });
    expect(draft.allocations.i1!.withholdings[0]!.amount).toBe("3350");
    draft = setWithholding(draft, "i1", 0, { amount: "3351" });
    draft = setWithholding(draft, "i1", 0, { base: "134001" });
    expect(draft.allocations.i1!.withholdings[0]!.amount).toBe("3351");
  });

  it("totals: what is applied, the withholdings, the cash applied and the advance; money short of the cash applied is flagged", () => {
    const base: ReceiptDraft = {
      ...receiptDraft("2026-11-05"),
      partyId: "p1",
      methodId: "m1",
      amount: "144350",
      allocations: { i1: { amount: "147700", withholdings: [{ key: "w", kind: "income", code: "RTEFTE", rate: "2,5", base: "134000", amount: "3350", typed: false }] } },
    };
    expect(receiptTotals(base, invoices)).toEqual({ applied: 147700, withholdings: 3350, cash: 144350, received: 144350, advance: 0, short: false, over: [] });
    expect(receiptTotals({ ...base, amount: "160000" }, invoices)).toMatchObject({ advance: 15650, short: false });
    expect(receiptTotals({ ...base, amount: "100000" }, invoices)).toMatchObject({ advance: 0, short: true });
    // An allocation above what is open, or on an invoice that cannot be paid, does not count and is named.
    const over = receiptTotals({ ...base, allocations: { ...base.allocations, i2: { amount: "10", withholdings: [] }, i1: { ...base.allocations.i1!, amount: "200000" } } }, invoices);
    expect(over.over).toEqual(["i1"]);
    expect(over.applied).toBe(0);
    expect(receiptMissing(base)).toEqual([]);
    expect(receiptMissing({ ...base, amount: "100000" }, invoices)).toEqual(["cash_short"]);
  });

  it("builds the process's input: the payable invoices with an amount, their withholdings, the idempotency key", () => {
    const draft: ReceiptDraft = {
      ...receiptDraft("2026-11-05"),
      partyId: "p1",
      methodId: "m1",
      cashBoxId: "b1",
      amount: "120.000",
      reference: " TRF-1 ",
      allocations: {
        i1: { amount: "100000", withholdings: [{ key: "w", kind: "income", code: "RTEFTE", rate: "2,5", base: "80000", amount: "2000", typed: false }] },
        i2: { amount: "5", withholdings: [] },
      },
    };
    expect(receiptInput(draft, invoices, "k-1")).toEqual({
      partyId: "p1",
      methodId: "m1",
      cashBoxId: "b1",
      date: "2026-11-05",
      amount: 120000,
      reference: "TRF-1",
      allocations: [{ invoiceId: "i1", amount: 100000, withholdings: [{ kind: "income", code: "RTEFTE", rate: 2.5, base: 80000, amount: 2000 }] }],
      idempotencyKey: "k-1",
    });
  });
});
