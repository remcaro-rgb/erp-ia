import type { HomeKpiProvider } from "@erp/kernel";

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
    return [
      {
        id: "support.tickets",
        label: "home.kpi.support_tickets.label",
        value: open,
        unit: "count",
        ...(open > 0 ? { tone: "warn" as const } : {}),
        detail: { key: "home.kpi.support_tickets.detail", params: { total } },
      },
    ];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [ticketsKpi];
