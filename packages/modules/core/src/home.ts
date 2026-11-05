import { dailyPoints, dailySeries, type Chart, type HomeChartProvider, type HomeKpiProvider, type Kpi } from "@erp/kernel";

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

/** A party counts as a customer or supplier when its (maskable) kind says so; a hidden kind counts nobody. */
const kindCount = (kind: "customer" | "supplier"): HomeKpiProvider["compute"] => async (ctx) => {
  const [row] = await ctx.tx<{ n: number; total: number }[]>`
    select count(*) filter (where ${kind} = any(kind) and coalesce(is_active, true))::int as n, count(*) filter (where coalesce(is_active, true))::int as total from core.v_parties`;
  const { n, total } = row!;
  const key = kind === "customer" ? "core_customers" : "core_suppliers";
  return [{ id: `core.${kind}s`, href: "/parties", label: `home.kpi.${key}.label`, value: n, unit: "count", ...(total > 0 ? { progress: n / total } : {}), detail: { key: `home.kpi.${key}.detail`, params: { total } } }];
};

/** Clientes: active parties marked as customers, out of all the active ones. */
export const customersKpi: HomeKpiProvider = { id: "core.customers", feature: "core.parties", consult: "core.party.consult", compute: kindCount("customer") };

/** Proveedores: active parties marked as suppliers, out of all the active ones. */
export const suppliersKpi: HomeKpiProvider = { id: "core.suppliers", feature: "core.parties", consult: "core.party.consult", compute: kindCount("supplier") };

/** Terceros nuevos del mes: parties created in the current calendar month of the company, against the month before. */
export const newPartiesKpi: HomeKpiProvider = {
  id: "core.new_parties_month",
  feature: "core.parties",
  consult: "core.party.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ current: number; previous: number }[]>`
      with tz as (select timezone as name from kernel.v_companies where id = ${ctx.companyId}),
      m as (select date_trunc('month', now() at time zone tz.name) as this from tz)
      select count(*) filter (where p.created_at at time zone tz.name >= m.this)::int as current,
             count(*) filter (where p.created_at at time zone tz.name >= m.this - interval '1 month' and p.created_at at time zone tz.name < m.this)::int as previous
      from core.v_parties p, tz, m`;
    const { current, previous } = row!;
    const series = await dailySeries(ctx.tx, ctx.companyId, "core.v_parties");
    return [{ id: "core.new_parties_month", href: "/parties", label: "home.kpi.core_new_parties.label", value: current, unit: "count", detail: { key: "home.kpi.core_new_parties.detail", params: { previous } }, series }];
  },
};

/** Productos listos para facturar: the share of products whose DIAN data is complete (invoice ready). */
export const catalogReadyKpi: HomeKpiProvider = {
  id: "core.catalog_ready",
  feature: "core.products",
  consult: "core.product.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; known: number; ready: number }[]>`
      select count(*)::int as total, count(invoice_ready)::int as known, count(*) filter (where invoice_ready)::int as ready from core.v_products where coalesce(is_active, true)`;
    const { total, known, ready } = row!;
    // A hidden readiness reads as null on every row: nothing honest to show.
    if (total === 0 || known < total) return [];
    return [{ id: "core.catalog_ready", href: "/products", label: "home.kpi.core_catalog_ready.label", value: Math.round((ready / total) * 100), unit: "percent", progress: ready / total, ...(ready < total ? { tone: "warn" as const } : {}), detail: { key: "home.kpi.core_catalog_ready.detail", params: { ready, total } } }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [partiesKpi, customersKpi, suppliersKpi, newPartiesKpi, productsKpi, catalogReadyKpi];

/** Terceros por tipo: customers only, suppliers only and both. */
export const partiesByKindChart: HomeChartProvider = {
  id: "core.parties_by_kind",
  feature: "core.parties",
  consult: "core.party.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const [row] = await ctx.tx<{ customers: number; suppliers: number; both: number; other: number }[]>`
      select count(*) filter (where kind @> array['customer'] and not kind @> array['supplier'])::int as customers,
             count(*) filter (where kind @> array['supplier'] and not kind @> array['customer'])::int as suppliers,
             count(*) filter (where kind @> array['customer','supplier'])::int as both,
             count(*) filter (where kind is null or not (kind && array['customer','supplier']))::int as other
      from core.v_parties where coalesce(is_active, true)`;
    const r = row!;
    if (r.customers + r.suppliers + r.both + r.other === 0) return [];
    const points = [
      { label: "home.chart.point.party_customer", value: r.customers },
      { label: "home.chart.point.party_supplier", value: r.suppliers },
      { label: "home.chart.point.party_both", value: r.both },
      ...(r.other > 0 ? [{ label: "home.chart.point.party_other", value: r.other }] : []),
    ];
    return [{ id: "core.parties_by_kind", label: "home.chart.core_parties_by_kind.label", kind: "bar", unit: "count", i18n: true, href: "/parties", series: [{ label: "home.chart.series.parties", points }] }];
  },
};

/** Terceros por tipo de persona: jurídica or natural, as the DIAN codes them. */
export const partiesByPersonChart: HomeChartProvider = {
  id: "core.parties_by_person",
  feature: "core.parties",
  consult: "core.party.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ person_type: string | null; n: number }[]>`select person_type, count(*)::int as n from core.v_parties where coalesce(is_active, true) group by 1`;
    const count = (code: string) => rows.filter((r) => r.person_type === code).reduce((sum, r) => sum + r.n, 0);
    const other = rows.filter((r) => r.person_type !== "1" && r.person_type !== "2").reduce((sum, r) => sum + r.n, 0);
    if (rows.length === 0) return [];
    const points = [
      { label: "home.chart.point.person_legal", value: count("1") },
      { label: "home.chart.point.person_natural", value: count("2") },
      ...(other > 0 ? [{ label: "home.chart.point.person_other", value: other }] : []),
    ];
    return [{ id: "core.parties_by_person", label: "home.chart.core_parties_by_person.label", kind: "bar", unit: "count", i18n: true, href: "/parties", series: [{ label: "home.chart.series.parties", points }] }];
  },
};

/** Terceros nuevos por día: the inflow of the last 14 days. */
export const partiesGrowthChart: HomeChartProvider = {
  id: "core.parties_growth",
  feature: "core.parties",
  consult: "core.party.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const points = await dailyPoints(ctx.tx, ctx.companyId, "core.v_parties");
    return [{ id: "core.parties_growth", label: "home.chart.core_parties_growth.label", kind: "line", unit: "count", href: "/parties", series: [{ label: "home.chart.series.parties", points: points.map((p) => ({ label: p.day.slice(5), value: p.value })) }] }];
  },
};

/** Productos por categoría: the six categories with the most products. */
export const productsByCategoryChart: HomeChartProvider = {
  id: "core.products_by_category",
  feature: "core.products",
  consult: "core.product.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ name: string | null; n: number }[]>`
      select c.name, count(*)::int as n
      from core.v_products p left join core.v_product_categories c on c.id = p.category_id
      where coalesce(p.is_active, true)
      group by c.name order by n desc, c.name nulls last limit 6`;
    if (rows.length === 0) return [];
    return [{ id: "core.products_by_category", label: "home.chart.core_products_by_category.label", kind: "bar", unit: "count", href: "/products", series: [{ label: "home.chart.series.products", points: rows.map((r) => ({ label: r.name ?? "—", value: r.n })) }] }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [partiesByKindChart, partiesByPersonChart, partiesGrowthChart, productsByCategoryChart];
