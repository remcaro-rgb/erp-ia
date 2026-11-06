import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYMENTS_POSTING_RULES } from "../index";
import { paymentsHarness, type Harness, type ReceiptOut } from "./helpers";

// Recibos de caja through the real posting engine on the demo chart (plan 2B Task 21; design §8.1 step 7; accounting design §5.4):
// payments.payment.receive writes the receipt and its allocations, numbers it (RC-n) and posts it INLINE and strict in one transaction (D8):
// Dr cash / bank by the method (payment_method:<code>) · Dr the withholdings the customer practised (code, rate, base) · Cr receivable (what
// it settles) · Cr customer_advances (what it does not apply). An allocation never exceeds what is open of an issued invoice the DIAN
// accepted; payments.payment.void (step-up) reverses the entry inline and gives the allocations back.

let h: Harness;

const cents = (s: string) => Number(s);
const linesOfReceipt = async (receiptId: string) => {
  const [entry] = await h.entriesOfSource(receiptId);
  expect(entry).toBeDefined();
  return (await h.linesOf(entry!.id)).map((l) => [l.code, cents(l.debit), cents(l.credit), l.tax_code]);
};

beforeAll(async () => {
  h = await paymentsHarness();
  // The notes' numbering (an Anular issues a credit note of annulment, Task 18): a plain sequence row.
  await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, 'credit_note', 'NC', 1)`;
}, 300_000);

afterAll(async () => {
  await h.cleanup();
});

describe("the manifest's rules", () => {
  it("the company holds one copy of each payments rule, with the advance line and the receipt as source", async () => {
    const rules = await h.sql<{ event: string; name: string; template: { source?: { entity: string }; lines: { role: string }[] } }[]>`
      select event, name, template from accounting.posting_rules where company_id = ${h.companyId} and event like 'payments.%' order by event`;
    expect(rules.map((r) => [r.event, r.name])).toEqual([["payments.payment.voided", "Anulación de recibo de caja"], ["payments.received", "Recibo de caja"]]);
    expect(rules[1]!.template.source).toEqual({ entity: "payments.receipt", id: "$.paymentId" });
    expect(rules[1]!.template.lines.map((l) => l.role)).toContain("customer_advances");
  });

  it("the demo chart maps every kind of method: efectivo and cheque to the cash account, transferencia and tarjeta to the bank (role cash, dimension payment_method:<kind>)", async () => {
    const mapped = await h.sql<{ dimension: string | null; code: string }[]>`
      select m.dimension, a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
      where m.company_id = ${h.companyId} and m.role = 'cash' order by m.dimension nulls first`;
    expect(mapped.map((m) => [m.dimension, m.code])).toEqual([
      [null, "110505"], ["payment_method:card", "111005"], ["payment_method:cash", "110505"], ["payment_method:check", "110505"], ["payment_method:transfer", "111005"],
    ]);
  });
});

describe("a receipt settles an invoice", () => {
  it("withholdings reduce the cash but settle the receivable fully: Dr bank + Dr retefuente / Cr clientes, numbered RC-n, posted in the same action", async () => {
    const invoice = await h.issuedInvoice(10); // 1.000.000 + IVA 190.000
    expect(invoice.total).toBe(1190000);
    const receipt = await h.receive({
      amount: 1165000,
      reference: "TRF-77120",
      allocations: [{ invoiceId: invoice.id, amount: 1190000, withholdings: [{ kind: "income", code: "RTEFTE_SERVICIOS_2_5", rate: 2.5, base: 1000000, amount: 25000 }] }],
    });
    expect(receipt).toMatchObject({ status: "posted", amount: 1165000, applied: 1190000, withholdingTotal: 25000, advance: 0 });
    expect(receipt.number).toMatch(/^RC-\d+$/);
    expect(receipt.allocations).toEqual([{ invoiceId: invoice.id, invoiceNumber: invoice.number, amount: 1190000, cashAmount: 1165000, withholdingTotal: 25000 }]);
    expect(await linesOfReceipt(receipt.id)).toEqual([
      ["111005", 1165000, 0, null], ["135515", 25000, 0, "RTEFTE_SERVICIOS_2_5"], ["130505", 0, 1190000, null],
    ]);
    const [entry] = await h.entriesOfSource(receipt.id);
    expect(entry).toMatchObject({ status: "posted", source_entity: "payments.receipt", journal: "RC", date: h.today });
    expect(await h.paidOf(invoice.id)).toBe(1190000);

    // The event Task 23 consumes: the allocations with their invoices and withholdings, inline-posted (handled by accounting).
    const [event] = await h.eventsOf("payments.received", receipt.id);
    expect(event!.payload).toMatchObject({
      paymentId: receipt.id, number: receipt.number, date: h.today, method: "transfer", amount: 1165000, applied: 1190000, advance: 0,
      customer: { partyId: h.partyId, legalName: "Distribuidora Andina S.A.S." },
      withholdings: { income: [{ code: "RTEFTE_SERVICIOS_2_5", rate: 2.5, base: 1000000, amount: 25000, invoiceId: invoice.id }], vat: [], ica: [] },
      allocations: [{ invoiceId: invoice.id, invoiceNumber: invoice.number, amount: 1190000, cash: 1165000, withholdingTotal: 25000 }],
    });
    expect(entry!.chain_id).toBe(event!.chain_id);
    expect((await h.sql`select 1 from kernel.outbox_deliveries where outbox_id = ${event!.id} and module_id = 'accounting'`).length).toBe(1);

    // Nothing is left open: another receipt on it is refused.
    const again = await h.refusal(h.receive({ amount: 1, allocations: [{ invoiceId: invoice.id, amount: 1 }] }));
    expect(again?.message).toMatch(/allocation_exceeds_open/);
  });

  it("an allocation cannot exceed what is open of the invoice; partial payments add up to it", async () => {
    const invoice = await h.issuedInvoice(1); // 119.000
    const before = await h.footprint();
    const over = await h.refusal(h.receive({ amount: 120000, allocations: [{ invoiceId: invoice.id, amount: 119000.01 }] }));
    expect(over?.message).toMatch(/allocation_exceeds_open/);
    expect(JSON.stringify(over?.details)).toContain("119.000,00");
    expect(await h.footprint()).toEqual(before);
    await h.receive({ amount: 50000, allocations: [{ invoiceId: invoice.id, amount: 50000 }] });
    expect((await h.refusal(h.receive({ amount: 69001, allocations: [{ invoiceId: invoice.id, amount: 69001 }] })))?.message).toMatch(/allocation_exceeds_open/);
    const rest = await h.receive({ amount: 69000, allocations: [{ invoiceId: invoice.id, amount: 69000 }] });
    expect(rest.status).toBe("posted");
    expect(await h.paidOf(invoice.id)).toBe(119000);
  });

  it("one receipt over several invoices: one entry, one receivable credit for the sum, one allocation per invoice", async () => {
    const a = await h.issuedInvoice(1);
    const b = await h.issuedInvoice(2);
    const receipt = await h.receive({ amount: 357000, method: "cash", allocations: [{ invoiceId: a.id, amount: 119000 }, { invoiceId: b.id, amount: 238000 }] });
    expect(receipt.allocations.map((l) => [l.invoiceId, l.amount])).toEqual([[a.id, 119000], [b.id, 238000]]);
    expect(await linesOfReceipt(receipt.id)).toEqual([["110505", 357000, 0, null], ["130505", 0, 357000, null]]);
    expect(await h.paidOf(a.id)).toBe(119000);
    expect(await h.paidOf(b.id)).toBe(238000);
    // Twice the same invoice in one receipt is refused (one line per invoice).
    const c = await h.issuedInvoice(1);
    expect((await h.refusal(h.receive({ amount: 2, allocations: [{ invoiceId: c.id, amount: 1 }, { invoiceId: c.id, amount: 1 }] })))?.message).toMatch(/duplicate_invoice/);
  });

  it("an unallocated remainder becomes a customer advance (Cr 280505), and a receipt with no invoice is all advance", async () => {
    const invoice = await h.issuedInvoice(1);
    const receipt = await h.receive({ amount: 200000, method: "card", allocations: [{ invoiceId: invoice.id, amount: 119000 }] });
    expect(receipt).toMatchObject({ applied: 119000, advance: 81000 });
    expect(await linesOfReceipt(receipt.id)).toEqual([["111005", 200000, 0, null], ["130505", 0, 119000, null], ["280505", 0, 81000, null]]);
    const [event] = await h.eventsOf("payments.received", receipt.id);
    expect(event!.payload).toMatchObject({ advance: 81000, advances: [{ amount: 81000 }] });

    const advance = await h.receive({ amount: 300000, method: "cash" });
    expect(advance).toMatchObject({ applied: 0, advance: 300000, allocations: [] });
    expect(await linesOfReceipt(advance.id)).toEqual([["110505", 300000, 0, null], ["280505", 0, 300000, null]]);
  });

  it("money short of what is applied in cash is refused with nothing written", async () => {
    const invoice = await h.issuedInvoice(1);
    const before = await h.footprint();
    expect((await h.refusal(h.receive({ amount: 100000, allocations: [{ invoiceId: invoice.id, amount: 119000 }] })))?.message).toMatch(/cash_short/);
    expect(await h.footprint()).toEqual(before);
  });
});

describe("what an allocation may settle", () => {
  it("refuses an invoice of another customer, one the DIAN has not accepted, a foreign-currency invoice and an invoice dated after the receipt", async () => {
    const other = await h.newCustomer("800197268", "Hotel Casa Andina S.A.S.");
    const theirs = await h.issuedInvoice(1, { partyId: other });
    expect((await h.refusal(h.receive({ amount: 119000, allocations: [{ invoiceId: theirs.id, amount: 119000 }] })))?.message).toMatch(/invoice_other_customer/);
    const pending = await h.issuedInvoice(1, { accepted: false });
    const refused = await h.refusal(h.receive({ amount: 119000, allocations: [{ invoiceId: pending.id, amount: 119000 }] }));
    expect(refused?.message).toMatch(/invoice_not_accepted/);
    const usd = await h.issuedInvoice(1, { currency: "USD", exchangeRate: 4000 });
    expect((await h.refusal(h.receive({ amount: 1, allocations: [{ invoiceId: usd.id, amount: 1 }] })))?.message).toMatch(/currency_not_supported/);
    const later = await h.issuedInvoice(1);
    expect((await h.refusal(h.receive({ amount: 119000, date: `${h.year}-01-02`, allocations: [{ invoiceId: later.id, amount: 119000 }] })))?.message).toMatch(/invoice_after_receipt/);
    expect((await h.refusal(h.receive({ amount: 1, allocations: [{ invoiceId: "0192b4c0-0000-7000-8000-0000000000ff", amount: 1 }] })))?.message).toMatch(/invoice_not_found/);
  });

  it("refuses an invoice whose annulment credit note is pending (Anular in progress), carry-over of Task 18", async () => {
    const invoice = await h.issuedInvoice(1);
    await h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "Precio equivocado" });
    const [note] = await h.sql<{ stage: string }[]>`select stage from invoicing.notes where invoice_id = ${invoice.id} and annulment`;
    expect(note?.stage).toBe("issued");
    const refused = await h.refusal(h.receive({ amount: 119000, allocations: [{ invoiceId: invoice.id, amount: 119000 }] }));
    expect(refused?.message).toMatch(/invoice_annulment_pending/);
  });

  it("refuses a customer that is not invoice_ready (rule 10), with the reasons, and an inactive method (maestro not usable)", async () => {
    const unready = await h.newCustomer("900654321", "Cliente sin RUT S.A.S.", false);
    const before = await h.footprint();
    const refused = await h.refusal(h.receive({ amount: 1000, partyId: unready }));
    expect(refused?.message).toMatch(/not_invoice_ready/);
    expect(JSON.stringify(refused?.details)).toMatch(/faltan archivos/);
    expect(await h.footprint()).toEqual(before);

    const old = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "old", name: "Efectivo viejo", kind: "cash", isActive: false })).id;
    const stale = await h.refusal(h.run(h.admin, "payments.payment.receive", { partyId: h.partyId, methodId: old, amount: 1000, date: h.today, allocations: [] }));
    expect(stale?.code).toBe("maestro_not_usable");
    expect(await h.footprint()).toEqual(before);
  });

  it("a method code and DIAN means code are validated, and a method code is unique per company", async () => {
    expect((await h.refusal(h.run(h.admin, "payments.method.create", { code: "transfer", name: "Otra", kind: "transfer" })))?.code).toBe("invalid_input");
    expect((await h.refusal(h.run(h.admin, "payments.method.create", { code: "zz", name: "Raro", kind: "other", meansCode: "999" })))?.message).toMatch(/invalid_means_code/);
    const box = await h.run<{ id: string }>(h.admin, "payments.cash_box.create", { code: "CAJA1", name: "Caja principal" });
    const receipt = await h.receive({ amount: 1000, method: "cash", cashBoxId: box.id });
    expect((await h.sql`select cash_box_id from payments.receipts where id = ${receipt.id}`)[0]!.cash_box_id).toBe(box.id);
  });
});

describe("void", () => {
  it("is step-up; it reverses the entry inline, keeps the receipt voided and gives the invoice's amount back", async () => {
    const invoice = await h.issuedInvoice(1);
    const receipt = await h.receive({ amount: 119000, allocations: [{ invoiceId: invoice.id, amount: 119000 }] });
    expect((await h.refusal(h.run(h.admin, "payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" })))?.code).toBe("step_up_required");
    const voided = await h.runStepUp<{ id: string; status: string; number: string }>("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" });
    expect(voided).toMatchObject({ id: receipt.id, status: "voided", number: receipt.number });
    const entries = await h.entriesOfSource(receipt.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.reversal_of_id).toBe(entries[0]!.id);
    expect(entries[1]!.total_debit).toBe(entries[0]!.total_debit);
    expect((await h.sql`select status, void_reason from payments.receipts where id = ${receipt.id}`)[0]).toEqual({ status: "voided", void_reason: "Consignación devuelta" });
    expect(await h.paidOf(invoice.id)).toBe(0);
    const [event] = await h.eventsOf("payments.payment.voided", receipt.id);
    expect(event!.payload).toMatchObject({ paymentId: receipt.id, number: receipt.number, date: h.today, partyId: h.partyId, allocations: [{ invoiceId: invoice.id, amount: 119000 }] });
    // The invoice can be paid again; a second void is refused.
    expect((await h.receive({ amount: 119000, allocations: [{ invoiceId: invoice.id, amount: 119000 }] })).status).toBe("posted");
    expect((await h.refusal(h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Otra vez" })))?.code).toBe("invalid_state");
  });

  it("is refused when the reversal cannot post (a closed period): the receipt and the ledger stay as they were", async () => {
    const receipt = await h.receive({ amount: 5000, method: "cash", date: `${h.year}-02-10` });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    try {
      const refused = await h.refusal(h.runStepUp("payments.payment.void", { id: receipt.id, reason: "x", date: `${h.year}-02-11` }));
      expect(refused?.message).toMatch(/closed_period/);
      expect((await h.sql`select status from payments.receipts where id = ${receipt.id}`)[0]!.status).toBe("posted");
      expect(await h.entriesOfSource(receipt.id)).toHaveLength(1);
    } finally {
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
    }
  });
});

describe("idempotency and concurrency", () => {
  it("a replay with the same idempotency key answers the first result and receives nothing twice, also when both run at once", async () => {
    const invoice = await h.issuedInvoice(1);
    const first = await h.receive({ amount: 50000, idempotencyKey: "form-1", allocations: [{ invoiceId: invoice.id, amount: 50000 }] });
    const replay = await h.receive({ amount: 50000, idempotencyKey: "form-1", allocations: [{ invoiceId: invoice.id, amount: 50000 }] });
    expect(replay.id).toBe(first.id);
    const [x, y] = await Promise.all([
      h.receive({ amount: 69000, idempotencyKey: "form-2", allocations: [{ invoiceId: invoice.id, amount: 69000 }] }),
      h.receive({ amount: 69000, idempotencyKey: "form-2", allocations: [{ invoiceId: invoice.id, amount: 69000 }] }),
    ]);
    expect(x.id).toBe(y.id);
    expect(await h.paidOf(invoice.id)).toBe(119000);
  });

  it("two receipts allocating the same invoice at once cannot over-allocate: one posts, the other is refused", async () => {
    const invoice = await h.issuedInvoice(1);
    const results = await Promise.allSettled([
      h.receive({ amount: 80000, allocations: [{ invoiceId: invoice.id, amount: 80000 }] }),
      h.receive({ amount: 80000, allocations: [{ invoiceId: invoice.id, amount: 80000 }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String((rejected.reason as Error).message)).toMatch(/allocation_exceeds_open/);
    expect(await h.paidOf(invoice.id)).toBe(80000);
  });

  it("receipts naming two invoices in opposite orders at once do not deadlock", async () => {
    const a = await h.issuedInvoice(1);
    const b = await h.issuedInvoice(1);
    const [r1, r2] = await Promise.all([
      h.receive({ amount: 20000, allocations: [{ invoiceId: a.id, amount: 10000 }, { invoiceId: b.id, amount: 10000 }] }),
      h.receive({ amount: 20000, allocations: [{ invoiceId: b.id, amount: 10000 }, { invoiceId: a.id, amount: 10000 }] }),
    ]);
    expect([r1.status, r2.status]).toEqual(["posted", "posted"]);
  });
});

describe("a ledger refusal undoes the whole receipt (D8)", () => {
  it("a closed period: refused, and no receipt, allocation, entry, failure, event or number", async () => {
    const invoice = await h.issuedInvoice(1);
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    try {
      const before = await h.footprint();
      const refused = await h.refusal(h.receive({ amount: 1000, method: "cash", date: `${h.year}-02-10` }));
      expect(refused?.message).toMatch(/closed_period/);
      expect(await h.footprint()).toEqual(before);
    } finally {
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
    }
    expect((await h.receive({ amount: 119000, allocations: [{ invoiceId: invoice.id, amount: 119000 }] })).status).toBe("posted");
  });

  it("accounting enabled but the ledger never started: refused (ledger_not_started) with nothing written", async () => {
    await h.sql`update accounting.settings set ledger_starts_on = null where company_id = ${h.companyId}`;
    try {
      const before = await h.footprint();
      expect((await h.refusal(h.receive({ amount: 1000, method: "cash" })))?.message).toMatch(/ledger_not_started/);
      expect(await h.footprint()).toEqual(before);
    } finally {
      await h.sql`update accounting.settings set ledger_starts_on = ${`${h.year}-01-01`} where company_id = ${h.companyId}`;
    }
  });

  it("accounting switched off: the receipt is received and its event parks for the consumer; a void while parked dismisses it", async () => {
    await h.setAccounting(false);
    let receipt: ReceiptOut;
    try {
      const before = await h.footprint();
      receipt = await h.receive({ amount: 7000, method: "cash" });
      expect(receipt.status).toBe("posted");
      const [event] = await h.eventsOf("payments.received", receipt.id);
      expect((await h.sql`select 1 from kernel.outbox_deliveries where outbox_id = ${event!.id} and module_id = 'accounting'`).length).toBe(0);
      expect((await h.footprint()).entries).toBe(before.entries);
      await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Duplicado" });
      // The parked receipt never reaches the ledger after its void.
      expect((await h.sql`select 1 from kernel.outbox_deliveries where outbox_id = ${event!.id} and module_id = 'accounting'`).length).toBe(1);
    } finally {
      await h.setAccounting(true);
    }
  });
});

describe("tenant isolation", () => {
  it("the other company sees none of the receipts", async () => {
    const other = { ...h.admin, claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId) as typeof h.admin.claims };
    const rows = await h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(other.claims)}, true)`;
      await tx`set local role authenticated`;
      return tx`select id from payments.v_receipts`;
    });
    expect(rows).toEqual([]);
  });
});

describe("fix round 1: the method's kind, the receipt's date, the caja, a draft invoice", () => {
  it("the cash or bank account follows the method's KIND, never its free-text code: a transfer coded BANCOLOMBIA posts to the bank", async () => {
    const bancolombia = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "BANCOLOMBIA", name: "Transferencia Bancolombia", kind: "transfer", meansCode: "47" })).id;
    const receipt = await h.run<ReceiptOut>(h.admin, "payments.payment.receive", { partyId: h.partyId, methodId: bancolombia, amount: 7000, date: h.today, allocations: [] });
    expect(await linesOfReceipt(receipt.id)).toEqual([["111005", 7000, 0, null], ["280505", 0, 7000, null]]);
    const [event] = await h.eventsOf("payments.received", receipt.id);
    expect(event!.payload).toMatchObject({ method: "transfer", methodCode: "BANCOLOMBIA", methodId: bancolombia });
    expect((await h.sql`select method_code from payments.receipts where id = ${receipt.id}`)[0]!.method_code).toBe("BANCOLOMBIA");
  });

  it("refuses a method whose kind the country pack maps to no account (kind other), with nothing written", async () => {
    const bono = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "BONO", name: "Bono de regalo", kind: "other", meansCode: "71" })).id;
    const before = await h.footprint();
    const refused = await h.refusal(h.run(h.admin, "payments.payment.receive", { partyId: h.partyId, methodId: bono, amount: 1000, date: h.today, allocations: [] }));
    expect(refused?.message).toMatch(/method_kind_unmapped/);
    expect(await h.footprint()).toEqual(before);
  });

  it("a DIAN means code must fit the method's kind (create and update), and a caja goes only with a cash method", async () => {
    expect((await h.refusal(h.run(h.admin, "payments.method.create", { code: "TRF2", name: "Transferencia", kind: "transfer", meansCode: "10" })))?.message).toMatch(/means_code_kind_mismatch/);
    const card = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "TDB", name: "Tarjeta débito", kind: "card", meansCode: "49" })).id;
    expect((await h.refusal(h.run(h.admin, "payments.method.update", { id: card, kind: "check" })))?.message).toMatch(/means_code_kind_mismatch/);
    const box = await h.run<{ id: string }>(h.admin, "payments.cash_box.create", { code: "CAJA2", name: "Caja 2" });
    const before = await h.footprint();
    expect((await h.refusal(h.receive({ amount: 1000, method: "transfer", cashBoxId: box.id })))?.message).toMatch(/cash_box_not_cash/);
    expect(await h.footprint()).toEqual(before);
  });

  it("refuses a receipt dated after the company's today, and a draft invoice with its own reason", async () => {
    const before = await h.footprint();
    const [tomorrow] = await h.sql<{ d: string }[]>`select (${h.today}::date + 1)::text as d`;
    expect((await h.refusal(h.receive({ amount: 1000, date: tomorrow!.d })))?.message).toMatch(/receipt_in_future/);
    const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, paymentForm: "2", lines: [{ productId: h.servicio, qty: 1 }] });
    expect((await h.refusal(h.receive({ amount: 119000, allocations: [{ invoiceId: draft.id, amount: 119000 }] })))?.message).toMatch(/invoice_not_issued/);
    expect(await h.footprint()).toEqual(before);
  });

  it("voiding a receipt with withholdings and an advance reverses every line, in the void's own chain", async () => {
    const invoice = await h.issuedInvoice(1);
    const receipt = await h.receive({
      amount: 150000, method: "cash",
      allocations: [{ invoiceId: invoice.id, amount: 119000, withholdings: [{ kind: "income", code: "RTEFTE_SERVICIOS_4", rate: 4, base: 100000, amount: 4000 }, { kind: "ica", code: "RTEICA_0_966", rate: 0.966, base: 100000, amount: 966 }] }],
    });
    expect(receipt).toMatchObject({ applied: 119000, withholdingTotal: 4966, advance: 35966 });
    const original = await linesOfReceipt(receipt.id);
    expect(original).toEqual([["110505", 150000, 0, null], ["135515", 4000, 0, "RTEFTE_SERVICIOS_4"], ["135518", 966, 0, "RTEICA_0_966"], ["130505", 0, 119000, null], ["280505", 0, 35966, null]]);
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Cheque devuelto" });
    const entries = await h.entriesOfSource(receipt.id);
    expect(entries).toHaveLength(2);
    const reversal = (await h.linesOf(entries[1]!.id)).map((l) => [l.code, cents(l.debit), cents(l.credit), l.tax_code]);
    expect(reversal).toEqual(original.map(([code, debit, credit, tax]) => [code, credit, debit, tax]));
    const [voidEvent] = await h.eventsOf("payments.payment.voided", receipt.id);
    const [receivedEvent] = await h.eventsOf("payments.received", receipt.id);
    expect(entries[1]!.chain_id).toBe(voidEvent!.chain_id);
    expect(entries[0]!.chain_id).toBe(receivedEvent!.chain_id);
    expect(entries[1]!.chain_id).not.toBe(entries[0]!.chain_id);
  });

  it("payments.allocated_amounts answers only inside a payments process (or, since 0113, an invoicing one: Task 23's paid status)", async () => {
    await expect(h.sql`select * from payments.allocated_amounts(array[]::uuid[])`).rejects.toThrow(/only inside a payments or invoicing process/);
  });
});

// Migrations 0110 and 0111 patch the stored "Recibo de caja" rule and backfill the cash mappings by kind (the 0071 / 0098 pattern).
describe("migrations 0110 and 0111", () => {
  it("patch an unmodified copy (also one that differs from the old template), leave a modified one, backfill the mappings once, and are a no-op the second time", async () => {
    const sqlOf = (file: string) => readFileSync(new URL(`../../../../../supabase/migrations/${file}`, import.meta.url), "utf8");
    const migrations = sqlOf("0110_accounting_payment_rules.sql") + "\n" + sqlOf("0111_payments_fix_round_1.sql");
    const current = PAYMENTS_POSTING_RULES[0]!.template as unknown as { lines: { role: string }[]; source: object };
    const old = { ...current, source: { entity: "payments.payment", id: "$.paymentId" }, lines: current.lines.filter((l) => l.role !== "customer_advances") };
    const variant = { ...old, description: "Recibo {{number}}" };
    const rule = (tx: typeof h.sql) => tx<{ template: unknown; is_modified: boolean }[]>`
      select template, is_modified from accounting.posting_rules where company_id = ${h.companyId} and event = 'payments.received' and name = 'Recibo de caja'`;
    const mappings = (tx: typeof h.sql) => tx<{ dimension: string }[]>`
      select dimension from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'cash' and dimension like 'payment_method:%' order by dimension`;
    const set = (tx: typeof h.sql, template: unknown, modified: boolean) =>
      tx`update accounting.posting_rules set template = ${tx.json(template as never)}, is_modified = ${modified} where company_id = ${h.companyId} and event = 'payments.received' and name = 'Recibo de caja'`;
    const rollback = new Error("rollback");
    await h.sql.begin(async (tx) => {
      const t = tx as unknown as typeof h.sql;
      await t`delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'cash' and dimension like 'payment_method:%'`;
      for (const stored of [old, variant]) {
        await set(t, stored, false);
        await t.unsafe(migrations);
        expect((await rule(t))[0]).toMatchObject({ template: current, is_modified: false });
      }
      const kinds = ["payment_method:card", "payment_method:cash", "payment_method:check", "payment_method:transfer"];
      expect((await mappings(t)).map((m) => m.dimension)).toEqual(kinds);
      await set(t, old, true);
      await t.unsafe(migrations);
      await t.unsafe(migrations);
      expect((await rule(t))[0]).toMatchObject({ template: old, is_modified: true });
      expect((await mappings(t)).map((m) => m.dimension)).toEqual(kinds);
      throw rollback;
    }).catch((e: unknown) => { if (e !== rollback) throw e; });
    expect((await rule(h.sql))[0]).toMatchObject({ template: current, is_modified: false });
  });
});

describe("Task 24b: «Registrar pago» lists the customer's open invoices (payments.payment.open_invoices)", () => {
  interface OpenInvoice { id: string; number: string | null; total: number; open: number; payable: boolean; reasonCode: string | null; reason: string | null }
  const openOf = async (partyId: string) => (await h.run<{ invoices: OpenInvoice[] }>(h.admin, "payments.payment.open_invoices", { partyId })).invoices;

  it("lists the issued invoices of the customer with what is still open; the ones the DIAN has not accepted are listed but not payable, with the reason", async () => {
    const partyId = await h.newCustomer("900111222", "Cliente Lista Abiertas S.A.S.");
    const accepted = await h.issuedInvoice(1, { partyId });
    const waiting = await h.issuedInvoice(2, { partyId, accepted: false });
    const settled = await h.issuedInvoice(1, { partyId });
    await h.receive({ partyId, amount: 119000, allocations: [{ invoiceId: settled.id, amount: 119000 }] });
    await h.receive({ partyId, amount: 19000, allocations: [{ invoiceId: accepted.id, amount: 19000 }] });
    // A Borrador is not receivable: it is not listed.
    await h.run(h.admin, "invoicing.invoice.create", { partyId, paymentForm: "2", lines: [{ productId: h.servicio, qty: 1 }] });
    const list = await openOf(partyId);
    expect(list.map((i) => i.id).sort()).toEqual([accepted.id, waiting.id].sort());
    expect(list.find((i) => i.id === accepted.id)).toMatchObject({ number: accepted.number, total: 119000, open: 100000, payable: true, reasonCode: null, reason: null });
    const notYet = list.find((i) => i.id === waiting.id)!;
    expect(notYet).toMatchObject({ payable: false, reasonCode: "invoice_not_accepted", open: 238000 });
    expect(notYet.reason).toContain("La DIAN aún no ha aceptado");
  });

  it("an unknown customer is refused", async () => {
    const missing = await h.refusal(openOf("00000000-0000-7000-8000-000000000000"));
    expect(missing?.code).toBe("invalid_input");
  });
});
