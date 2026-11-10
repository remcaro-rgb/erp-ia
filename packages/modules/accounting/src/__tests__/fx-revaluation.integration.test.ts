import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
// The payments harness (core, accounting on the demo chart, invoicing and payments): accounting cannot depend on payments or invoicing.
import { paymentsHarness, type Harness } from "../../../payments/src/__tests__/helpers";

// The unrealized exchange difference at a period's end (plan 2B.2 Task 34.7; FX §5 unrealized, §11 0153; owner items 126 (b), (c), (d)
// as recommended pending the accountant, 130; review focus 3 of Task 34):
//   (4) USD 1.000 open at 4.100 and a closing rate of 4.300: one line on the invoice (+ $ 200.000 receivable, no dollars), the gain to
//       fx_gain (fx_kind:unrealized), the reversal dated the first day of the next period;
//   (5) a later collection at 4.250 posts the realized gain of $ 150.000 against the invoice's own rate; open COP 0;
//   (6) a rerun voids the previous run and posts again; Anular reverses both entries;
//   (7) advances (non-monetary, NIC 21) and COP invoices are not revalued;
//   (8) the close check warns while a period with open USD items has no run, and does not block the close.

let h: Harness;
let usdMethod: string;
let export0: string;
let period: { id: string; startsOn: string; endsOn: string };
let nextDay: string;
let customers = 0;
const newCustomer = (name: string) => h.newCustomer(`9013500${String(++customers).padStart(2, "0")}`, name);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const FX_GAIN = "421020";
const FX_LOSS = "530525";
const RECEIVABLE = "130505";

type RunOut = { revaluationId: string; entryId: string | null; reversalEntryId: string | null; lines: number };
const revalue = (periodId = period.id) => h.runStepUp<RunOut>("accounting.fx_revaluation.run", { periodId });

beforeAll(async () => {
  h = await paymentsHarness();
  usdMethod = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "transfer_usd", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" })).id;
  export0 = (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku: "EXP-01", description: "Café verde de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
  const [p] = await h.sql<{ id: string; starts_on: string; ends_on: string }[]>`
    select id, starts_on::text, ends_on::text from accounting.periods where company_id = ${h.companyId} and ${h.today}::date between starts_on and ends_on`;
  period = { id: p!.id, startsOn: p!.starts_on, endsOn: p!.ends_on };
  nextDay = addDays(period.endsOn, 1);
}, 300_000);
afterAll(async () => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
  await h.cleanup();
});

const setClosingRate = async (rate: number, date = period.endsOn) => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId} and currency = 'USD' and rate_date = ${date}::date`;
  await h.sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', ${date}::date, ${rate}, 'manual')`;
};
const foreignInvoice = (partyId: string, total: number, rate: number) => h.issuedInvoice(1, { partyId, currency: "USD", exchangeRate: rate, productId: export0, unitPrice: total });

type Line = { code: string; party_id: string | null; debit: number; credit: number; debit_doc: number; credit_doc: number; cost_center_id: string | null };
const entryLines = async (entryId: string): Promise<Line[]> => (await h.sql<Line[]>`
  select a.code, l.party_id, l.debit::float8 as debit, l.credit::float8 as credit, l.debit_doc::float8 as debit_doc, l.credit_doc::float8 as credit_doc, l.cost_center_id
  from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`);
const entryHeader = async (entryId: string) => (await h.sql<{ date: string; status: string; currency: string; source_entity: string; source_record_id: string; reversal_of_id: string | null; journal: string }[]>`
  select e.date::text, e.status, e.currency, e.source_entity, e.source_record_id, e.reversal_of_id, j.kind as journal
  from accounting.entries e join accounting.journals j on j.id = e.journal_id where e.id = ${entryId}`)[0]!;
/** The receivable open items of a party in pesos and in its document currency, as the admin. */
const openOf = async (partyId: string, asOf: string) => {
  const rows = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ open: string; open_doc: string }[]>`
    select o.open::text, o.open_doc::text from accounting.open_items(${h.companyId}, ${asOf}::date) o where o.party_id = ${partyId} and o.kind = 'document'`);
  return { open: rows.reduce((s, r) => s + Number(r.open), 0), openDoc: rows.reduce((s, r) => s + Number(r.open_doc), 0) };
};
const revaluationRow = async (id: string) => (await h.sql<{ status: string; period_id: string; entry_id: string | null; reversal_entry_id: string | null; closing_rates: Record<string, number> }[]>`
  select status, period_id, entry_id, reversal_entry_id, closing_rates from accounting.fx_revaluations where id = ${id}`)[0]!;
const linesOfParty = (lines: Line[], partyId: string) => lines.filter((l) => l.party_id === partyId);

describe("accounting.fx_revaluation.run refusals", () => {
  it("needs the second factor", async () => {
    expect((await h.refusal(h.run(h.admin, "accounting.fx_revaluation.run", { periodId: period.id })))?.code).toBe("step_up_required");
  });

  it("refuses exchange_rate_missing while USD items are open and the table has no rate for the period's end", async () => {
    const party = await newCustomer("Northwind Sin Tasa LLC");
    await foreignInvoice(party, 10, 4100);
    await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
    expect((await h.refusal(revalue()))?.message).toMatch(/^exchange_rate_missing/);
  });
});

describe("(4) USD 1.000 open at 4.100, closing rate 4.300", () => {
  let party: string;
  let invoiceId: string;
  let out: RunOut;
  beforeAll(async () => {
    party = await newCustomer("Northwind Roasters Uno LLC");
    invoiceId = (await foreignInvoice(party, 1000, 4100)).id;
    await setClosingRate(4300);
    out = await revalue();
  });

  it("posts one receivable line on the invoice (+ $ 200.000, no dollars) and the gain to fx_gain, at the period's end in Notas", async () => {
    expect(out.lines).toBeGreaterThanOrEqual(1);
    const header = await entryHeader(out.entryId!);
    expect(header).toMatchObject({ date: period.endsOn, status: "posted", currency: "COP", source_entity: "accounting.fx_revaluation", source_record_id: out.revaluationId, journal: "general" });
    const lines = await entryLines(out.entryId!);
    expect(linesOfParty(lines, party)).toEqual([{ code: RECEIVABLE, party_id: party, debit: 200000, credit: 0, debit_doc: 0, credit_doc: 0, cost_center_id: null }]);
    const gain = lines.filter((l) => l.code === FX_GAIN);
    expect(gain).toHaveLength(1);
    expect(gain[0]).toMatchObject({ debit: 0, debit_doc: 0, credit_doc: 0 });
    expect(gain[0]!.credit).toBeGreaterThanOrEqual(200000);
    const [link] = await h.sql<{ invoice_id: string }[]>`
      select r.invoice_id from accounting.fx_revaluation_lines r join accounting.entry_lines l on l.id = r.entry_line_id
      where r.revaluation_id = ${out.revaluationId} and l.entry_id = ${out.entryId} and l.party_id = ${party}`;
    expect(link?.invoice_id).toBe(invoiceId);
  });

  it("reverses it on the first day of the next period, and records the run with its closing rates", async () => {
    const reversal = await entryHeader(out.reversalEntryId!);
    expect(reversal).toMatchObject({ date: nextDay, status: "posted", reversal_of_id: out.entryId, source_record_id: out.revaluationId });
    expect(linesOfParty(await entryLines(out.reversalEntryId!), party)).toEqual([{ code: RECEIVABLE, party_id: party, debit: 0, credit: 200000, debit_doc: 0, credit_doc: 0, cost_center_id: null }]);
    expect(await revaluationRow(out.revaluationId)).toMatchObject({ status: "posted", period_id: period.id, entry_id: out.entryId, reversal_entry_id: out.reversalEntryId, closing_rates: { USD: 4300 } });
    const [event] = await h.sql<{ payload: Record<string, unknown> }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.fx_revaluation.posted' and payload->>'revaluationId' = ${out.revaluationId}`;
    expect(event?.payload).toMatchObject({ revaluationId: out.revaluationId, periodId: period.id, entryId: out.entryId, reversalEntryId: out.reversalEntryId });
  });

  it("attaches the adjustment to the invoice: open $ 4.300.000 at the period's end, $ 4.100.000 from the next day, USD 1.000 throughout", async () => {
    expect(await openOf(party, period.endsOn)).toEqual({ open: 4300000, openDoc: 1000 });
    expect(await openOf(party, nextDay)).toEqual({ open: 4100000, openDoc: 1000 });
  });

  it("(5) a later collection at 4.250 posts the realized gain against the invoice's own rate and closes the invoice in both currencies", async () => {
    // A receipt cannot be dated after today (receipt_in_future) and the harness's period is the current one, so the collection is dated
    // today; from the reversal's date on, what the run added is gone and the collection settles the invoice at its own rate.
    const receipt = await h.receive({ partyId: party, amount: 1000, methodId: usdMethod, currency: "USD", exchangeRate: 4250, allocations: [{ invoiceId, amount: 1000 }] });
    expect(receipt.allocations[0]).toMatchObject({ amountCompany: 4100000, fx: { gain: 150000, loss: 0 } });
    expect(await openOf(party, nextDay)).toEqual({ open: 0, openDoc: 0 });
  });
});

describe("(6) rerun and Anular", () => {
  it("a rerun voids the previous run (both entries mirrored) and posts again; Anular reverses both entries", async () => {
    const party = await newCustomer("Northwind Rerun LLC");
    await foreignInvoice(party, 500, 4000);
    await setClosingRate(4300);
    const first = await revalue();
    await setClosingRate(4200);
    const second = await revalue();
    expect(second.revaluationId).not.toBe(first.revaluationId);
    expect((await revaluationRow(first.revaluationId)).status).toBe("voided");
    expect(await revaluationRow(second.revaluationId)).toMatchObject({ status: "posted", closing_rates: { USD: 4200 } });
    // USD 500 at 4.000 = $ 2.000.000, at 4.200 = $ 2.100.000: only the second run counts.
    expect(await openOf(party, period.endsOn)).toEqual({ open: 2100000, openDoc: 500 });
    const ofFirst = await h.sql<{ date: string; status: string }[]>`
      select date::text, status from accounting.entries where company_id = ${h.companyId} and source_record_id = ${first.revaluationId} order by date, seq`;
    expect(ofFirst.map((e) => e.date)).toEqual([period.endsOn, period.endsOn, nextDay, nextDay]);

    await h.runStepUp("accounting.fx_revaluation.void", { revaluationId: second.revaluationId });
    expect((await revaluationRow(second.revaluationId)).status).toBe("voided");
    expect(await openOf(party, period.endsOn)).toEqual({ open: 2000000, openDoc: 500 });
    expect(await openOf(party, nextDay)).toEqual({ open: 2000000, openDoc: 500 });
    const net = await h.sql<{ debit: string; credit: string }[]>`
      select sum(l.debit)::text as debit, sum(l.credit)::text as credit from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      join accounting.accounts a on a.id = l.account_id where e.source_record_id = ${second.revaluationId} and a.code = ${FX_GAIN}`;
    expect(Number(net[0]!.debit)).toBe(Number(net[0]!.credit));
    expect((await h.refusal(h.runStepUp("accounting.fx_revaluation.void", { revaluationId: second.revaluationId })))?.code).toBe("invalid_input");
  });

  it("a closing rate below the carrying rate posts a loss to fx_loss", async () => {
    const party = await newCustomer("Northwind Loss LLC");
    await foreignInvoice(party, 100, 4400);
    await setClosingRate(4300);
    const out = await revalue();
    const lines = await entryLines(out.entryId!);
    expect(linesOfParty(lines, party)).toEqual([{ code: RECEIVABLE, party_id: party, debit: 0, credit: 10000, debit_doc: 0, credit_doc: 0, cost_center_id: null }]);
    expect(lines.filter((l) => l.code === FX_LOSS).map((l) => l.credit)).toEqual([0]);
  });
});

describe("(7) what is not revalued", () => {
  it("an advance and a COP invoice get no line", async () => {
    const party = await newCustomer("Distribuidora Nacional S.A.S.");
    await h.issuedInvoice(1, { partyId: party });
    await h.receive({ partyId: party, amount: 50000, allocations: [] });
    await setClosingRate(4300);
    const out = await revalue();
    if (out.entryId) expect(linesOfParty(await entryLines(out.entryId), party)).toEqual([]);
    const [links] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from accounting.fx_revaluation_lines r join accounting.entry_lines l on l.id = r.entry_line_id where l.party_id = ${party}`;
    expect(links!.n).toBe(0);
  });
});

describe("(8) the close check «Diferencia en cambio no calculada»", () => {
  it("warns while the period has open USD items and no run, and does not block the close", async () => {
    // Close the earlier periods of the year (they hold nothing), then the current one with its run voided.
    const earlier = await h.sql<{ id: string }[]>`
      select id from accounting.periods where company_id = ${h.companyId} and ends_on < ${period.startsOn}::date and status = 'open' order by starts_on`;
    for (const p of earlier) {
      const out = await h.runStepUp<{ closed: boolean; checks: { check: string; passed: boolean; severity?: string }[] }>("accounting.period.close", { periodId: p.id });
      expect(out.closed).toBe(true);
      expect(out.checks.find((c) => c.check === "fx_revaluation")).toMatchObject({ passed: true });
    }
    const [latest] = await h.sql<{ id: string }[]>`
      select id from accounting.fx_revaluations where company_id = ${h.companyId} and period_id = ${period.id} and status = 'posted'`;
    if (latest) await h.runStepUp("accounting.fx_revaluation.void", { revaluationId: latest.id });
    // The engine posts inline in this harness; the dispatcher's mark is what the «eventos sin despachar» check reads.
    await h.sql`update kernel.outbox set dispatched_at = now() where company_id = ${h.companyId} and dispatched_at is null`;
    const out = await h.runStepUp<{ closed: boolean; checks: { check: string; passed: boolean; severity?: string; note: string }[]; failed: string[]; warnings: string[] }>("accounting.period.close", { periodId: period.id });
    const fx = out.checks.find((c) => c.check === "fx_revaluation")!;
    expect(fx).toMatchObject({ passed: false, severity: "warning" });
    expect(fx.note).toMatch(/^Diferencia en cambio no calculada/);
    expect(out.warnings).toEqual([fx.note]);
    expect(out.failed).not.toContain(fx.note);
    expect(out.closed).toBe(out.failed.length === 0);
    expect(out.failed).toEqual([]);
  });
});
