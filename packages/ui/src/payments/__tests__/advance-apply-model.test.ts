import { describe, expect, it } from "vitest";
import { applyCap, applyInput, applyTotals, hasNotAcceptedInvoice, setAmount } from "../advance-apply-model";

// «Aplicar a facturas» on a receipt with an advance (plan 2B.2 Task 36, R36-9): each line is capped by what the invoice has open and by what is
// left of the advance (net of the other lines). The server checks everything again (payments.advance.apply); this is what the screen shows.

const invoices = [
  { id: "i1", number: "FE1", open: 300000, payable: true },
  { id: "i2", number: "FE2", open: 400000, payable: true },
  { id: "i3", number: "FE3", open: 100000, payable: false },
];

describe("the cap of a line", () => {
  it("is the invoice's open balance when the advance covers it", () => {
    expect(applyCap(1_000_000, invoices[0]!, {})).toBe(300000);
  });

  it("is what is left of the advance when that is less than the open balance", () => {
    expect(applyCap(250000, invoices[0]!, {})).toBe(250000);
  });

  it("subtracts what the other lines already take from the advance", () => {
    expect(applyCap(500000, invoices[1]!, setAmount({}, "i1", "300000"))).toBe(200000);
    // the line's own amount does not count against itself
    expect(applyCap(500000, invoices[0]!, setAmount({}, "i1", "300000"))).toBe(300000);
  });

  it("never goes below zero and works in cents", () => {
    expect(applyCap(0.1 + 0.2, invoices[0]!, {})).toBe(0.3);
    expect(applyCap(100, invoices[1]!, setAmount({}, "i1", "100"))).toBe(0);
  });
});

describe("the totals", () => {
  it("add the lines on payable invoices and say what is left", () => {
    const amounts = setAmount(setAmount({}, "i1", "100.000"), "i2", "50.000,50");
    expect(applyTotals(500000, invoices, amounts)).toMatchObject({ total: 150000.5, left: 349999.5, over: [], exceeds: false });
  });

  it("flag a line above the invoice's open balance and a total above the advance", () => {
    expect(applyTotals(1_000_000, invoices, setAmount({}, "i1", "300.001")).over).toEqual(["i1"]);
    const both = applyTotals(400000, invoices, setAmount(setAmount({}, "i1", "300000"), "i2", "200000"));
    expect(both.exceeds).toBe(true);
    expect(both.over).toEqual([]);
  });

  it("ignore an invoice that is not payable, an empty amount and one that is not a number", () => {
    const amounts = setAmount(setAmount(setAmount({}, "i3", "10000"), "i1", ""), "i2", "abc");
    expect(applyTotals(500000, invoices, amounts)).toMatchObject({ total: 0, over: [], exceeds: false });
  });
});

describe("the input of payments.advance.apply", () => {
  it("lists one line per payable invoice with an amount, for the receipt, with the key", () => {
    const amounts = setAmount(setAmount({}, "i1", "100000"), "i2", "20,5");
    expect(applyInput("p1", "r1", invoices, amounts, "key-1")).toEqual({
      partyId: "p1",
      lines: [{ receiptId: "r1", invoiceId: "i1", amount: 100000 }, { receiptId: "r1", invoiceId: "i2", amount: 20.5 }],
      idempotencyKey: "key-1",
    });
  });

  it("is null when there is nothing to apply or the form is over what it may take", () => {
    expect(applyInput("p1", "r1", invoices, {}, "k", 500000)).toBeNull();
    expect(applyInput("p1", "r1", invoices, setAmount({}, "i1", "300001"), "k", 500000)).toBeNull();
    expect(applyInput("p1", "r1", invoices, setAmount({}, "i1", "300000"), "k", 200000)).toBeNull();
    expect(applyInput("p1", "r1", invoices, setAmount({}, "i1", "300000"), "k", 300000)).not.toBeNull();
  });
});

describe("the DIAN hint", () => {
  it("shows when a listed invoice is not accepted yet, and only then", () => {
    expect(hasNotAcceptedInvoice([{ reasonCode: null }, { reasonCode: "invoice_not_accepted" }])).toBe(true);
    expect(hasNotAcceptedInvoice([{ reasonCode: null }, { reasonCode: "invoice_voided" }])).toBe(false);
    expect(hasNotAcceptedInvoice([])).toBe(false);
  });
});
