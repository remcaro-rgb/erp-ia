import { kpiGridHref, ReportState, type HomeKpiProvider, type Kpi } from "@erp/kernel";
import { AWAITING_APPROVAL_STATES, UNFINISHED_ENTRY_STATES } from "./processes/common";
import { incomeStatementConsult } from "./reports/income-statement";

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

export const HOME_KPIS: HomeKpiProvider[] = [resultKpi, pendingKpi, openPeriodsKpi, draftsKpi];
