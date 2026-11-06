import type { Chart, HomeChartProvider, HomeKpiProvider } from "@erp/kernel";
import { FEATURE_RECEIPTS } from "./processes/receipt";

// The payments module's cards on Inicio (plan 2B Task 26, main design §19a), from its published masked view of receipts as the caller; a
// masked amount is never guessed, the card is left out instead.

const cents = (n: number) => Math.round(n * 100) / 100;

/** The company's today (its time zone): the month the card talks about. */
async function companyToday(ctx: Parameters<HomeKpiProvider["compute"]>[0]): Promise<string> {
  const [row] = await ctx.tx<{ today: string }[]>`select (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today from kernel.companies where id = ${ctx.companyId}`;
  return row!.today;
}

/** Recaudo del mes: the money the recibos de caja of the current month brought in (annulled ones left out); the detail counts them. */
export const collectedMonthKpi: HomeKpiProvider = {
  id: "payments.collected_month",
  feature: FEATURE_RECEIPTS,
  consult: "payments.receipt.consult",
  compute: async (ctx) => {
    const day = await companyToday(ctx);
    const [row] = await ctx.tx<{ n: number; known: number; amount: string | null }[]>`
      select count(*)::int as n, count(amount)::int as known, sum(amount)::text as amount
      from payments.v_receipts
      where company_id = ${ctx.companyId} and status <> 'voided' and voided_at is null and number is not null
        and date >= date_trunc('month', ${day}::date) and date <= ${day}::date`;
    const { n, known } = row!;
    if (known < n) return [];
    return [{
      id: "payments.collected_month",
      href: "/payments/receipts",
      label: "home.kpi.payments_collected_month.label",
      value: cents(Number(row!.amount ?? 0)),
      unit: "money",
      detail: { key: "home.kpi.payments_collected_month.detail", params: { count: n, month: day.slice(0, 7) } },
    }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [collectedMonthKpi];

/** Recaudo por mes: the money the recibos de caja brought in during each of the last 6 months. */
export const collectedByMonthChart: HomeChartProvider = {
  id: "payments.collected_by_month",
  feature: FEATURE_RECEIPTS,
  consult: "payments.receipt.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const day = await companyToday(ctx);
    const rows = await ctx.tx<{ month: string; n: number; known: number; amount: string | null }[]>`
      select to_char(date, 'YYYY-MM') as month, count(*)::int as n, count(amount)::int as known, sum(amount)::text as amount
      from payments.v_receipts
      where company_id = ${ctx.companyId} and status <> 'voided' and voided_at is null and number is not null
        and date > (date_trunc('month', ${day}::date) - interval '6 months')
      group by 1 order by 1`;
    if (rows.length === 0 || rows.some((r) => r.known < r.n)) return [];
    return [{
      id: "payments.collected_by_month",
      label: "home.chart.payments_collected_by_month.label",
      kind: "line",
      unit: "money",
      href: "/payments/receipts",
      series: [{ label: "home.chart.series.collected", points: rows.map((r) => ({ label: r.month, value: cents(Number(r.amount ?? 0)) })) }],
    }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [collectedByMonthChart];
