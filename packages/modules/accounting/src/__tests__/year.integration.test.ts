import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let year: number;
let ccId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  ccId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (y: number, month: number, day = 15) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const yearId = async (y: number) => (await h.sql<{ id: string }[]>`select id from accounting.fiscal_years where company_id = ${h.companyId} and year = ${y}`)[0]!.id;
const post = async (date: string, lines: { code: string; debit?: number; credit?: number; cc?: boolean }[]) => {
  const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
    date, description: "Movimiento del año",
    lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: ccId } : {}) })),
  });
  await h.run(h.contador, "accounting.entry.post", { id });
  return id;
};
const closeAllPeriods = (y: number) => yearId(y).then((id) => h.sql`update accounting.periods set status = 'closed' where fiscal_year_id = ${id}`);
const balance = async (code: string, opts: { closing?: boolean } = {}) =>
  Number((await h.sql<{ b: string | null }[]>`
    select sum(l.debit - l.credit) as b from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
    where l.company_id = ${h.companyId} and a.code = ${code} and e.status in ('posted', 'reversed') and (${opts.closing ?? true} or not e.is_closing)`)[0]!.b ?? 0);

describe("year close", () => {
  it("year close lands on 3605 or 3610 by sign: profit → two CI entries, 5905 zero, 360505 credit = result; loss → 361005 debit; reopen reverses both and reopens December", async () => {
    // Profit: income 1.000, expense 400 and cost 100 → 500.
    await post(dateIn(year, 3, 10), [{ code: "111005", debit: 1000 }, { code: "413595", credit: 1000, cc: true }]);
    await post(dateIn(year, 4, 10), [{ code: "510506", debit: 400, cc: true }, { code: "111005", credit: 400 }]);
    await post(dateIn(year, 5, 10), [{ code: "613595", debit: 100, cc: true }, { code: "111005", credit: 100 }]);

    const fy = await yearId(year);
    await expect(h.runStepUp(h.admin, "accounting.year.close", { fiscalYearId: fy })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("doce períodos")] });
    await expect(h.run(h.admin, "accounting.year.close", { fiscalYearId: fy })).rejects.toMatchObject({ code: "step_up_required" });
    await closeAllPeriods(year);
    const out = await h.runStepUp<{ result: number; closingEntryIds: string[]; nextYearId: string }>(h.admin, "accounting.year.close", { fiscalYearId: fy });
    expect(out.result).toBe(500);
    expect(out.closingEntryIds).toHaveLength(2);
    expect((await h.sql`select status from accounting.fiscal_years where id = ${fy}`)[0]).toMatchObject({ status: "closed" });
    // The next year exists with its twelve periods.
    expect(await h.sql`select 1 from accounting.periods where fiscal_year_id = ${out.nextYearId}`).toHaveLength(12);

    const entries = await h.sql`
      select e.number, e.is_closing, e.status, e.date::text as date, j.code as journal from accounting.entries e join accounting.journals j on j.id = e.journal_id
      where e.id = any(${out.closingEntryIds}::uuid[]) order by e.seq`;
    expect(entries).toEqual([
      { number: "CI-1", is_closing: true, status: "posted", date: dateIn(year, 12, 31), journal: "CI" },
      { number: "CI-2", is_closing: true, status: "posted", date: dateIn(year, 12, 31), journal: "CI" },
    ]);
    // Result accounts are at zero, 5905 is at zero, and 3605 holds the profit as a credit.
    expect(await balance("413595")).toBe(0);
    expect(await balance("510506")).toBe(0);
    expect(await balance("613595")).toBe(0);
    expect(await balance("590505")).toBe(0);
    expect(await balance("360505")).toBe(-500);
    // Without the closing entries the figures are untouched (reports leave them out).
    expect(await balance("413595", { closing: false })).toBe(-1000);
    // The cost center travels on the result lines so its own balance is zero as well.
    const [cc] = await h.sql<{ b: string }[]>`
      select sum(l.debit - l.credit) as b from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${h.companyId} and a.code = '510506' and l.cost_center_id = ${ccId}`;
    expect(Number(cc!.b)).toBe(0);
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.year.closed'`).toHaveLength(1);
    await expect(h.runStepUp(h.admin, "accounting.year.close", { fiscalYearId: fy })).rejects.toMatchObject({ code: "invalid_input" });

    // A closing entry is reversed only by reopening the year.
    await expect(h.run(h.admin, "accounting.entry.reverse", { id: out.closingEntryIds[0]!, reason: "x" })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("year.reopen")] });

    const reopened = await h.runStepUp<{ reversedEntryIds: string[] }>(h.admin, "accounting.year.reopen", { fiscalYearId: fy });
    expect(reopened.reversedEntryIds).toHaveLength(2);
    expect((await h.sql`select status from accounting.fiscal_years where id = ${fy}`)[0]).toMatchObject({ status: "open" });
    const december = await h.sql`select status from accounting.periods where fiscal_year_id = ${fy} and number = 12`;
    expect(december[0]).toMatchObject({ status: "open" });
    expect((await h.sql`select count(*)::int as n from accounting.periods where fiscal_year_id = ${fy} and status = 'open'`)[0]!.n).toBe(1);
    expect((await h.sql`select status from accounting.entries where id = any(${out.closingEntryIds}::uuid[])`).every((e) => e.status === "reversed")).toBe(true);
    // The reversals cancel the closings: the accounts hold their year balances again, 3605 is empty.
    expect(await balance("413595")).toBe(-1000);
    expect(await balance("360505")).toBe(0);
    await expect(h.runStepUp(h.admin, "accounting.year.reopen", { fiscalYearId: fy })).rejects.toMatchObject({ code: "invalid_input" });

    // Closing again after December is closed lands on the same result.
    await h.sql`update accounting.periods set status = 'closed' where fiscal_year_id = ${fy}`;
    const again = await h.runStepUp<{ result: number }>(h.admin, "accounting.year.close", { fiscalYearId: fy });
    expect(again.result).toBe(500);
    expect(await balance("360505")).toBe(-500);
  });

  it("a loss lands on 361005 as a debit; a year with no result accounts closes without entries; years reopen newest first", async () => {
    const prior = year - 1;
    await h.run(h.admin, "accounting.fiscal_year.open", { year: prior });
    await post(dateIn(prior, 2, 10), [{ code: "111005", debit: 200 }, { code: "413595", credit: 200, cc: true }]);
    await post(dateIn(prior, 3, 10), [{ code: "510506", debit: 700, cc: true }, { code: "111005", credit: 700 }]);
    await closeAllPeriods(prior);
    const fy = await yearId(prior);
    const out = await h.runStepUp<{ result: number; closingEntryIds: string[] }>(h.admin, "accounting.year.close", { fiscalYearId: fy });
    expect(out.result).toBe(-500);
    expect(out.closingEntryIds).toHaveLength(2);
    expect(await balance("361005")).toBe(500);
    // The current year is closed too (previous test): the older one cannot reopen before it.
    await expect(h.runStepUp(h.admin, "accounting.year.reopen", { fiscalYearId: fy })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining(String(year))] });
    await h.runStepUp(h.admin, "accounting.year.reopen", { fiscalYearId: await yearId(year) });
    await h.runStepUp(h.admin, "accounting.year.reopen", { fiscalYearId: fy });
    expect(await balance("361005")).toBe(0);

    const empty = await yearId(year + 1);
    await closeAllPeriods(year + 1);
    const none = await h.runStepUp<{ result: number; closingEntryIds: string[] }>(h.admin, "accounting.year.close", { fiscalYearId: empty });
    expect(none).toMatchObject({ result: 0, closingEntryIds: [] });
  });
});
