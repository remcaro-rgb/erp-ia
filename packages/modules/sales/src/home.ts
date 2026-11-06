import { kpiGridHref, type Chart, type HomeChartProvider, type HomeKpiProvider } from "@erp/kernel";

// The sales module's cards on Inicio (plan 2B Task 26, main design §19a): read from sales' published masked views as the caller, so the
// party scope and the field masks decide them; an amount the caller may not read is left out, never guessed.

const cents = (n: number) => Math.round(n * 100) / 100;

/** Stages of a pedido still on its way (written or confirmed, not wholly delivered nor cancelled). */
export const OPEN_ORDER_STAGES = ["open", "confirmed", "partially_delivered"] as const;
const ORDER_STAGES = ["open", "confirmed", "partially_delivered", "delivered", "cancelled"] as const;

/** Pedidos abiertos: pedidos not yet wholly delivered nor cancelled; the detail counts the confirmed ones and their total when visible. */
export const openOrdersKpi: HomeKpiProvider = {
  id: "sales.open_orders",
  feature: "sales.orders",
  consult: "sales.order.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ n: number; confirmed: number }[]>`
      select count(*)::int as n, count(*) filter (where stage in ('confirmed', 'partially_delivered'))::int as confirmed
      from sales.v_orders where company_id = ${ctx.companyId} and status <> 'voided' and stage = any(${[...OPEN_ORDER_STAGES]}::text[])`;
    const { n, confirmed } = row!;
    return [{
      id: "sales.open_orders",
      href: kpiGridHref("/sales/orders", [{ field: "stage", op: "in", value: [...OPEN_ORDER_STAGES] }]),
      label: "home.kpi.sales_open_orders.label",
      value: n,
      unit: "count",
      detail: { key: "home.kpi.sales_open_orders.detail", params: { confirmed } },
    }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [openOrdersKpi];

/** Pedidos por estado: how many pedidos are in each stage, from Abierto to Cancelado (annulled ones left out). */
export const ordersByStageChart: HomeChartProvider = {
  id: "sales.orders_by_stage",
  feature: "sales.orders",
  consult: "sales.order.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ stage: string; n: number }[]>`
      select stage, count(*)::int as n from sales.v_orders where company_id = ${ctx.companyId} and status <> 'voided' group by 1`;
    if (rows.length === 0) return [];
    const counts = new Map(rows.map((r) => [r.stage, r.n]));
    return [{
      id: "sales.orders_by_stage",
      label: "home.chart.sales_orders_by_stage.label",
      kind: "bar",
      unit: "count",
      i18n: true,
      href: "/sales/orders",
      series: [{ label: "home.chart.series.orders", points: ORDER_STAGES.map((stage) => ({ label: `home.chart.point.order_${stage}`, value: counts.get(stage) ?? 0 })) }],
    }];
  },
};

/** Pedidos confirmados por mes: the total of the pedidos confirmed in each of the last 6 months (when the caller may read the totals). */
export const ordersByMonthChart: HomeChartProvider = {
  id: "sales.orders_by_month",
  feature: "sales.orders",
  consult: "sales.order.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ month: string; n: number; known: number; amount: string | null }[]>`
      select to_char(issue_date, 'YYYY-MM') as month, count(*)::int as n, count(subtotal)::int as known, sum(subtotal)::text as amount
      from sales.v_orders
      where company_id = ${ctx.companyId} and status <> 'voided' and stage <> 'cancelled' and confirmed_at is not null
        and issue_date > (date_trunc('month', current_date) - interval '6 months')
      group by 1 order by 1`;
    if (rows.length === 0 || rows.some((r) => r.known < r.n)) return [];
    return [{
      id: "sales.orders_by_month",
      label: "home.chart.sales_orders_by_month.label",
      kind: "bar",
      unit: "money",
      href: "/sales/orders",
      series: [{ label: "home.chart.series.orders", points: rows.map((r) => ({ label: r.month, value: cents(Number(r.amount ?? 0)) })) }],
    }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [ordersByStageChart, ordersByMonthChart];
