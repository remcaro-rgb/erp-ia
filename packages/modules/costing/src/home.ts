import { kpiGridHref, type HomeKpiProvider } from "@erp/kernel";

// The costing module's card on Inicio (plan 2B Task 26, main design §19a), from its published view as the caller.

/** Costos faltantes: products issued while their bodega had no cost to value them with, still open; warns while there is any. */
export const costMissingKpi: HomeKpiProvider = {
  id: "costing.cost_missing",
  feature: "costing.costs",
  consult: "costing.cost_missing.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ open: number }[]>`
      select count(*)::int as open from costing.v_cost_missing where company_id = ${ctx.companyId} and status = 'open'`;
    const open = row!.open;
    return [{
      id: "costing.cost_missing",
      href: kpiGridHref("/costing/missing", [{ field: "status", op: "eq", value: "open" }]),
      label: "home.kpi.costing_cost_missing.label",
      value: open,
      unit: "count",
      ...(open > 0 ? { tone: "warn" as const } : {}),
      detail: { key: "home.kpi.costing_cost_missing.detail", params: { open } },
    }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [costMissingKpi];
