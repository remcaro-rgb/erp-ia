import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Chart, Kpi } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";

// The accounting module's Inicio page (kernel.home.kpis with module: accounting): income, expenses, margin, liquidity and posting
// indicators, and the charts of the last six months, all read from the masked balances and entries as the caller.

let h: AccountingHarness;
type Page = { kpis: Kpi[]; charts: Chart[]; catalog: { id: string; kind: string }[] };

const page = (caller: typeof h.admin) => h.run<Page>(caller, "kernel.home.kpis", { module: "accounting" });
const kpi = async (caller: typeof h.admin, id: string) => (await page(caller)).kpis.find((k) => k.id === id);
const chart = async (caller: typeof h.admin, id: string) => (await page(caller)).charts.find((c) => c.id === id);
const month = new Date().toISOString().slice(0, 7);

beforeAll(async () => {
  h = await accountingHarness();
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["kernel.home.kpis"]);
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  const today = new Date().toISOString().slice(0, 10);
  const [cc] = await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`;
  const post = async (lines: { code: string; debit?: number; credit?: number }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: today, description: "Movimiento del mes", lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, costCenterId: cc!.id })),
    });
    await h.run(h.contador, "accounting.entry.save", { id });
  };
  await post([{ code: "111005", debit: 5_000_000 }, { code: "413595", credit: 5_000_000 }]);
  await post([{ code: "510506", debit: 1_250_000 }, { code: "111005", credit: 1_250_000 }]);
  await h.run(h.contador, "accounting.entry.create", { date: today, description: "Borrador", lines: [{ accountCode: "111005", debit: 10, credit: 0 }, { accountCode: "413595", debit: 0, credit: 10, costCenterId: cc!.id }] });
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("accounting Inicio page", () => {
  it("has the module's indicators and charts, in order", async () => {
    const { kpis, charts, catalog } = await page(h.admin);
    expect(kpis.map((k) => k.id)).toEqual([
      "accounting.result_month",
      "accounting.income_month",
      "accounting.expenses_month",
      "accounting.margin_month",
      "accounting.working_capital",
      "accounting.posted_entries",
      "accounting.pending_failures",
      "accounting.open_periods",
      "accounting.draft_entries",
    ]);
    expect(charts.map((c) => c.id)).toEqual(["accounting.income_vs_expenses", "accounting.result_trend", "accounting.entries_by_status", "accounting.top_expenses"]);
    expect(catalog.map((c) => c.id).sort()).toEqual(
      [...kpis.map((k) => k.id), ...charts.map((c) => c.id), "accounting.current_ratio"].sort(),
    );
  });

  it("income, expenses, margin and working capital of the month are the ledger's figures", async () => {
    expect(await kpi(h.admin, "accounting.income_month")).toMatchObject({ value: 5_000_000, unit: "money", detail: { params: { month } } });
    expect(await kpi(h.admin, "accounting.expenses_month")).toMatchObject({ value: 1_250_000, unit: "money" });
    expect(await kpi(h.admin, "accounting.margin_month")).toMatchObject({ value: 75, unit: "percent" });
    // Cash 5.000.000 − 1.250.000 (+ the draft's 10, which is not posted yet): current assets less no current liabilities.
    expect(await kpi(h.admin, "accounting.working_capital")).toMatchObject({ unit: "money" });
    expect((await kpi(h.admin, "accounting.working_capital"))!.value).toBeGreaterThanOrEqual(3_750_000);
  });

  it("the current ratio waits for current liabilities, then divides the assets by them", async () => {
    expect(await kpi(h.admin, "accounting.current_ratio")).toBeUndefined();
    const today = new Date().toISOString().slice(0, 10);
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: today, description: "Obligación", lines: [{ accountCode: "111005", debit: 1_000_000, credit: 0 }, { accountCode: "210505", debit: 0, credit: 1_000_000 }],
    });
    await h.run(h.contador, "accounting.entry.save", { id });
    const ratio = await kpi(h.admin, "accounting.current_ratio");
    expect(ratio).toMatchObject({ unit: "ratio" });
    expect(ratio!.value).toBeGreaterThan(1);
    expect(ratio!.tone).toBeUndefined();
  });

  it("entries posted in the period, out of the entries that already belong to it (a draft has no period yet)", async () => {
    const [counts] = await h.sql<{ posted: number; total: number }[]>`
      select count(*) filter (where status = 'posted')::int as posted, count(*)::int as total from accounting.entries e
      where e.company_id = ${h.companyId} and e.period_id = (select id from accounting.periods where company_id = ${h.companyId} and current_date between starts_on and ends_on)`;
    expect(counts!.posted).toBeGreaterThanOrEqual(3);
    expect(await kpi(h.admin, "accounting.posted_entries")).toMatchObject({ value: counts!.posted, detail: { params: { total: counts!.total } } });
  });

  it("income and expenses by month: the current month has both figures, side by side", async () => {
    const c = (await chart(h.admin, "accounting.income_vs_expenses"))!;
    expect(c).toMatchObject({ kind: "bar", unit: "money" });
    expect(c.series.map((s) => s.label)).toEqual(["home.chart.series.income", "home.chart.series.expenses"]);
    expect(c.series[0]!.points.at(-1)).toEqual({ label: month, value: 5_000_000 });
    expect(c.series[1]!.points.at(-1)).toEqual({ label: month, value: 1_250_000 });
    expect(c.series[0]!.points.length).toBeLessThanOrEqual(6);
  });

  it("result by month is income less expenses", async () => {
    const c = (await chart(h.admin, "accounting.result_trend"))!;
    expect(c.kind).toBe("line");
    expect(c.series[0]!.points.at(-1)).toEqual({ label: month, value: 3_750_000 });
  });

  it("entries by status counts every entry once", async () => {
    const c = (await chart(h.admin, "accounting.entries_by_status"))!;
    const total = (await h.sql<{ n: number }[]>`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n;
    expect(c.i18n).toBe(true);
    expect(c.series[0]!.points.map((p) => p.label)).toHaveLength(7);
    expect(c.series[0]!.points.reduce((sum, p) => sum + p.value, 0)).toBe(total);
    expect(c.series[0]!.points.find((p) => p.label === "home.chart.point.entry_draft")!.value).toBe(1);
  });

  it("top expenses names the accounts with the most expense, largest first", async () => {
    const c = (await chart(h.admin, "accounting.top_expenses"))!;
    expect(c.series[0]!.points[0]).toMatchObject({ value: 1_250_000 });
    expect(c.series[0]!.points[0]!.label).toMatch(/^510506 /);
  });

  it("a role that may not read the statements gets none of their indicators or charts, and the balance sheet ones need their own report", async () => {
    const [role] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, 'revisor', false) returning id`;
    await h.seed.holdRoles(h.seed.users.auxiliar!, h.companyId, [role!.id]);
    await h.grantAll(h.companyId, role!.id, ["kernel.home.kpis", "accounting.entry.consult", "accounting.report.balance_sheet"]);
    const reviewer = { claims: { ...h.seed.claimsFor(h.seed.users.auxiliar!, h.companyId), role_ids: [role!.id] }, origin: "ui" as const };
    const { kpis, charts } = await page(reviewer);
    expect(kpis.map((k) => k.id)).toEqual(expect.arrayContaining(["accounting.working_capital", "accounting.posted_entries", "accounting.draft_entries"]));
    expect(kpis.map((k) => k.id)).not.toContain("accounting.income_month");
    expect(kpis.map((k) => k.id)).not.toContain("accounting.result_month");
    expect(charts.map((c) => c.id)).toEqual(["accounting.entries_by_status"]);
  });

  it("an indicator or chart the admin switched off is not computed", async () => {
    await h.run(h.admin, "kernel.user_prefs.set", { key: "home_hidden", value: { value: ["accounting.income_month", "accounting.top_expenses"], savedAt: 1 } });
    const { kpis, charts, catalog } = await page(h.admin);
    expect(kpis.map((k) => k.id)).not.toContain("accounting.income_month");
    expect(charts.map((c) => c.id)).not.toContain("accounting.top_expenses");
    expect(catalog.map((c) => c.id)).toEqual(expect.arrayContaining(["accounting.income_month", "accounting.top_expenses"]));
    await h.run(h.admin, "kernel.user_prefs.set", { key: "home_hidden", value: { value: [], savedAt: 2 } });
  });

  it("every key the page's cards and charts name exists in both catalogues", async () => {
    const { kpis, charts } = await page(h.admin);
    const keys = [
      ...kpis.flatMap((k) => [k.label, ...(k.detail ? [k.detail.key] : [])]),
      ...charts.flatMap((c) => [c.label, ...c.series.flatMap((s) => [s.label, ...(c.i18n ? s.points.map((p) => p.label) : [])])]),
    ];
    for (const locale of ["es-419", "en"] as const) {
      const tree = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../i18n/messages", `${locale}.json`), "utf8")) as Record<string, unknown>;
      const missing = keys.filter((key) => typeof key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree) !== "string");
      expect(missing, locale).toEqual([]);
    }
  });
});
