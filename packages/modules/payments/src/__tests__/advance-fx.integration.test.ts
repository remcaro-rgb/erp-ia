import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import advanceAppliedRule from "../rules/advance-applied.json" with { type: "json" };
import { paymentsHarness, type Harness } from "./helpers";

// Advances in a foreign currency (plan 2B.2 Task 34.6; FX §6 advances, §11; owner items 114, 126 (d) and (e), decided 2026-11-09: revenue
// covered by an advance stays at the invoice's TRM, the difference against the advance is realized exchange difference). An application
// is in the currency of its advances and invoices (the same: currency_mismatch otherwise); its entry debits customer_advances at the
// advance's rate, credits the receivable at the invoice's rate, and the difference goes to fx_gain / fx_loss (fx_kind:realized, no
// document amount):
//   (1) a USD advance at 4.000 applied to a USD invoice at 4.100: Dr 280505 $ 4.000.000 · Dr fx_loss $ 100.000 · Cr 130505 $ 4.100.000,
//       balanced in USD and in pesos; at 4.200 the difference is a gain; two applications drawing the whole advance at odd rates leave
//       280505 and the receivable at $ 0 for the customer, USD 0 open;
//   (2) a COP advance on a USD invoice, a USD advance on a COP or EUR invoice → currency_mismatch, nothing written;
//   (3) Deshacer reverses it, fx line and document amounts included;
//   (4) a COP application posts exactly as before (advance.integration.test.ts runs unchanged but for the refusal code of (2));
//   (5) advances are never revalued (NIC 21, item 126 (d)): the revaluation run reads the invoice's open dollars only;
//   (6) an edited old copy of the rule posts pesos only (R34-5); 0152 rewrites an unedited copy, backfills existing rows and can run twice.

const migration = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

let h: Harness;
let usdMethod: string;
let export0: string;
let customers = 0;
const newCustomer = (name: string) => h.newCustomer(`9013460${String(++customers).padStart(2, "0")}`, name);
const FX_GAIN = "421020";
const FX_LOSS = "530525";
const ADVANCES = "280505";
const RECEIVABLE = "130505";

beforeAll(async () => {
  h = await paymentsHarness();
  usdMethod = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "transfer_usd", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" })).id;
  export0 = (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku: "EXP-01", description: "Café verde de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
}, 300_000);
afterAll(async () => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
  await h.cleanup();
});

/** An issued export invoice of `total` in `currency` at `rate`, accepted by the DIAN. */
const foreignInvoice = (partyId: string, total: number, rate: number, currency = "USD") =>
  h.issuedInvoice(1, { partyId, currency, exchangeRate: rate, productId: export0, unitPrice: total });
/** A posted receipt of `amount` USD at `rate` that applies nothing: all of it is an advance (Cr 280505 at `rate`). */
const usdAdvance = (partyId: string, amount: number, rate: number) => h.receive({ partyId, amount, methodId: usdMethod, currency: "USD", exchangeRate: rate, allocations: [] });

type Line = { code: string; debit: number; credit: number; debit_doc: number; credit_doc: number };
/** The entry an application posted (or its reversal): currency, rate and each line's account and four amounts. */
const entryOf = async (sourceId: string, reversal = false) => {
  const entry = (await h.entriesOfSource(sourceId)).find((e) => (e.reversal_of_id !== null) === reversal)!;
  const [header] = await h.sql<{ currency: string; exchange_rate: string }[]>`select currency, exchange_rate::text from accounting.entries where id = ${entry.id}`;
  const lines = await h.sql<Line[]>`
    select a.code, l.debit::float8 as debit, l.credit::float8 as credit, l.debit_doc::float8 as debit_doc, l.credit_doc::float8 as credit_doc
    from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entry.id} order by l.line_no`;
  return { currency: header!.currency, rate: Number(header!.exchange_rate), lines };
};
const sums = (lines: Line[]) => ({
  debit: Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100), credit: Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100),
  debitDoc: Math.round(lines.reduce((s, l) => s + l.debit_doc, 0) * 100), creditDoc: Math.round(lines.reduce((s, l) => s + l.credit_doc, 0) * 100),
});
/** The party's ledger balance on an account, in pesos (debit − credit) and in the entries' document currency. */
const balanceOf = async (partyId: string, code: string) => (await h.sql<{ net: number; net_doc: number }[]>`
  select coalesce(sum(l.debit - l.credit), 0)::float8 as net, coalesce(sum(l.debit_doc - l.credit_doc), 0)::float8 as net_doc
  from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id join accounting.entries e on e.id = l.entry_id
  where l.company_id = ${h.companyId} and l.party_id = ${partyId} and a.code = ${code} and e.status in ('posted', 'reversed')`)[0]!;
/** The receivable open items of a party, in pesos and in the invoice's currency. */
const openOf = async (partyId: string) => {
  const rows = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ open: string; open_doc: string }[]>`
    select o.open::text, o.open_doc::text from accounting.open_items(${h.companyId}, ${h.today}::date) o where o.party_id = ${partyId} and o.kind = 'document'`);
  return { open: rows.reduce((s, r) => s + Number(r.open), 0), openDoc: rows.reduce((s, r) => s + Number(r.open_doc), 0) };
};
const headerRow = async (applicationId: string) => (await h.sql<{ currency: string; exchange_rate: number; total: number; total_company: number }[]>`
  select currency, exchange_rate::float8 as exchange_rate, total::float8 as total, total_company::float8 as total_company from payments.advance_applications where id = ${applicationId}`)[0]!;
const lineRows = (applicationId: string) => h.sql<{ amount: number; amount_company: number; advance_company: number }[]>`
  select amount::float8 as amount, amount_company::float8 as amount_company, advance_company::float8 as advance_company
  from payments.advance_application_lines where application_id = ${applicationId} order by line_no`;
const remainingOf = async (partyId: string, receiptId: string) => (await h.openAdvances(partyId)).find((a) => a.receiptId === receiptId)?.remaining ?? 0;

describe("(1) a USD advance applied to a USD invoice (item 126 (e): the invoice at its TRM, the difference realized)", () => {
  it("at 4.000 on an invoice at 4.100: Dr 280505 4.000.000 · Dr fx_loss 100.000 · Cr 130505 4.100.000, in USD, balanced in both currencies", async () => {
    const partyId = await newCustomer("Northwind Roasters LLC");
    const invoice = await foreignInvoice(partyId, 1000, 4100);
    const receipt = await usdAdvance(partyId, 1000, 4000);
    expect(receipt).toMatchObject({ currency: "USD", exchangeRate: 4000, advance: 1000 });
    expect(await remainingOf(partyId, receipt.id)).toBe(1000);

    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId });
    expect(application).toMatchObject({ status: "posted", total: 1000, currency: "USD", exchangeRate: 4000, totalCompany: 4100000 });
    expect(await headerRow(application.id)).toEqual({ currency: "USD", exchange_rate: 4000, total: 1000, total_company: 4100000 });
    expect(await lineRows(application.id)).toEqual([{ amount: 1000, amount_company: 4100000, advance_company: 4000000 }]);

    const { currency, rate, lines } = await entryOf(application.id);
    expect(currency).toBe("USD");
    expect(rate).toBe(4000);
    expect(lines).toEqual([
      { code: ADVANCES, debit: 4000000, credit: 0, debit_doc: 1000, credit_doc: 0 },
      { code: FX_LOSS, debit: 100000, credit: 0, debit_doc: 0, credit_doc: 0 },
      { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 1000 },
    ]);
    const s = sums(lines);
    expect(s.debit).toBe(s.credit);
    expect(s.debitDoc).toBe(s.creditDoc);

    const [event] = await h.eventsOf("payments.advance.applied", application.id);
    expect(event!.payload).toMatchObject({
      currency: "USD", exchangeRate: 4000, total: 4100000, totalDoc: 1000, drawn: 4000000, drawnDoc: 1000,
      allocations: [{ invoiceId: invoice.id, amount: 1000, amountCompany: 4100000, fx: { gain: 0, loss: 100000 } }],
      advances: [{ receiptId: receipt.id, amount: 4000000, amountDoc: 1000 }],
    });

    // The advance is spent and the invoice closed in both currencies.
    expect(await remainingOf(partyId, receipt.id)).toBe(0);
    expect(await balanceOf(partyId, ADVANCES)).toEqual({ net: 0, net_doc: 0 });
    expect(await balanceOf(partyId, RECEIVABLE)).toEqual({ net: 0, net_doc: 0 });
    expect(await openOf(partyId)).toEqual({ open: 0, openDoc: 0 });
    expect(await h.drain()).toEqual([]);
    expect((await h.stageOf(invoice.id)).stage).toBe("paid");
  });

  it("at 4.200 the difference is a gain: Cr fx_gain 100.000", async () => {
    const partyId = await newCustomer("Northwind Gain LLC");
    const invoice = await foreignInvoice(partyId, 1000, 4100);
    const receipt = await usdAdvance(partyId, 1000, 4200);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId });
    expect((await entryOf(application.id)).lines).toEqual([
      { code: ADVANCES, debit: 4200000, credit: 0, debit_doc: 1000, credit_doc: 0 },
      { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 1000 },
      { code: FX_GAIN, debit: 0, credit: 100000, debit_doc: 0, credit_doc: 0 },
    ]);
  });

  it("two applications that draw the whole advance at odd rates leave 280505 and the receivable at $ 0, USD 0 open", async () => {
    const partyId = await newCustomer("Northwind Partial LLC");
    const invoice = await foreignInvoice(partyId, 1000, 4100.987);
    const receipt = await usdAdvance(partyId, 1000, 4000.123);
    const first = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 333.33 }], { partyId });
    expect(await remainingOf(partyId, receipt.id)).toBe(666.67);
    expect(await openOf(partyId)).toMatchObject({ openDoc: 666.67 });
    expect((await h.stageOf(invoice.id)).stage).toBe("issued");
    const second = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 666.67 }], { partyId });
    for (const id of [first.id, second.id]) {
      const s = sums((await entryOf(id)).lines);
      expect(s.debit).toBe(s.credit);
      expect(s.debitDoc).toBe(s.creditDoc);
    }
    expect(await balanceOf(partyId, ADVANCES)).toEqual({ net: 0, net_doc: 0 });
    expect(await balanceOf(partyId, RECEIVABLE)).toEqual({ net: 0, net_doc: 0 });
    expect(await openOf(partyId)).toEqual({ open: 0, openDoc: 0 });
  });
});

describe("(2) the currency pairs of an application", () => {
  it("a COP advance on a USD invoice, a USD advance on a COP or a EUR invoice → currency_mismatch, nothing written", async () => {
    const partyId = await newCustomer("Northwind Pairs LLC");
    const usd = await foreignInvoice(partyId, 100, 4100);
    const eur = await foreignInvoice(partyId, 100, 4500, "EUR");
    const cop = await h.issuedInvoice(1, { partyId });
    const copAdvance = await h.advanceReceipt(500000, { partyId });
    const usdReceipt = await usdAdvance(partyId, 500, 4000);
    const before = await h.applicationFootprint();
    for (const line of [
      { receiptId: copAdvance.id, invoiceId: usd.id, amount: 10 },
      { receiptId: usdReceipt.id, invoiceId: cop.id, amount: 10 },
      { receiptId: usdReceipt.id, invoiceId: eur.id, amount: 10 },
    ]) {
      expect((await h.refusal(h.apply([line], { partyId })))?.message).toMatch(/^currency_mismatch/);
    }
    expect(await h.applicationFootprint()).toEqual(before);
  });
});

describe("(3) Deshacer aplicación", () => {
  it("reverses the entry, the fx line and the dollars included; the advance and the invoice are open again", async () => {
    const partyId = await newCustomer("Northwind Undo LLC");
    const invoice = await foreignInvoice(partyId, 1000, 4100);
    const receipt = await usdAdvance(partyId, 1000, 4000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId });
    await h.drain();
    await h.runStepUp("payments.advance.undo", { id: application.id, reason: "Aplicada a la factura equivocada" });
    const reversal = await entryOf(application.id, true);
    expect(reversal.currency).toBe("USD");
    expect(reversal.lines).toEqual(expect.arrayContaining([
      { code: ADVANCES, debit: 0, credit: 4000000, debit_doc: 0, credit_doc: 1000 },
      { code: FX_LOSS, debit: 0, credit: 100000, debit_doc: 0, credit_doc: 0 },
      { code: RECEIVABLE, debit: 4100000, credit: 0, debit_doc: 1000, credit_doc: 0 },
    ]));
    expect(reversal.lines).toHaveLength(3);
    expect(await remainingOf(partyId, receipt.id)).toBe(1000);
    expect(await balanceOf(partyId, ADVANCES)).toEqual({ net: -4000000, net_doc: -1000 });
    expect(await openOf(partyId)).toEqual({ open: 4100000, openDoc: 1000 });
    expect(await balanceOf(partyId, FX_LOSS)).toEqual({ net: 0, net_doc: 0 });
    await h.drain();
    expect((await h.stageOf(invoice.id)).stage).toBe("issued");
  });
});

describe("(4) a COP application", () => {
  it("posts as before: COP at rate 1, document amounts equal to company amounts, no fx line; the line's pesos are its amount", async () => {
    const partyId = await newCustomer("Cliente Pesos Anticipo S.A.S.");
    const invoice = await h.issuedInvoice(1, { partyId });
    const receipt = await h.advanceReceipt(119000, { partyId });
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    expect(application).toMatchObject({ currency: "COP", exchangeRate: 1, total: 119000, totalCompany: 119000 });
    const { currency, rate, lines } = await entryOf(application.id);
    expect({ currency, rate }).toEqual({ currency: "COP", rate: 1 });
    expect(lines).toEqual([
      { code: ADVANCES, debit: 119000, credit: 0, debit_doc: 119000, credit_doc: 0 },
      { code: RECEIVABLE, debit: 0, credit: 119000, debit_doc: 0, credit_doc: 119000 },
    ]);
    expect(await lineRows(application.id)).toEqual([{ amount: 119000, amount_company: 119000, advance_company: 119000 }]);
  });
});

describe("(5) advances are not revalued (NIC 21, item 126 (d))", () => {
  it("the run adjusts the invoice's open dollars only; the advance left on 280505 gets no line", async () => {
    const partyId = await newCustomer("Northwind Revalue LLC");
    const invoice = await foreignInvoice(partyId, 1000, 4100);
    const receipt = await usdAdvance(partyId, 1000, 4000);
    await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 400 }], { partyId });
    const [period] = await h.sql<{ id: string; ends_on: string }[]>`
      select id, ends_on::text from accounting.periods where company_id = ${h.companyId} and ${h.today}::date between starts_on and ends_on`;
    // The closing rates of the period (the EUR invoice of (2) is open too).
    await h.sql`delete from core.exchange_rates where company_id = ${h.companyId} and rate_date = ${period!.ends_on}::date`;
    await h.sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values
      (${h.companyId}, 'USD', ${period!.ends_on}::date, 4300, 'manual'), (${h.companyId}, 'EUR', ${period!.ends_on}::date, 4600, 'manual')`;
    const out = await h.runStepUp<{ revaluationId: string; entryId: string | null }>("accounting.fx_revaluation.run", { periodId: period!.id });
    try {
      expect(out.entryId).not.toBeNull();
      const lines = await h.sql<{ code: string; debit: number; credit: number }[]>`
        select a.code, l.debit::float8 as debit, l.credit::float8 as credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
        where l.entry_id = ${out.entryId} and l.party_id = ${partyId} order by l.line_no`;
      // USD 600 open at 4.100 (2.460.000) revalued at 4.300 (2.580.000): + 120.000 on the receivable; nothing on 280505.
      expect(lines).toEqual([{ code: RECEIVABLE, debit: 120000, credit: 0 }]);
    } finally {
      await h.runStepUp("accounting.fx_revaluation.void", { revaluationId: out.revaluationId });
    }
  });
});

describe("(6) old copies of the application rule (R34-5) and migration 0152", () => {
  /** The rule as Task 36 shipped it: no currency path, Dr customer_advances / Cr receivable for $.total. */
  const legacy = () => ({
    date: "$.date",
    description: "Aplicación de anticipo {{number}} · {{customer.legalName}}",
    party: "$.customer.partyId",
    source: { entity: "payments.advance_application", id: "$.applicationId" },
    lines: [{ role: "customer_advances", side: "debit", amount: "$.total" }, { role: "receivable", side: "credit", amount: "$.total" }],
    reverseOf: null,
  });
  const setRule = (template: unknown, modified: boolean) => h.sql`
    update accounting.posting_rules set template = ${h.sql.json(template as never)}, is_modified = ${modified}
    where company_id = ${h.companyId} and event = 'payments.advance.applied' and name = 'Aplicación de anticipo'`;
  const ruleTemplate = async () => (await h.sql<{ template: unknown }[]>`
    select template from accounting.posting_rules where company_id = ${h.companyId} and event = 'payments.advance.applied' and name = 'Aplicación de anticipo'`)[0]!.template;

  it("an edited copy without a currency posts a foreign application in pesos only, at the invoice's rate", async () => {
    await setRule(legacy(), true);
    try {
      const partyId = await newCustomer("Northwind Legacy LLC");
      const invoice = await foreignInvoice(partyId, 1000, 4100);
      const receipt = await usdAdvance(partyId, 1000, 4100);
      const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId });
      const { currency, lines } = await entryOf(application.id);
      expect(currency).toBe("COP");
      expect(lines).toEqual([
        { code: ADVANCES, debit: 4100000, credit: 0, debit_doc: 4100000, credit_doc: 0 },
        { code: RECEIVABLE, debit: 0, credit: 4100000, debit_doc: 0, credit_doc: 4100000 },
      ]);
    } finally {
      await setRule(advanceAppliedRule.template, false);
    }
  });

  it("0152 rewrites an unedited copy to the shipped template, leaves an edited one, and can run twice", async () => {
    await setRule(legacy(), false);
    for (let run = 0; run < 2; run++) await h.sql.begin((tx) => tx.unsafe(migration("0152_payments_advance_applications_currency.sql")));
    expect(await ruleTemplate()).toEqual(advanceAppliedRule.template);
    await setRule(legacy(), true);
    await h.sql.begin((tx) => tx.unsafe(migration("0152_payments_advance_applications_currency.sql")));
    expect(await ruleTemplate()).toEqual(legacy());
    await setRule(advanceAppliedRule.template, false);
  });

  it("backfills an existing application's rate (1), its pesos and each line's advance pesos with its amount, and runs twice", async () => {
    const partyId = await newCustomer("Cliente Backfill Anticipo S.A.S.");
    const invoice = await h.issuedInvoice(1, { partyId });
    const receipt = await h.advanceReceipt(119000, { partyId });
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update payments.advance_applications set total_company = 0 where id = ${application.id}`;
      await tx`update payments.advance_application_lines set advance_company = 0 where application_id = ${application.id}`;
    });
    for (let run = 0; run < 2; run++) await h.sql.begin((tx) => tx.unsafe(migration("0152_payments_advance_applications_currency.sql")));
    expect(await headerRow(application.id)).toEqual({ currency: "COP", exchange_rate: 1, total: 119000, total_company: 119000 });
    expect(await lineRows(application.id)).toEqual([{ amount: 119000, amount_company: 119000, advance_company: 119000 }]);
  });
});
