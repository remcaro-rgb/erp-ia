import { dailySeries, type Chart, type HomeChartProvider, type HomeKpiProvider } from "@erp/kernel";

// The support module's card on the home screen (design §19a): tickets that are not closed, through support.v_tickets as the
// caller, so a reporter counts their own tickets and an agent every ticket of the company (the ownership policy of 0017).

export const ticketsKpi: HomeKpiProvider = {
  id: "support.tickets",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; open: number }[]>`
      select count(*)::int as total, count(*) filter (where status <> 'closed')::int as open from support.v_tickets`;
    const { total, open } = row!;
    // New tickets per day (closed ones too: the trend is the inflow), through the same view.
    const series = await dailySeries(ctx.tx, ctx.companyId, "support.v_tickets");
    return [
      {
        id: "support.tickets",
        href: "/support", label: "home.kpi.support_tickets.label",
        value: open,
        unit: "count",
        ...(open > 0 ? { tone: "warn" as const } : {}),
        detail: { key: "home.kpi.support_tickets.detail", params: { total } },
        series,
      },
    ];
  },
};

/** Tickets de prioridad alta that are still open. */
export const urgentKpi: HomeKpiProvider = {
  id: "support.urgent",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ urgent: number; open: number }[]>`
      select count(*) filter (where priority = 'high' and status <> 'closed')::int as urgent, count(*) filter (where status <> 'closed')::int as open from support.v_tickets`;
    const { urgent, open } = row!;
    return [{ id: "support.urgent", href: "/support", label: "home.kpi.support_urgent.label", value: urgent, unit: "count", ...(urgent > 0 ? { tone: "warn" as const } : {}), ...(open > 0 ? { progress: urgent / open } : {}), detail: { key: "home.kpi.support_urgent.detail", params: { open } } }];
  },
};

/** Tickets sin resolver desde hace más de 7 días: the backlog that is going stale. */
export const staleKpi: HomeKpiProvider = {
  id: "support.stale",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ stale: number }[]>`select count(*) filter (where status <> 'closed' and created_at < now() - interval '7 days')::int as stale from support.v_tickets`;
    return [{ id: "support.stale", href: "/support", label: "home.kpi.support_stale.label", value: row!.stale, unit: "count", ...(row!.stale > 0 ? { tone: "warn" as const } : {}), detail: { key: "home.kpi.support_stale.detail", params: {} } }];
  },
};

/** Tickets cerrados en los últimos 30 días, with the average days a closed ticket took from report to its last change. */
export const resolvedKpi: HomeKpiProvider = {
  id: "support.resolved_30d",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ resolved: number; days: string | null }[]>`
      select count(*)::int as resolved, round(avg(extract(epoch from (updated_at - created_at)) / 86400)::numeric, 1)::text as days
      from support.v_tickets where status = 'closed' and updated_at >= now() - interval '30 days'`;
    const { resolved, days } = row!;
    return [{ id: "support.resolved_30d", href: "/support", label: "home.kpi.support_resolved.label", value: resolved, unit: "count", detail: { key: resolved > 0 ? "home.kpi.support_resolved.detail" : "home.kpi.support_resolved.detail_none", params: { days: Number(days ?? 0) } } }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [ticketsKpi, urgentKpi, staleKpi, resolvedKpi];

/** Tickets por estado: open, answered and closed. */
export const ticketsByStatusChart: HomeChartProvider = {
  id: "support.tickets_by_status",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ status: string; n: number }[]>`select status, count(*)::int as n from support.v_tickets group by 1`;
    if (rows.length === 0) return [];
    const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
    return [{ id: "support.tickets_by_status", label: "home.chart.support_tickets_by_status.label", kind: "bar", unit: "count", i18n: true, href: "/support", series: [{ label: "home.chart.series.tickets", points: ["open", "answered", "closed"].map((s) => ({ label: `home.chart.point.ticket_${s}`, value: count(s) })) }] }];
  },
};

/** Tickets abiertos por prioridad. */
export const ticketsByPriorityChart: HomeChartProvider = {
  id: "support.tickets_by_priority",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ priority: string; n: number }[]>`select priority, count(*)::int as n from support.v_tickets where status <> 'closed' group by 1`;
    const count = (priority: string) => rows.find((r) => r.priority === priority)?.n ?? 0;
    return [{ id: "support.tickets_by_priority", label: "home.chart.support_tickets_by_priority.label", kind: "bar", unit: "count", i18n: true, href: "/support", series: [{ label: "home.chart.series.tickets", points: ["high", "normal", "low"].map((p) => ({ label: `home.chart.point.priority_${p}`, value: count(p) })) }] }];
  },
};

/** Tickets recibidos por semana, the last 8 weeks. */
export const ticketsInflowChart: HomeChartProvider = {
  id: "support.tickets_inflow",
  feature: "support.tickets",
  consult: "support.ticket.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ week: string; n: number }[]>`
      with tz as (select timezone as name, (now() at time zone timezone)::date as today from kernel.v_companies where id = ${ctx.companyId}),
      weeks as (select (date_trunc('week', tz.today::timestamp) - make_interval(weeks => w))::date as week from tz, generate_series(0, 7) as w)
      select to_char(weeks.week, 'MM-DD') as week, count(t.id)::int as n
      from weeks cross join tz
      left join support.v_tickets t on (t.created_at at time zone tz.name)::date >= weeks.week and (t.created_at at time zone tz.name)::date < weeks.week + 7
      group by weeks.week order by weeks.week`;
    return [{ id: "support.tickets_inflow", label: "home.chart.support_tickets_inflow.label", kind: "line", unit: "count", href: "/support", series: [{ label: "home.chart.series.tickets", points: rows.map((r) => ({ label: r.week, value: r.n })) }] }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [ticketsByStatusChart, ticketsByPriorityChart, ticketsInflowChart];
