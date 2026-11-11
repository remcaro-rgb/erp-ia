import type { HomeKpiProvider } from "@erp/kernel";

// The inventory module's card on Inicio (plan 2B Task 26, main design §19a), read from the published masked views as the caller: core's
// products (their minimum stock, core.v_products) and inventory's on-hand (inventory.v_stock_levels, the masked view of the stock levels;
// final review I-2: never the unmasked inventory.v_stock). A minimum the caller may not read counts nobody; an on-hand (or the product it
// belongs to) the caller may not read is never guessed as zero: the card is left out.

/**
 * Stock bajo mínimo: active products that track stock and have a minimum (Stock mínimo on the product) whose on-hand, across every
 * bodega, is below it. Out of every product with a minimum. Leads to Existencias.
 */
export const belowMinimumKpi: HomeKpiProvider = {
  id: "inventory.below_minimum",
  feature: "inventory.stock",
  consult: "inventory.stock_level.consult",
  compute: async (ctx) => {
    const [mode] = await ctx.tx<{ visible: boolean }[]>`
      select kernel.field_visible('inventory.stock_level', 'on_hand') and kernel.field_visible('inventory.stock_level', 'product_id') as visible`;
    if (!mode?.visible) return [];
    const [row] = await ctx.tx<{ below: number; tracked: number }[]>`
      with stock as (select product_id, sum(on_hand) as on_hand from inventory.v_stock_levels where company_id = ${ctx.companyId} group by product_id)
      select count(*) filter (where coalesce(s.on_hand, 0) < p.min_stock)::int as below, count(*)::int as tracked
      from core.v_products p left join stock s on s.product_id = p.id
      where p.company_id = ${ctx.companyId} and p.track_stock and p.min_stock is not null and p.min_stock > 0 and coalesce(p.is_active, true)`;
    const { below, tracked } = row!;
    if (tracked === 0) return [];
    return [{
      id: "inventory.below_minimum",
      href: "/inventory/stock",
      label: "home.kpi.inventory_below_minimum.label",
      value: below,
      unit: "count",
      progress: below / tracked,
      ...(below > 0 ? { tone: "warn" as const } : {}),
      detail: { key: "home.kpi.inventory_below_minimum.detail", params: { tracked } },
    }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [belowMinimumKpi];
