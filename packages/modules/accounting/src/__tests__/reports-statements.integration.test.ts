import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReport } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let year: number;
let adm: string;
let otr: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = async (code: string, name: string) =>
    (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, ${code}, ${name}, 'leaf') returning id`)[0]!.id;
  adm = await cc("ADM", "Administración");
  otr = await cc("OTR", "Otros");
  const entry = async (month: number, lines: { code: string; debit?: number; credit?: number; cc?: string }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(year, month), description: "Movimiento de prueba",
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.post", { id });
    return id;
  };
  await entry(1, [{ code: "111005", debit: 10_000 }, { code: "310505", credit: 10_000 }]);
  await entry(2, [{ code: "111005", debit: 3_000 }, { code: "413595", credit: 3_000, cc: adm }]);
  await entry(2, [{ code: "510506", debit: 800, cc: adm }, { code: "111005", credit: 800 }]);
  await entry(3, [{ code: "513505", debit: 200, cc: otr }, { code: "111005", credit: 200 }]);
  await entry(3, [{ code: "613595", debit: 500, cc: adm }, { code: "111005", credit: 500 }]);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (y: number, month: number, day = 15) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
// The year is named: other years may be open too (the balance sheet test opens the previous one), and period numbers repeat.
const periodId = async (n: number) =>
  (await h.sql<{ id: string }[]>`select p.id from accounting.periods p join accounting.fiscal_years y on y.id = p.fiscal_year_id where p.company_id = ${h.companyId} and y.year = ${year} and p.number = ${n}`)[0]!.id;
const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// Report rows are read cell by cell in the assertions: a loose record keeps them readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Row[]; total: number; aggregates: Record<string, any> };
const report = (caller: typeof h.admin | typeof h.auxiliar, id: string, params: Record<string, unknown>) => runReport(h.deps, caller, id, params, state) as Promise<Out>;
const trial = async (caller: typeof h.admin | typeof h.auxiliar, from: number, to: number, extra: Record<string, unknown> = {}) =>
  report(caller, "accounting.trial_balance", { from: await periodId(from), to: await periodId(to), ...extra });
const MONEY = ["opening_debit", "opening_credit", "debit", "credit", "closing_debit", "closing_credit"] as const;
const sumOf = (rows: Row[], field: string) => Math.round(rows.reduce((s, r) => s + Number(r[field]), 0) * 100) / 100;
const byCode = (rows: Row[], code: string) => rows.find((r) => r.account_code === code)!;
const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;

describe("statement reports", () => {
  it("the module registers its thirteen reports against consult processes", () => {
    expect(h.deps.registry.reports("accounting").map((r) => r.id).sort()).toEqual([
      "accounting.account_detail", "accounting.balance_sheet", "accounting.cost_center_statement", "accounting.dimension_detail", "accounting.income_statement",
      "accounting.journal_book", "accounting.ledger", "accounting.party_detail", "accounting.trial_balance",
      "accounting.aging", "accounting.control_reconciliation", "accounting.exogena", "accounting.manual_entries_audit",
    ].sort());
  });

  it("trial balance equals the ledger: per account, opening + movement = closing; totals debit = credit; level 2 sums level 4", async () => {
    const out = await trial(h.admin, 2, 3);
    const cash = byCode(out.rows, "1110");
    expect(cash).toMatchObject({ opening_debit: 10_000, opening_credit: 0, debit: 3_000, credit: 1_500, closing_debit: 11_500, closing_credit: 0 });
    expect(byCode(out.rows, "3105")).toMatchObject({ opening_credit: 10_000, closing_credit: 10_000, debit: 0 });
    expect(byCode(out.rows, "4135")).toMatchObject({ opening_debit: 0, credit: 3_000, closing_credit: 3_000 });
    for (const r of out.rows) {
      const opening = Number(r.opening_debit) - Number(r.opening_credit);
      const closing = Number(r.closing_debit) - Number(r.closing_credit);
      expect(closing).toBeCloseTo(opening + Number(r.debit) - Number(r.credit), 2);
    }
    expect(out.aggregates).toMatchObject({ opening_debit: 10_000, opening_credit: 10_000, debit: 4_500, credit: 4_500, closing_debit: 13_000, closing_credit: 13_000 });
    expect(out.aggregates.closing_debit).toBe(out.aggregates.closing_credit);
    expect(out.aggregates.restricted).toBe(0);

    const grouped = await trial(h.admin, 2, 3, { level: 2 });
    for (const group of grouped.rows) {
      const parts = out.rows.filter((r) => String(r.account_code).startsWith(group.account_code));
      // Debits and credits of a group are the sums of its accounts' (a group's opening and closing are netted, so they are compared as nets).
      expect(sumOf(parts, "debit")).toBe(group.debit);
      expect(sumOf(parts, "credit")).toBe(group.credit);
      const net = (rows: Row[], a: string, b: string) => Math.round((sumOf(rows, a) - sumOf(rows, b)) * 100) / 100;
      expect(net(parts, "closing_debit", "closing_credit")).toBe(net([group], "closing_debit", "closing_credit"));
      expect(net(parts, "opening_debit", "opening_credit")).toBe(net([group], "opening_debit", "opening_credit"));
    }
    // The level-2 totals equal the level-4 totals.
    for (const field of MONEY) expect(grouped.aggregates[field]).toBe(out.aggregates[field]);

    // From the first period the opening is empty and the movement is the whole year to date.
    const first = await trial(h.admin, 1, 3);
    expect(first.aggregates).toMatchObject({ opening_debit: 0, opening_credit: 0, debit: 14_500, credit: 14_500 });
    // A paged window: the totals still cover the whole filter.
    const page = (await runReport(h.deps, h.admin, "accounting.trial_balance", { from: await periodId(1), to: await periodId(3) }, { ...state, pageSize: 2 })) as Out;
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(first.rows.length);
    expect(page.aggregates.debit).toBe(14_500);
    // A dimension filter narrows every figure; sorting and filtering run on the rows.
    const filtered = await trial(h.admin, 1, 3, { costCenterId: adm });
    expect(filtered.aggregates).toMatchObject({ debit: 800 + 500, credit: 3_000 });
    const sorted = (await runReport(h.deps, h.admin, "accounting.trial_balance", { from: await periodId(1), to: await periodId(3) }, { ...state, sort: [{ field: "account_code", dir: "desc" }], filters: [{ field: "account_code", op: "starts", value: "5" }] })) as Out;
    expect(sorted.rows.map((r) => r.account_code)).toEqual(["5135", "5105"]);
    await expect(report(h.admin, "accounting.trial_balance", { from: await periodId(3), to: await periodId(1) })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("trial balance aggregates restricted accounts, totals equal: as auxiliar one row '🔒' with n = 1 and the admin's totals; as admin the detail", async () => {
    await h.runStepUp(h.admin, "accounting.account_permission.update", {
      accountId: await accountId("5105"), access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }],
    });
    try {
      for (const level of [4, 6]) {
        const admin = await trial(h.admin, 1, 3, { level });
        const aux = await trial(h.auxiliar, 1, 3, { level });
        const locked = aux.rows.filter((r) => r.account_code === "🔒");
        expect(locked).toHaveLength(1);
        expect(locked[0]).toMatchObject({ n: 1, debit: 800, credit: 0, account_name: "report.restricted_accounts" });
        expect(aux.rows.some((r) => String(r.account_code).startsWith("5105") || r.account_code === "510506")).toBe(false);
        expect(admin.rows.some((r) => r.account_code === (level === 4 ? "5105" : "510506"))).toBe(true);
        for (const field of MONEY) expect(aux.aggregates[field], `${field} at level ${level}`).toBe(admin.aggregates[field]);
        expect(aux.aggregates.restricted).toBe(1);
        expect(admin.aggregates.restricted).toBe(0);
      }
      // A user who may see it gets the detail.
      const contador = (await runReport(h.deps, h.contador, "accounting.trial_balance", { from: await periodId(1), to: await periodId(3) }, state)) as Out;
      expect(contador.rows.some((r) => r.account_code === "5105")).toBe(true);
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("5105"), access: "open", grants: [] });
    }
  });

  it("trial balance with restricted accounts of both natures keeps each side: six totals equal to the admin's, opening and closing", async () => {
    // 5105 is a debit account with movement; 3105 a credit account with an opening entry (period 1 entry, opening for period 2).
    const restrict = (code: string, access: "restricted" | "open") => async () =>
      h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId(code), access, grants: [] });
    await restrict("5105", "restricted")();
    await restrict("3105", "restricted")();
    try {
      for (const level of [4, 6]) {
        const admin = await trial(h.admin, 2, 3, { level, includeClosing: true });
        const aux = await trial(h.auxiliar, 2, 3, { level, includeClosing: true });
        for (const field of MONEY) expect(aux.aggregates[field], `${field} at level ${level}`).toBe(admin.aggregates[field]);
        const locked = aux.rows.filter((r) => r.account_code === "🔒");
        expect(locked).toHaveLength(1);
        expect(locked[0]).toMatchObject({ n: 2, opening_debit: 0, opening_credit: 10_000, debit: 800 + 0, credit: 0, closing_debit: 800, closing_credit: 10_000 });
      }
    } finally {
      await restrict("5105", "open")();
      await restrict("3105", "open")();
    }
  });

  it("libro mayor keeps each side of the restricted row at level 2", async () => {
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("31"), access: "restricted", grants: [] });
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("51"), access: "restricted", grants: [] });
    try {
      const params = { period: await periodId(2), level: 2 };
      const admin = await report(h.admin, "accounting.ledger", params);
      const aux = await report(h.auxiliar, "accounting.ledger", params);
      for (const field of MONEY) expect(aux.aggregates[field], field).toBe(admin.aggregates[field]);
      const locked = aux.rows.find((r) => r.account_code === "🔒")!;
      expect(locked).toMatchObject({ n: 2, opening_credit: 10_000, closing_credit: 10_000, closing_debit: 800 });
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("31"), access: "open", grants: [] });
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("51"), access: "open", grants: [] });
    }
  });

  it("balance sheet at October: assets = liabilities + equity + result; comparative column from December previous year", async () => {
    await h.run(h.admin, "accounting.fiscal_year.open", { year: year - 1 });
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(year - 1, 12), description: "Aporte del año anterior",
      lines: [{ accountCode: "111005", debit: 2_000 }, { accountCode: "310505", credit: 2_000 }],
    });
    await h.run(h.contador, "accounting.entry.post", { id });
    const out = await report(h.admin, "accounting.balance_sheet", { asOfPeriod: await periodId(10), level: 4 });
    expect(out.aggregates).toMatchObject({ assets: 13_500, liabilities: 0, equity: 13_500, result: 1_500, difference: 0, restricted: 0 });
    expect(out.rows.find((r) => r.account_code === "1110")).toMatchObject({ section: "assets_current", amount: 13_500, previous: 2_000 });
    expect(out.rows.find((r) => r.account_code === "3105")).toMatchObject({ section: "equity", amount: 12_000, previous: 2_000 });
    expect(out.rows.find((r) => r.row_kind === "result")).toMatchObject({ amount: 1_500, previous: 0 });
    const kinds = Object.fromEntries(out.rows.filter((r) => r.row_kind.startsWith("total") || r.row_kind === "difference").map((r) => [r.row_kind, r.amount]));
    expect(kinds).toEqual({ total_assets: 13_500, total_liabilities: 0, total_equity: 13_500, difference: 0 });
    expect(out.rows.filter((r) => r.row_kind === "subtotal").map((r) => r.section)).toEqual(["assets_current", "assets_noncurrent", "liabilities_current", "liabilities_noncurrent", "equity"]);
    // Without the comparative the previous column is empty.
    const bare = await report(h.admin, "accounting.balance_sheet", { asOfPeriod: await periodId(10), comparePrevious: false });
    expect(bare.rows.find((r) => r.account_code === "1110")).toMatchObject({ amount: 13_500, previous: 0 });
    // At March the result is the same: nothing happened after it.
    expect((await report(h.admin, "accounting.balance_sheet", { asOfPeriod: await periodId(3) })).aggregates).toMatchObject({ difference: 0, result: 1_500 });
    // At January there is no result yet.
    expect((await report(h.admin, "accounting.balance_sheet", { asOfPeriod: await periodId(1) })).aggregates).toMatchObject({ assets: 12_000, result: 0, difference: 0 });
  });

  it("balance sheet keeps the equation when an account is restricted: one lock line, the same totals as the admin", async () => {
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("3105"), access: "restricted", grants: [] });
    try {
      const admin = await report(h.admin, "accounting.balance_sheet", { asOfPeriod: await periodId(10) });
      const aux = await report(h.auxiliar, "accounting.balance_sheet", { asOfPeriod: await periodId(10) });
      expect(aux.rows.find((r) => r.account_code === "🔒")).toMatchObject({ section: "equity", amount: 12_000, n: 1 });
      expect(aux.rows.some((r) => r.account_code === "3105")).toBe(false);
      expect(aux.aggregates).toMatchObject({ assets: admin.aggregates.assets, equity: admin.aggregates.equity, difference: 0, restricted: 1 });
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("3105"), access: "open", grants: [] });
    }
  });

  it("income statement by cost center: the sum of the cost center columns equals the total column; opening and closing lines excluded", async () => {
    // A posted entry flagged as a year-close line must stay out of the statement.
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(year, 3, 20), description: "Línea de cierre", lines: [{ accountCode: "111005", debit: 77 }, { accountCode: "413595", credit: 77, costCenterId: adm }],
    });
    await h.run(h.contador, "accounting.entry.post", { id });
    await h.sql`update accounting.entries set is_closing = true where id = ${id}`;

    const params = { from: await periodId(1), to: await periodId(3) };
    const plain = await report(h.admin, "accounting.income_statement", params);
    const subtotal = (out: Out, section: string) => out.rows.find((r) => r.row_kind === "subtotal" && r.section === section)!.amount;
    expect(subtotal(plain, "revenue")).toBe(3_000);
    expect(subtotal(plain, "cost_of_sales")).toBe(500);
    expect(subtotal(plain, "operating_expenses")).toBe(1_000);
    expect(plain.rows.find((r) => r.row_kind === "result")!.amount).toBe(1_500);
    expect(plain.aggregates.result).toBe(1_500);

    const split = await report(h.admin, "accounting.income_statement", { ...params, byCostCenter: true });
    const perCenter = split.aggregates.byCostCenter as Record<string, number>;
    expect(perCenter).toEqual({ ADM: 1_700, OTR: -200 });
    expect(Object.values(perCenter).reduce((s, v) => s + v, 0)).toBe(plain.aggregates.result);
    expect(split.rows.find((r) => r.account_code === "4135" && r.cost_center_code === "ADM")).toMatchObject({ amount: 3_000, cost_center_name: "Administración" });

    // A year earlier there is nothing; the comparative column asks for it.
    const compared = await report(h.admin, "accounting.income_statement", { ...params, comparePrevious: true });
    expect(compared.rows.find((r) => r.row_kind === "result")).toMatchObject({ amount: 1_500, previous: 0 });
    // The trial balance counts the closing line only when asked.
    const withClosing = await trial(h.admin, 1, 3, { includeClosing: true });
    expect(byCode(withClosing.rows, "4135").credit).toBe(3_077);
    expect(byCode((await trial(h.admin, 1, 3)).rows, "4135").credit).toBe(3_000);
  });

  it("cost center statement adds each group's descendants and the lines with no center", async () => {
    const group = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'TOT', 'Todo', 'group') returning id`)[0]!.id;
    await h.sql`update accounting.cost_centers set parent_id = ${group} where id in (${adm}, ${otr})`;
    const params = { from: await periodId(1), to: await periodId(3) };
    const out = await report(h.admin, "accounting.cost_center_statement", params);
    const row = (code: string) => out.rows.find((r) => r.cost_center_code === code)!;
    expect(row("TOT")).toMatchObject({ depth: 0, income: 3_000, expense: 1_500, net: 1_500 });
    expect(row("ADM")).toMatchObject({ depth: 1, income: 3_000, expense: 1_300, net: 1_700 });
    expect(row("OTR")).toMatchObject({ depth: 1, income: 0, expense: 200, net: -200 });
    expect(out.aggregates).toMatchObject({ income: 3_000, expense: 1_500, net: 1_500 });
    const subtree = await report(h.admin, "accounting.cost_center_statement", { ...params, nodeId: adm });
    expect(subtree.rows.map((r) => r.cost_center_code)).toEqual(["ADM"]);
    await expect(report(h.admin, "accounting.cost_center_statement", { ...params, nodeId: group.replace(/.$/, "0") })).rejects.toMatchObject({ code: "invalid_input" });
    await h.sql`update accounting.cost_centers set parent_id = null where id in (${adm}, ${otr})`;
  });

  it("libro mayor y balances is the trial balance of one period; a member without the consult is refused", async () => {
    const out = await report(h.admin, "accounting.ledger", { period: await periodId(3), level: 4 });
    expect(byCode(out.rows, "1110")).toMatchObject({ opening_debit: 14_200, debit: 0, credit: 700 });
    expect(out.aggregates.debit).toBe(out.aggregates.credit);
    await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${h.auxiliar.roleId} and process_id = 'accounting.report.ledger'`;
    await expect(runReport(h.deps, h.auxiliar, "accounting.ledger", { period: await periodId(3) }, state)).rejects.toMatchObject({ code: "forbidden" });
    await expect(report(h.admin, "accounting.ledger", { period: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
