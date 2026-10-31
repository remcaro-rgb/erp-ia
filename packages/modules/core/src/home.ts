import { dailySeries, type HomeKpiProvider, type Kpi } from "@erp/kernel";

// The core module's cards on the home screen (design §19a). Both count through the published masked views as the caller,
// so the party scope (rule 13) and the field masks (rule 14) decide the numbers; a value the caller may not read is never
// guessed: the card falls back to what is still true (everything visible) and says so in its label.

/** Parties: how many are active, and among them how many cannot be invoiced yet (DIAN data or files missing). */
export const partiesKpi: HomeKpiProvider = {
  id: "core.parties",
  feature: "core.parties",
  consult: "core.party.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; known_active: number; active: number; known_ready: number; not_ready: number }[]>`
      select count(*)::int as total,
             count(is_active)::int as known_active,
             count(*) filter (where is_active)::int as active,
             count(invoice_ready)::int as known_ready,
             count(*) filter (where is_active and not invoice_ready)::int as not_ready
      from core.v_parties`;
    const { total, known_active: knownActive, active, known_ready: knownReady, not_ready } = row!;
    // New parties per day: the same masked view, so the caller's party scope shapes the trend as it does the number.
    const series = await dailySeries(ctx.tx, ctx.companyId, "core.v_parties");
    // `is_active` hidden or masked reads as null on every row: then the card counts every party it can see.
    const activeVisible = total === 0 || knownActive === total;
    const readyVisible = total === 0 || knownReady === total;
    const kpi: Kpi = {
      id: "core.parties",
      href: "/parties", label: activeVisible ? "home.kpi.core_parties.label" : "home.kpi.core_parties.label_total",
      value: activeVisible ? active : total,
      unit: "count",
      ...(activeVisible && total > 0 ? { progress: active / total } : {}),
      detail: readyVisible ? { key: "home.kpi.core_parties.detail", params: { total, not_ready } } : { key: "home.kpi.core_parties.detail_total", params: { total } },
      series,
    };
    return [kpi];
  },
};

/** Products: how many there are and how many are not invoice ready. */
export const productsKpi: HomeKpiProvider = {
  id: "core.products",
  feature: "core.products",
  consult: "core.product.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; known_ready: number; not_ready: number }[]>`
      select count(*)::int as total, count(invoice_ready)::int as known_ready, count(*) filter (where not invoice_ready)::int as not_ready
      from core.v_products`;
    const { total, known_ready: knownReady, not_ready } = row!;
    const series = await dailySeries(ctx.tx, ctx.companyId, "core.v_products");
    return [
      {
        id: "core.products",
        href: "/products", label: "home.kpi.core_products.label",
        value: total,
        unit: "count",
        ...(total === 0 || knownReady === total ? { detail: { key: "home.kpi.core_products.detail", params: { not_ready } } } : {}),
        series,
      },
    ];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [partiesKpi, productsKpi];
