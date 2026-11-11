import { describe, expect, it } from "vitest";
import { applicationPlan, splitCompany } from "../processes/advance";

// «Aplicar anticipo a factura» (plan 2B.2 Task 36, R36-1, R36-5, R36-6): the pure plan of an application over cents. The handler loads and
// locks the advance receipts and the invoices; this checks the sums against what each advance has left and each invoice has open.

const R1 = "0192b4c0-0000-7000-8000-0000000000a1";
const R2 = "0192b4c0-0000-7000-8000-0000000000a2";
const I1 = "0192b4c0-0000-7000-8000-0000000000b1";
const I2 = "0192b4c0-0000-7000-8000-0000000000b2";
const dates = { on: "2026-11-05", today: "2026-11-06" };

const advance = (receiptId: string, remaining: number, date = "2026-11-01") => ({ receiptId, number: `RC-${receiptId.slice(-1)}`, date, remaining });
const invoice = (invoiceId: string, open: number) => ({ invoiceId, number: `FE-${invoiceId.slice(-1)}`, open });

describe("applicationPlan", () => {
  it("one advance fully to one invoice", () => {
    const plan = applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 500000 }], [advance(R1, 500000)], [invoice(I1, 500000)], dates);
    expect(plan).toEqual({
      ok: true, total: 500000,
      byInvoice: [{ invoiceId: I1, invoiceNumber: "FE-1", amount: 500000 }],
      byReceipt: [{ receiptId: R1, receiptNumber: "RC-1", amount: 500000 }],
    });
  });

  it("a partial application leaves the rest of both", () => {
    const plan = applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 120000 }], [advance(R1, 500000)], [invoice(I1, 300000)], dates);
    expect(plan).toMatchObject({ ok: true, total: 120000, byInvoice: [{ amount: 120000 }], byReceipt: [{ amount: 120000 }] });
  });

  it("one advance over two invoices (many to many)", () => {
    const plan = applicationPlan(
      [{ receiptId: R1, invoiceId: I1, amount: 200000 }, { receiptId: R1, invoiceId: I2, amount: 300000 }],
      [advance(R1, 500000)], [invoice(I1, 200000), invoice(I2, 400000)], dates,
    );
    expect(plan).toMatchObject({
      ok: true, total: 500000,
      byInvoice: [{ invoiceId: I1, amount: 200000 }, { invoiceId: I2, amount: 300000 }],
      byReceipt: [{ receiptId: R1, amount: 500000 }],
    });
  });

  it("two advances over one invoice", () => {
    const plan = applicationPlan(
      [{ receiptId: R1, invoiceId: I1, amount: 100000 }, { receiptId: R2, invoiceId: I1, amount: 50000 }],
      [advance(R1, 100000), advance(R2, 80000)], [invoice(I1, 150000)], dates,
    );
    expect(plan).toMatchObject({
      ok: true, total: 150000,
      byInvoice: [{ invoiceId: I1, amount: 150000 }],
      byReceipt: [{ receiptId: R1, amount: 100000 }, { receiptId: R2, amount: 50000 }],
    });
  });

  it("refuses a per-receipt sum over what the advance has left", () => {
    const plan = applicationPlan(
      [{ receiptId: R1, invoiceId: I1, amount: 300000 }, { receiptId: R1, invoiceId: I2, amount: 250000 }],
      [advance(R1, 500000)], [invoice(I1, 900000), invoice(I2, 900000)], dates,
    );
    expect(plan).toMatchObject({ ok: false, code: "advance_exceeds_open" });
    if (!plan.ok) expect(plan.details.join(" ")).toContain("RC-1");
  });

  it("refuses a per-invoice sum over its open balance, also when two lines name the same invoice", () => {
    expect(applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 100.01 }], [advance(R1, 500)], [invoice(I1, 100)], dates)).toMatchObject({ ok: false, code: "allocation_exceeds_open" });
    const two = applicationPlan(
      [{ receiptId: R1, invoiceId: I1, amount: 60000 }, { receiptId: R2, invoiceId: I1, amount: 60000 }],
      [advance(R1, 100000), advance(R2, 100000)], [invoice(I1, 100000)], dates,
    );
    expect(two).toMatchObject({ ok: false, code: "allocation_exceeds_open" });
  });

  it("refuses a duplicate pair (advance, invoice): one line per pair", () => {
    const plan = applicationPlan(
      [{ receiptId: R1, invoiceId: I1, amount: 10 }, { receiptId: R1, invoiceId: I1, amount: 20 }],
      [advance(R1, 100)], [invoice(I1, 100)], dates,
    );
    expect(plan).toMatchObject({ ok: false, code: "duplicate_pair" });
  });

  it("adds in cents: $ 0,10 + $ 0,20 fits an invoice open for $ 0,30", () => {
    const plan = applicationPlan(
      [{ receiptId: R1, invoiceId: I1, amount: 0.1 }, { receiptId: R2, invoiceId: I1, amount: 0.2 }],
      [advance(R1, 0.1), advance(R2, 0.2)], [invoice(I1, 0.3)], dates,
    );
    expect(plan).toMatchObject({ ok: true, total: 0.3, byInvoice: [{ invoiceId: I1, amount: 0.3 }] });
  });

  it("refuses an application of nothing", () => {
    expect(applicationPlan([], [], [], dates)).toMatchObject({ ok: false, code: "nothing_applied" });
  });

  it("refuses an advance or an invoice that was not loaded", () => {
    expect(applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 1 }], [], [invoice(I1, 10)], dates)).toMatchObject({ ok: false, code: "advance_not_found" });
    expect(applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 1 }], [advance(R1, 10)], [], dates)).toMatchObject({ ok: false, code: "invoice_not_found" });
  });

  it("refuses a date before the receipt and a date after today", () => {
    expect(applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 1 }], [advance(R1, 10, "2026-11-05")], [invoice(I1, 10)], { on: "2026-11-04", today: "2026-11-06" }))
      .toMatchObject({ ok: false, code: "application_before_receipt" });
    expect(applicationPlan([{ receiptId: R1, invoiceId: I1, amount: 1 }], [advance(R1, 10)], [invoice(I1, 10)], { on: "2026-11-07", today: "2026-11-06" }))
      .toMatchObject({ ok: false, code: "application_in_future" });
  });
});

describe("splitCompany (plan 2B.2 Task 34.6): the pesos of a line at a rate, the last line taking what is left", () => {
  it("each part at the rate to the cent, the parts adding up to the total exactly", () => {
    // USD 333,33 + 666,67 at 4.000,123: 1.333.361,00 + 2.666.762,00 = 4.000.123,00 (the whole advance's pesos).
    expect(splitCompany([333.33, 666.67], 4000.123, 400012300)).toEqual([133336100, 266676200]);
    expect(splitCompany([0.01, 0.01, 0.01], 3999.997, 12000)).toEqual([4000, 4000, 4000]);
    expect(splitCompany([0.01, 0.01, 0.01], 3999.997, 11999)).toEqual([4000, 4000, 3999]);
    expect(splitCompany([], 4000, 0)).toEqual([]);
  });
});
