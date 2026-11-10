import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import paymentReceivedRule from "../rules/payment-received.json" with { type: "json" };
import { paymentsHarness, type Harness, type ReceiptOut } from "./helpers";

// Foreign receipts and the realized exchange difference (plan 2B.2 Task 34.5; FX §5 realized, §6, §11 0150, 0151; owner items 125,
// 126 (a) provisional; ruling R34-6):
//   (1) a USD receipt of USD 1.000 at 4.000 on an invoice at 4.100: Dr bank $ 4.000.000 · Dr fx_loss $ 100.000 · Cr receivable $ 4.100.000,
//       an entry in USD whose fx line has no dollars (debit_doc 0); (2) at 4.200 the difference is a gain;
//   (3) a COP receipt of $ 4.150.000 settling USD 1.000: a COP entry, gain $ 50.000, the allocation stores amount 1000 (the invoice's
//       currency), amount_receipt 4.150.000 (the receipt's) and amount_company 4.100.000 (the invoice's rate);
//   (4) partial collection: the open balance stays in dollars, the invoice is paid when its dollars are;
//   (5) the pairs of R34-6, the method's currency and withholdings on a foreign allocation are refused;
//   (6) Anular reverses the fx line with the rest; (7) a COP receipt has no fx line;
//   (8) an old payment rule copy posts pesos only (R34-5); 0151 rewrites unedited copies and can run twice;
//   (9) fx_gain and fx_loss map to the pack's accounts, also for a company whose chart was seeded before 0151.

const migration = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

let h: Harness;
let usdMethod: string;
let eurMethod: string;
let export0: string;
beforeAll(async () => {
  h = await paymentsHarness();
  usdMethod = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "transfer_usd", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" })).id;
  eurMethod = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "transfer_eur", name: "Transferencia EUR", kind: "transfer", meansCode: "47", currency: "EUR" })).id;
  // An exported good with no IVA (exento), so an invoice of USD 1.000 totals USD 1.000.
  export0 = (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku: "EXP-01", description: "Café verde de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
}, 300_000);
afterAll(async () => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
  await h.cleanup();
});

/** An issued export invoice of `total` in `currency` at `rate`, accepted by the DIAN. */
const foreignInvoice = (total: number, rate: number, currency = "USD") => h.issuedInvoice(1, { currency, exchangeRate: rate, productId: export0, unitPrice: total });

/** The entry a receipt posted (or its reversal): currency, rate and each line's account and four amounts. */
const entryOf = async (receiptId: string, reversal = false) => {
  const entries = await h.entriesOfSource(receiptId);
  const entry = entries.find((e) => (e.reversal_of_id !== null) === reversal)!;
  const [header] = await h.sql<{ currency: string; exchange_rate: string }[]>`select currency, exchange_rate::text from accounting.entries where id = ${entry.id}`;
  const lines = await h.sql<{ code: string; debit: number; credit: number; debit_doc: number; credit_doc: number }[]>`
    select a.code, l.debit::float8 as debit, l.credit::float8 as credit, l.debit_doc::float8 as debit_doc, l.credit_doc::float8 as credit_doc
    from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entry.id} order by l.line_no`;
  return { currency: header!.currency, rate: Number(header!.exchange_rate), lines };
};
const allocationRow = async (receiptId: string) => (await h.sql<{ amount: number; amount_receipt: number; amount_company: number }[]>`
  select amount::float8 as amount, amount_receipt::float8 as amount_receipt, amount_company::float8 as amount_company
  from payments.receipt_allocations where receipt_id = ${receiptId}`)[0]!;
const codes = (lines: { code: string }[]) => lines.map((l) => l.code);
const FX_GAIN = "421020";
const FX_LOSS = "530525";
const BANK = "111005";
const RECEIVABLE = "130505";

describe("migration 0151 brings the fx accounts to a chart seeded before it", () => {
  it("adds 421020 and 530525 with the fx_gain and fx_loss mappings, once, to a company whose chart lacks them", async () => {
    const ROLLBACK = new Error("rollback");
    const seen = await h.sql.begin(async (tx) => {
      await tx`delete from accounting.account_role_mappings where company_id = ${h.companyId} and role in ('fx_gain', 'fx_loss')`;
      await tx`delete from accounting.accounts where company_id = ${h.companyId} and code in (${FX_GAIN}, ${FX_LOSS})`;
      for (let run = 0; run < 2; run++) await tx.unsafe(migration("0151_payments_rules_currency.sql"));
      const rows = await tx<{ role: string; code: string; requires_cost_center: boolean; allows_movement: boolean }[]>`
        select m.role, a.code, a.requires_cost_center, a.allows_movement from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
        where m.company_id = ${h.companyId} and m.role in ('fx_gain', 'fx_loss') order by m.role`;
      throw Object.assign(ROLLBACK, { rows });
    }).catch((e: unknown) => (e === ROLLBACK ? (ROLLBACK as Error & { rows: unknown }).rows : Promise.reject(e)));
    expect(seen).toEqual([
      { role: "fx_gain", code: FX_GAIN, requires_cost_center: false, allows_movement: true },
      { role: "fx_loss", code: FX_LOSS, requires_cost_center: false, allows_movement: true },
    ]);
  });
});

describe("(9) the fx roles in Mapeo de cuentas", () => {
  it("fx_gain → 421020 and fx_loss → 530525, the pack's codes (provisional, item 126 (a))", async () => {
    const out = await h.runStepUp<{ mappings: { role: string; dimension: string | null; accountCode: string | null }[] }>("accounting.account_role_mapping.consult", {});
    expect(out.mappings.filter((m) => m.role.startsWith("fx_")).map((m) => [m.role, m.dimension, m.accountCode]).sort()).toEqual([["fx_gain", null, FX_GAIN], ["fx_loss", null, FX_LOSS]]);
  });
});

describe("a USD receipt of a USD invoice (FX §5 realized)", () => {
  it("(1) at a lower rate: Dr bank 4.000.000 · Dr fx_loss 100.000 · Cr receivable 4.100.000, in USD, the fx line without dollars", async () => {
    const invoice = await foreignInvoice(1000, 4100);
    const receipt = await h.receive({ amount: 1000, methodId: usdMethod, currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: invoice.id, amount: 1000 }] });
    expect(receipt).toMatchObject({ currency: "USD", exchangeRate: 4000, amount: 1000, applied: 1000, advance: 0 });
    expect(receipt.allocations).toEqual([expect.objectContaining({ invoiceId: invoice.id, currency: "USD", amount: 1000, amountReceipt: 1000, amountCompany: 4100000, fx: { gain: 0, loss: 100000 } })]);
    const { currency, rate, lines } = await entryOf(receipt.id);
    expect(currency).toBe("USD");
    expect(rate).toBe(4000);
    expect(lines).toEqual([
      { code: BANK, debit: 4000000, credit: 0, debit_doc: 1000, credit_doc: 0 },
      { code: FX_LOSS, debit: 100000, credit: 0, debit_doc: 0, credit_doc: 0 },
      { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 1000 },
    ]);
    const [event] = await h.eventsOf("payments.received", receipt.id);
    expect(event!.payload).toMatchObject({ currency: "USD", exchangeRate: 4000, amount: 4000000, amountDoc: 1000, applied: 4100000, appliedDoc: 1000 });
    expect((event!.payload.allocations as unknown[])[0]).toMatchObject({ invoiceId: invoice.id, currency: "USD", amount: 1000, amountReceipt: 1000, amountCompany: 4100000, fx: { gain: 0, loss: 100000 } });
    expect(await allocationRow(receipt.id)).toEqual({ amount: 1000, amount_receipt: 1000, amount_company: 4100000 });
  });

  it("(2) at a higher rate the difference is a gain: Cr fx_gain 100.000", async () => {
    const invoice = await foreignInvoice(1000, 4100);
    const receipt = await h.receive({ amount: 1000, methodId: usdMethod, currency: "USD", exchangeRate: 4200, allocations: [{ invoiceId: invoice.id, amount: 1000 }] });
    expect(receipt.allocations[0]!.fx).toEqual({ gain: 100000, loss: 0 });
    const { lines } = await entryOf(receipt.id);
    expect(lines).toEqual([
      { code: BANK, debit: 4200000, credit: 0, debit_doc: 1000, credit_doc: 0 },
      { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 1000 },
      { code: FX_GAIN, debit: 0, credit: 100000, debit_doc: 0, credit_doc: 0 },
    ]);
  });

  it("takes the rate table's rate of the receipt date when none is typed; no rate for the date → exchange_rate_missing", async () => {
    const invoice = await foreignInvoice(10, 4100);
    expect((await h.refusal(h.receive({ amount: 10, methodId: usdMethod, currency: "USD", allocations: [{ invoiceId: invoice.id, amount: 10 }] })))?.message).toMatch(/^exchange_rate_missing/);
    await h.sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', ${h.today}, 4050, 'trm')`;
    const receipt = await h.receive({ amount: 10, methodId: usdMethod, allocations: [{ invoiceId: invoice.id, amount: 10 }] });
    // The currency follows the method when none is given; the rate, the table's.
    expect(receipt).toMatchObject({ currency: "USD", exchangeRate: 4050 });
    expect(receipt.allocations[0]!.fx).toEqual({ gain: 0, loss: 500 });
  });
});

describe("(3) a COP receipt settling a USD invoice (item 125)", () => {
  it("posts a COP entry with the gain: the allocation keeps the dollars it settled, the pesos received and the pesos at the invoice's rate", async () => {
    const invoice = await foreignInvoice(1000, 4100);
    const receipt = await h.receive({ amount: 4150000, method: "transfer", allocations: [{ invoiceId: invoice.id, amount: 1000, amountReceipt: 4150000 }] });
    expect(receipt).toMatchObject({ currency: "COP", exchangeRate: 1, amount: 4150000, applied: 4150000, advance: 0 });
    expect(receipt.allocations[0]).toMatchObject({ currency: "USD", amount: 1000, amountReceipt: 4150000, amountCompany: 4100000, fx: { gain: 50000, loss: 0 } });
    expect(await allocationRow(receipt.id)).toEqual({ amount: 1000, amount_receipt: 4150000, amount_company: 4100000 });
    const { currency, lines } = await entryOf(receipt.id);
    expect(currency).toBe("COP");
    expect(lines).toEqual([
      { code: BANK, debit: 4150000, credit: 0, debit_doc: 4150000, credit_doc: 0 },
      { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 4150000 },
      { code: FX_GAIN, debit: 0, credit: 50000, debit_doc: 0, credit_doc: 0 },
    ]);
    await h.drain();
    expect(await h.stageOf(invoice.id)).toMatchObject({ stage: "paid" });
  });

  it("needs the pesos received for the dollars it settles (amountReceipt), and they must leave money for the rest", async () => {
    const invoice = await foreignInvoice(100, 4100);
    expect((await h.refusal(h.receive({ amount: 410000, allocations: [{ invoiceId: invoice.id, amount: 100 }] })))?.message).toMatch(/^amount_receipt_required/);
    expect((await h.refusal(h.receive({ amount: 400000, allocations: [{ invoiceId: invoice.id, amount: 100, amountReceipt: 410000 }] })))?.message).toMatch(/^cash_short/);
  });
});

describe("(4) partial collection in dollars", () => {
  it("USD 400 leaves USD 600 open and the invoice unpaid; USD 600 more pays it, and the pesos at the invoice's rate add up to its total", async () => {
    const invoice = await foreignInvoice(1000, 4100);
    const first = await h.receive({ amount: 400, methodId: usdMethod, currency: "USD", exchangeRate: 4100, allocations: [{ invoiceId: invoice.id, amount: 400 }] });
    expect(first.allocations[0]).toMatchObject({ amountCompany: 1640000, fx: { gain: 0, loss: 0 } });
    // No difference at the invoice's own rate: the fx lines are dropped (their company amount is 0).
    expect(codes((await entryOf(first.id)).lines)).toEqual([BANK, RECEIVABLE]);
    await h.drain();
    expect((await h.stageOf(invoice.id)).stage).not.toBe("paid");
    const open = await h.run<{ invoices: { id: string; currency: string; open: number; openDoc: number; payable: boolean }[] }>(h.admin, "payments.payment.open_invoices", { partyId: h.partyId, currency: "USD" });
    expect(open.invoices.find((i) => i.id === invoice.id)).toMatchObject({ currency: "USD", open: 600, openDoc: 600, payable: true });

    const second = await h.receive({ amount: 600, methodId: usdMethod, currency: "USD", exchangeRate: 4100, allocations: [{ invoiceId: invoice.id, amount: 600 }] });
    expect(second.allocations[0]!.amountCompany).toBe(2460000);
    await h.drain();
    expect((await h.stageOf(invoice.id)).stage).toBe("paid");
    const [company] = await h.sql<{ total: number }[]>`select sum(amount_company)::float8 as total from payments.receipt_allocations where invoice_id = ${invoice.id}`;
    const [header] = await h.sql<{ total_company: number }[]>`select total_company::float8 as total_company from invoicing.invoices where id = ${invoice.id}`;
    expect(company!.total).toBe(header!.total_company);
  });

  it("the open invoices list of a COP receipt shows a USD invoice payable (pesos against dollars), of a USD receipt a EUR invoice not", async () => {
    const usd = await foreignInvoice(50, 4100);
    const eur = await foreignInvoice(50, 4500, "EUR");
    const cop = await h.run<{ invoices: { id: string; payable: boolean; reasonCode: string | null }[] }>(h.admin, "payments.payment.open_invoices", { partyId: h.partyId });
    expect(cop.invoices.find((i) => i.id === usd.id)).toMatchObject({ payable: true });
    const dollars = await h.run<{ invoices: { id: string; payable: boolean; reasonCode: string | null }[] }>(h.admin, "payments.payment.open_invoices", { partyId: h.partyId, currency: "USD" });
    expect(dollars.invoices.find((i) => i.id === eur.id)).toMatchObject({ payable: false, reasonCode: "currency_mismatch" });
  });
});

describe("(5) what a foreign receipt refuses", () => {
  it("a USD receipt on a EUR invoice (currency_mismatch), a USD receipt through a COP method (method_currency_mismatch), a withholding on a USD allocation (withholding_foreign_currency)", async () => {
    const eur = await foreignInvoice(100, 4500, "EUR");
    const usd = await foreignInvoice(100, 4100);
    const before = await h.footprint();
    expect((await h.refusal(h.receive({ amount: 100, methodId: usdMethod, currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: eur.id, amount: 100 }] })))?.message).toMatch(/^currency_mismatch/);
    expect((await h.refusal(h.receive({ amount: 100, method: "transfer", currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: usd.id, amount: 100 }] })))?.message).toMatch(/^method_currency_mismatch/);
    const withholding = { kind: "income" as const, code: "RTEFTE_SERVICIOS_4", rate: 4, base: 100, amount: 4 };
    expect((await h.refusal(h.receive({ amount: 96, methodId: usdMethod, currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: usd.id, amount: 100, withholdings: [withholding] }] })))?.message).toMatch(/^withholding_foreign_currency/);
    expect((await h.refusal(h.receive({ amount: 400000, allocations: [{ invoiceId: usd.id, amount: 100, amountReceipt: 410000, withholdings: [withholding] }] })))?.message).toMatch(/^withholding_foreign_currency/);
    // A EUR receipt on a USD invoice is no allowed pair either (only the same currency, or pesos against a foreign invoice).
    expect((await h.refusal(h.receive({ amount: 100, methodId: eurMethod, currency: "EUR", exchangeRate: 4500, allocations: [{ invoiceId: usd.id, amount: 100 }] })))?.message).toMatch(/^currency_mismatch/);
    expect(await h.footprint()).toEqual(before);
  });
});

describe("(6) Anular a foreign receipt", () => {
  it("reverses the fx line with the rest of the entry, document amounts included", async () => {
    const invoice = await foreignInvoice(1000, 4100);
    const receipt = await h.receive({ amount: 1000, methodId: usdMethod, currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: invoice.id, amount: 1000 }] });
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Transferencia devuelta" });
    const { currency, lines } = await entryOf(receipt.id, true);
    expect(currency).toBe("USD");
    expect(lines).toEqual([
      { code: BANK, debit: 0, credit: 4000000, debit_doc: 0, credit_doc: 1000 },
      { code: FX_LOSS, debit: 0, credit: 100000, debit_doc: 0, credit_doc: 0 },
      { code: RECEIVABLE, debit: 4100000, credit: 0, debit_doc: 1000, credit_doc: 0 },
    ]);
  });
});

describe("(7) a peso receipt of a peso invoice", () => {
  it("posts as before: COP at rate 1, document amounts equal to company amounts, no fx line; the allocation's twins equal its amount", async () => {
    const invoice = await h.issuedInvoice(1);
    const receipt: ReceiptOut = await h.receive({ amount: invoice.total, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] });
    expect(receipt.allocations[0]).toMatchObject({ currency: "COP", amount: invoice.total, amountReceipt: invoice.total, amountCompany: invoice.total, fx: { gain: 0, loss: 0 } });
    const { currency, rate, lines } = await entryOf(receipt.id);
    expect([currency, rate]).toEqual(["COP", 1]);
    expect(codes(lines)).not.toContain(FX_GAIN);
    expect(codes(lines)).not.toContain(FX_LOSS);
    for (const l of lines) expect([l.debit_doc, l.credit_doc]).toEqual([l.debit, l.credit]);
  });
});

describe("(8) old copies of the receipt rule (R34-5, 0151)", () => {
  /** The rule as 2A shipped it: no currency path, every amount the company field, no fx line. */
  const legacy = () => {
    const template = structuredClone(paymentReceivedRule.template) as unknown as { currency?: string; exchangeRate?: string; lines: { role: string; amount: string; amountCompany?: string }[] };
    delete template.currency;
    delete template.exchangeRate;
    template.lines = template.lines.filter((l) => !l.role.startsWith("fx_")).map(({ amountCompany, ...line }) => ({ ...line, amount: amountCompany ?? line.amount }));
    return template;
  };
  const setRule = (template: unknown, modified: boolean) => h.sql`
    update accounting.posting_rules set template = ${h.sql.json(template as never)}, is_modified = ${modified} where company_id = ${h.companyId} and event = 'payments.received' and name = 'Recibo de caja'`;
  const ruleTemplate = async () => (await h.sql<{ template: unknown }[]>`
    select template from accounting.posting_rules where company_id = ${h.companyId} and event = 'payments.received' and name = 'Recibo de caja'`)[0]!.template;

  it("an edited copy without a currency posts a foreign receipt in pesos only (debit_doc = debit)", async () => {
    await setRule(legacy(), true);
    try {
      const invoice = await foreignInvoice(1000, 4100);
      const receipt = await h.receive({ amount: 1000, methodId: usdMethod, currency: "USD", exchangeRate: 4100, allocations: [{ invoiceId: invoice.id, amount: 1000 }] });
      const { currency, lines } = await entryOf(receipt.id);
      expect(currency).toBe("COP");
      expect(lines).toEqual([
        { code: BANK, debit: 4100000, credit: 0, debit_doc: 4100000, credit_doc: 0 },
        { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 4100000 },
      ]);
    } finally {
      await setRule(paymentReceivedRule.template, false);
    }
  });

  it("0151 rewrites an unedited copy to the shipped template, leaves an edited one, and can run twice", async () => {
    await setRule(legacy(), false);
    for (let run = 0; run < 2; run++) await h.sql.begin((tx) => tx.unsafe(migration("0151_payments_rules_currency.sql")));
    expect(await ruleTemplate()).toEqual(paymentReceivedRule.template);
    await setRule(legacy(), true);
    await h.sql.begin((tx) => tx.unsafe(migration("0151_payments_rules_currency.sql")));
    expect(await ruleTemplate()).toEqual(legacy());
    await setRule(paymentReceivedRule.template, false);
  });
});

describe("0150 on existing rows", () => {
  it("backfills each allocation's amount_receipt and amount_company with its amount, a method's currency with the company's, and runs twice", async () => {
    const invoice = await h.issuedInvoice(1);
    const receipt = await h.receive({ amount: invoice.total, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] });
    await h.sql.begin(async (tx) => {
      // As a row stood before 0150: no receipt amount, so no check on it (0150 puts the check back).
      await tx`alter table payments.receipt_allocations drop constraint receipt_allocations_receipt_split`;
      await tx`set local session_replication_role = replica`;
      await tx`update payments.receipt_allocations set amount_receipt = 0, amount_company = 0 where receipt_id = ${receipt.id}`;
    });
    for (let run = 0; run < 2; run++) await h.sql.begin((tx) => tx.unsafe(migration("0150_payments_foreign_currency.sql")));
    expect(await allocationRow(receipt.id)).toEqual({ amount: invoice.total, amount_receipt: invoice.total, amount_company: invoice.total });
    const [method] = await h.sql<{ currency: string }[]>`select currency from payments.methods where id = ${h.methods.cash}`;
    expect(method!.currency).toBe("COP");
  });
});
