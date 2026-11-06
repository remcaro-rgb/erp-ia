import { kpiGridHref, type Chart, type HomeChartProvider, type HomeKpiProvider } from "@erp/kernel";
import { today } from "./processes/common";

// The invoicing module's cards on Inicio (plan 2B Task 26, main design §19a). They read invoicing's published masked views as the caller,
// so the party scope and the field masks decide the numbers: an amount the caller may not read (a masked total or price) is never guessed,
// the card is left out instead. A card the caller's role may not consult is not offered at all (`consult`).

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Por cobrar: what the customers still owe on the issued invoices (total + debit notes − credit notes − what the receipts settled); the
 * detail counts the invoices and those past their due date. Leads to the invoices grid filtered on Emitida.
 */
export const receivableKpi: HomeKpiProvider = {
  id: "invoicing.receivable",
  feature: "invoicing.invoices",
  consult: "invoicing.invoice.consult",
  compute: async (ctx) => {
    const day = await today(ctx);
    const [row] = await ctx.tx<{ n: number; known: number; open: string | null; overdue: number }[]>`
      select count(*)::int as n,
             count(*) filter (where total is not null and paid_amount is not null and credited_amount is not null and debited_amount is not null)::int as known,
             sum(total + debited_amount - credited_amount - paid_amount)::text as open,
             count(*) filter (where due_date < ${day}::date)::int as overdue
      from invoicing.v_invoices where company_id = ${ctx.companyId} and stage = 'issued'`;
    const { n, known, overdue } = row!;
    if (known < n) return [];
    return [{
      id: "invoicing.receivable",
      href: kpiGridHref("/invoicing/invoices", [{ field: "stage", op: "eq", value: "issued" }]),
      label: "home.kpi.invoicing_receivable.label",
      value: cents(Number(row!.open ?? 0)),
      unit: "money",
      ...(overdue > 0 ? { tone: "warn" as const } : {}),
      detail: { key: "home.kpi.invoicing_receivable.detail", params: { count: n, overdue } },
    }];
  },
};

/**
 * Por facturar: what the entregas shipped and no invoice bills yet (the «Por facturar» list), valued at the pedido's price less its
 * discount, before taxes; the detail counts the entregas. Leads to Por facturar.
 */
export const toInvoiceKpi: HomeKpiProvider = {
  id: "invoicing.to_invoice",
  feature: "invoicing.invoices",
  consult: "invoicing.pending_line.list",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ n: number; known: number; amount: string | null; deliveries: number }[]>`
      select count(*)::int as n, count(unit_price)::int as known,
             sum(pending_qty * unit_price * (1 - coalesce(discount_pct, 0) / 100))::text as amount,
             count(distinct delivery_id)::int as deliveries
      from invoicing.v_pending_to_invoice where company_id = ${ctx.companyId}`;
    const { n, known, deliveries } = row!;
    if (known < n) return [];
    return [{
      id: "invoicing.to_invoice",
      href: "/invoicing/pending",
      label: "home.kpi.invoicing_to_invoice.label",
      value: cents(Number(row!.amount ?? 0)),
      unit: "money",
      detail: { key: "home.kpi.invoicing_to_invoice.detail", params: { deliveries } },
    }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [receivableKpi, toInvoiceKpi];

/** Ventas por mes: the subtotal (before taxes) of the invoices issued in each of the last 6 months, annulled ones left out. */
export const salesByMonthChart: HomeChartProvider = {
  id: "invoicing.sales_by_month",
  feature: "invoicing.invoices",
  consult: "invoicing.invoice.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const day = await today(ctx);
    const rows = await ctx.tx<{ month: string; n: number; known: number; amount: string | null }[]>`
      select to_char(issue_date, 'YYYY-MM') as month, count(*)::int as n, count(subtotal)::int as known, sum(subtotal)::text as amount
      from invoicing.v_invoices
      where company_id = ${ctx.companyId} and stage in ('issued', 'paid') and issue_date is not null
        and issue_date > (date_trunc('month', ${day}::date) - interval '6 months')
      group by 1 order by 1`;
    if (rows.length === 0 || rows.some((r) => r.known < r.n)) return [];
    return [{
      id: "invoicing.sales_by_month",
      label: "home.chart.invoicing_sales_by_month.label",
      kind: "bar",
      unit: "money",
      href: "/invoicing/invoices",
      series: [{ label: "home.chart.series.sales", points: rows.map((r) => ({ label: r.month, value: cents(Number(r.amount ?? 0)) })) }],
    }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [salesByMonthChart];
