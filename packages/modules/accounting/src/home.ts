import { kpiGridHref, ReportState, type Chart, type HomeChartProvider, type HomeKpiProvider, type Kpi } from "@erp/kernel";
import { AWAITING_APPROVAL_STATES, companyPack, UNFINISHED_ENTRY_STATES } from "./processes/common";
import { incomeStatementConsult, INCOME_SECTIONS } from "./reports/income-statement";

// The accounting module's cards on the home screen (accounting design §8, main design §19a). All of them read the published masked
// views as the caller, so the account security (§5.13) and the field masks decide the numbers. A card the caller's role may not
// consult is not shown at all (`consult`), and a company that has not run Configurar contabilidad shows none (no periods yet).

const cents = (n: number) => Math.round(n * 100) / 100;

interface PeriodRow {
  id: string;
  starts_on: string;
  status: string;
  today: boolean;
}

/** The period the month cards talk about: the one holding today, else the latest. Null while the company has no fiscal year. */
async function currentPeriod(ctx: Parameters<HomeKpiProvider["compute"]>[0]): Promise<PeriodRow | null> {
  const [row] = await ctx.tx<PeriodRow[]>`
    select id, starts_on::text, status, (current_date between starts_on and ends_on) as today
    from accounting.v_periods where company_id = ${ctx.companyId}
    order by (current_date between starts_on and ends_on) desc, starts_on desc limit 1`;
  return row ?? null;
}

/** Resultado del mes: the net result of the estado de resultados for the current period, taken from the report's own consult. */
export const resultKpi: HomeKpiProvider = {
  id: "accounting.result_month",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const params = { from: period.id, to: period.id, byCostCenter: false, comparePrevious: false, level: 4 };
    const report = await incomeStatementConsult.handler(ctx, { params, state: ReportState.parse({ filters: [], sort: [], page: 1, pageSize: 1 }) } as never);
    const result = Number((report as { aggregates?: { result?: number } }).aggregates?.result ?? 0);
    return [{ id: "accounting.result_month", href: "/accounting/reports/income_statement", label: "home.kpi.accounting_result.label", value: cents(result), unit: "money", detail: { key: "home.kpi.accounting_result.detail", params: { month: period.starts_on.slice(0, 7) } } }];
  },
};

/** Pendientes de contabilizar: events no rule could post yet. Warns while there is any. */
export const pendingKpi: HomeKpiProvider = {
  id: "accounting.pending_failures",
  feature: "accounting.posting",
  consult: "accounting.posting_failure.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ pending: number }[]>`select count(*)::int as pending from accounting.v_posting_failures where status = 'pending'`;
    const pending = row!.pending;
    const kpi: Kpi = { id: "accounting.pending_failures", href: "/accounting/posting", label: "home.kpi.accounting_pending.label", value: pending, unit: "count", ...(pending > 0 ? { tone: "warn" as const } : {}), detail: { key: "home.kpi.accounting_pending.detail", params: { pending } } };
    return [kpi];
  },
};

/** Períodos abiertos, out of all the periods of the company. */
export const openPeriodsKpi: HomeKpiProvider = {
  id: "accounting.open_periods",
  feature: "accounting.periods",
  consult: "accounting.period.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; open: number }[]>`
      select count(*)::int as total, count(*) filter (where status = 'open')::int as open from accounting.v_periods where company_id = ${ctx.companyId}`;
    const { total, open } = row!;
    if (total === 0) return [];
    return [{ id: "accounting.open_periods", href: kpiGridHref("/accounting/periods", [{ field: "status", op: "eq", value: "open" }]), label: "home.kpi.accounting_periods.label", value: open, unit: "count", progress: open / total, detail: { key: "home.kpi.accounting_periods.detail", params: { total } } }];
  },
};

/**
 * Comprobantes en borrador: entries written and not yet sent or posted. The same states the period close counts as unfinished
 * (Borrador, Grabado, No Aprobado: UNFINISHED_ENTRY_STATES), so home and Cerrar período never disagree; the detail counts those
 * waiting on an approver (AWAITING_APPROVAL_STATES).
 */
export const draftsKpi: HomeKpiProvider = {
  id: "accounting.draft_entries",
  feature: "accounting.ledger",
  consult: "accounting.entry.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ drafts: number; pending: number }[]>`
      select count(*) filter (where status = any(${[...UNFINISHED_ENTRY_STATES]}::text[]))::int as drafts,
             count(*) filter (where status = any(${[...AWAITING_APPROVAL_STATES]}::text[]))::int as pending
      from accounting.v_entries where company_id = ${ctx.companyId}`;
    return [{ id: "accounting.draft_entries", href: kpiGridHref("/accounting/entries", [{ field: "status", op: "in", value: [...UNFINISHED_ENTRY_STATES] }]), label: "home.kpi.accounting_drafts.label", value: row!.drafts, unit: "count", detail: { key: "home.kpi.accounting_drafts.detail", params: { pending: row!.pending } } }];
  },
};

type Ctx = Parameters<HomeKpiProvider["compute"]>[0];

/** Income and expense of the statement layout's sections, from the masked balances (opening and year-close entries left out), for the `months` periods ending at the current one. */
async function monthlyFigures(ctx: Ctx, period: PeriodRow, months: number): Promise<{ month: string; income: number; expenses: number }[]> {
  const sections = (await companyPack(ctx)).statementLayouts().incomeStatement.map((s) => s.code);
  const income = sections.filter((code) => INCOME_SECTIONS.has(code));
  const rows = await ctx.tx<{ month: string; section: string; debit: string; credit: string }[]>`
    select to_char(p.starts_on, 'YYYY-MM') as month, b.statement_section as section, coalesce(sum(b.debit), 0)::text as debit, coalesce(sum(b.credit), 0)::text as credit
    from accounting.v_account_balances b join accounting.v_periods p on p.id = b.period_id
    where b.company_id = ${ctx.companyId} and not coalesce(b.is_opening, false) and not coalesce(b.is_closing, false)
      and b.statement_section = any(${sections}::text[])
      and p.starts_on <= ${period.starts_on}::date and p.starts_on > (${period.starts_on}::date - make_interval(months => ${months}))
    group by 1, 2`;
  const byMonth = new Map<string, { income: number; expenses: number }>();
  for (const row of rows) {
    const figure = byMonth.get(row.month) ?? { income: 0, expenses: 0 };
    if (income.includes(row.section)) figure.income += Number(row.credit) - Number(row.debit);
    else figure.expenses += Number(row.debit) - Number(row.credit);
    byMonth.set(row.month, figure);
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, figure]) => ({ month, income: cents(figure.income), expenses: cents(figure.expenses) }));
}

/** Ingresos del mes: the credit side of the income sections in the current period. */
export const incomeKpi: HomeKpiProvider = {
  id: "accounting.income_month",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const [figure] = (await monthlyFigures(ctx, period, 1)).filter((f) => f.month === period.starts_on.slice(0, 7));
    return [{ id: "accounting.income_month", href: "/accounting/reports/income_statement", label: "home.kpi.accounting_income.label", value: figure?.income ?? 0, unit: "money", detail: { key: "home.kpi.accounting_income.detail", params: { month: period.starts_on.slice(0, 7) } } }];
  },
};

/** Gastos y costos del mes: cost of sales, expenses and income tax of the current period. */
export const expensesKpi: HomeKpiProvider = {
  id: "accounting.expenses_month",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const [figure] = (await monthlyFigures(ctx, period, 1)).filter((f) => f.month === period.starts_on.slice(0, 7));
    return [{ id: "accounting.expenses_month", href: "/accounting/reports/income_statement", label: "home.kpi.accounting_expenses.label", value: figure?.expenses ?? 0, unit: "money", detail: { key: "home.kpi.accounting_expenses.detail", params: { month: period.starts_on.slice(0, 7) } } }];
  },
};

/** Margen del mes: the month's result over its income, as a percentage. Nothing to show while the month has no income. */
export const marginKpi: HomeKpiProvider = {
  id: "accounting.margin_month",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const [figure] = (await monthlyFigures(ctx, period, 1)).filter((f) => f.month === period.starts_on.slice(0, 7));
    if (!figure || figure.income <= 0) return [];
    const margin = (figure.income - figure.expenses) / figure.income;
    return [{ id: "accounting.margin_month", href: "/accounting/reports/income_statement", label: "home.kpi.accounting_margin.label", value: Math.round(margin * 1000) / 10, unit: "percent", ...(margin < 0 ? { tone: "warn" as const } : {}), detail: { key: "home.kpi.accounting_margin.detail", params: { month: period.starts_on.slice(0, 7) } } }];
  },
};

const ASSETS_CURRENT = "assets_current";
const LIABILITIES_CURRENT = "liabilities_current";

/** Current assets and current liabilities accumulated up to the end of the current period (opening balances included, year-close entries left out). */
async function liquidity(ctx: Ctx, period: PeriodRow): Promise<{ assets: number; liabilities: number }> {
  const [row] = await ctx.tx<{ assets: string; liabilities: string }[]>`
    select coalesce(sum(b.debit - b.credit) filter (where b.statement_section = ${ASSETS_CURRENT}), 0)::text as assets,
           coalesce(sum(b.credit - b.debit) filter (where b.statement_section = ${LIABILITIES_CURRENT}), 0)::text as liabilities
    from accounting.v_account_balances b join accounting.v_periods p on p.id = b.period_id
    where b.company_id = ${ctx.companyId} and not coalesce(b.is_closing, false)
      and b.statement_section in (${ASSETS_CURRENT}, ${LIABILITIES_CURRENT})
      and p.ends_on <= (select ends_on from accounting.v_periods where id = ${period.id})`;
  return { assets: cents(Number(row!.assets)), liabilities: cents(Number(row!.liabilities)) };
}

/** Capital de trabajo: current assets minus current liabilities. */
export const workingCapitalKpi: HomeKpiProvider = {
  id: "accounting.working_capital",
  feature: "accounting.ledger",
  consult: "accounting.report.balance_sheet",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const { assets, liabilities } = await liquidity(ctx, period);
    return [{ id: "accounting.working_capital", href: "/accounting/reports/balance_sheet", label: "home.kpi.accounting_working_capital.label", value: cents(assets - liabilities), unit: "money", ...(assets < liabilities ? { tone: "warn" as const } : {}), detail: { key: "home.kpi.accounting_working_capital.detail", params: {} } }];
  },
};

/** Razón corriente: current assets over current liabilities; below 1 the company cannot cover what it owes in the short term. */
export const currentRatioKpi: HomeKpiProvider = {
  id: "accounting.current_ratio",
  feature: "accounting.ledger",
  consult: "accounting.report.balance_sheet",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const { assets, liabilities } = await liquidity(ctx, period);
    if (liabilities <= 0) return [];
    const ratio = assets / liabilities;
    return [{ id: "accounting.current_ratio", href: "/accounting/reports/balance_sheet", label: "home.kpi.accounting_current_ratio.label", value: Math.round(ratio * 100) / 100, unit: "ratio", ...(ratio < 1 ? { tone: "warn" as const } : {}), detail: { key: "home.kpi.accounting_current_ratio.detail", params: {} } }];
  },
};

/** Comprobantes contabilizados: entries posted with a date in the current period, out of the period's entries that are not drafts. */
export const postedKpi: HomeKpiProvider = {
  id: "accounting.posted_entries",
  feature: "accounting.ledger",
  consult: "accounting.entry.consult",
  compute: async (ctx) => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const [row] = await ctx.tx<{ posted: number; total: number }[]>`
      select count(*) filter (where status = 'posted')::int as posted, count(*)::int as total
      from accounting.v_entries where company_id = ${ctx.companyId} and period_id = ${period.id}`;
    const { posted, total } = row!;
    return [{ id: "accounting.posted_entries", href: kpiGridHref("/accounting/entries", [{ field: "status", op: "eq", value: "posted" }]), label: "home.kpi.accounting_posted.label", value: posted, unit: "count", ...(total > 0 ? { progress: posted / total } : {}), detail: { key: "home.kpi.accounting_posted.detail", params: { total } } }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [resultKpi, incomeKpi, expensesKpi, marginKpi, workingCapitalKpi, currentRatioKpi, postedKpi, pendingKpi, openPeriodsKpi, draftsKpi];

/** Ingresos y gastos de los últimos 6 meses, side by side. */
export const incomeVsExpensesChart: HomeChartProvider = {
  id: "accounting.income_vs_expenses",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx): Promise<Chart[]> => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const figures = await monthlyFigures(ctx, period, 6);
    if (figures.length === 0) return [];
    return [
      {
        id: "accounting.income_vs_expenses",
        label: "home.chart.accounting_income_vs_expenses.label",
        kind: "bar",
        unit: "money",
        href: "/accounting/reports/income_statement",
        series: [
          { label: "home.chart.series.income", points: figures.map((f) => ({ label: f.month, value: f.income })) },
          { label: "home.chart.series.expenses", points: figures.map((f) => ({ label: f.month, value: f.expenses })) },
        ],
      },
    ];
  },
};

/** Resultado por mes: the net result of each of the last 6 months, as a trend. */
export const resultTrendChart: HomeChartProvider = {
  id: "accounting.result_trend",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx): Promise<Chart[]> => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const figures = await monthlyFigures(ctx, period, 6);
    if (figures.length === 0) return [];
    return [{ id: "accounting.result_trend", label: "home.chart.accounting_result_trend.label", kind: "line", unit: "money", href: "/accounting/reports/income_statement", series: [{ label: "home.chart.series.result", points: figures.map((f) => ({ label: f.month, value: cents(f.income - f.expenses) })) }] }];
  },
};

const ENTRY_STATES = ["draft", "saved", "rejected", "pending", "approved", "posted", "voided"] as const;

/** Comprobantes por estado: where the company's entries stand in their life (borrador to contabilizado). */
export const entriesByStatusChart: HomeChartProvider = {
  id: "accounting.entries_by_status",
  feature: "accounting.ledger",
  consult: "accounting.entry.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ status: string; n: number }[]>`select status, count(*)::int as n from accounting.v_entries where company_id = ${ctx.companyId} group by 1`;
    const counts = new Map(rows.map((r) => [r.status, r.n]));
    if (rows.length === 0) return [];
    return [
      {
        id: "accounting.entries_by_status",
        label: "home.chart.accounting_entries_by_status.label",
        kind: "bar",
        unit: "count",
        i18n: true,
        href: "/accounting/entries",
        series: [{ label: "home.chart.series.entries", points: ENTRY_STATES.map((state) => ({ label: `home.chart.point.entry_${state}`, value: counts.get(state) ?? 0 })) }],
      },
    ];
  },
};

/** Principales gastos del mes: the five accounts with the most expense in the current period. */
export const topExpensesChart: HomeChartProvider = {
  id: "accounting.top_expenses",
  feature: "accounting.ledger",
  consult: "accounting.report.income_statement",
  compute: async (ctx): Promise<Chart[]> => {
    const period = await currentPeriod(ctx);
    if (!period) return [];
    const sections = (await companyPack(ctx)).statementLayouts().incomeStatement.map((s) => s.code).filter((code) => !INCOME_SECTIONS.has(code));
    const rows = await ctx.tx<{ name: string; amount: string }[]>`
      select a.code || ' ' || a.name as name, sum(b.debit - b.credit)::text as amount
      from accounting.v_account_balances b join accounting.v_accounts a on a.id = b.account_id
      where b.company_id = ${ctx.companyId} and b.period_id = ${period.id} and not coalesce(b.is_opening, false) and not coalesce(b.is_closing, false)
        and b.statement_section = any(${sections}::text[]) and a.name is not null
      group by a.code, a.name having sum(b.debit - b.credit) > 0
      order by sum(b.debit - b.credit) desc limit 5`;
    if (rows.length === 0) return [];
    return [{ id: "accounting.top_expenses", label: "home.chart.accounting_top_expenses.label", kind: "bar", unit: "money", href: "/accounting/reports/income_statement", series: [{ label: "home.chart.series.expenses", points: rows.map((r) => ({ label: r.name, value: cents(Number(r.amount)) })) }] }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [incomeVsExpensesChart, resultTrendChart, entriesByStatusChart, topExpensesChart];
