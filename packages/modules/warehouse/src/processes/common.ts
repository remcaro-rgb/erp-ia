import { ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";

// Helpers every warehouse handler shares: typed refusals, quantities, the company's settings and the date the module was switched on for
// it (RG-10), and the reads of other modules' published views (rule 3: sales.v_pick_order_lines, inventory.v_stock_levels, v_lots,
// v_locations, v_product_tracking, v_reservation_allocations; never their tables).

export const id = z.uuid();
/** A quantity: up to 14 integer and 4 decimal digits (numeric(18,4)), never negative. */
export const quantity = z.number().finite().min(0).refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales");
export const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
export const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** A quantity as people read it: up to four decimals, no trailing zeros. */
export const qtyText = (n: number) => String(round4(n));

/** A refusal of the input whose message leads with its code (`invalid_input`); `details` lists every reason. */
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}
/** Refuses a step the alistamiento's state does not allow: `invalid_state` whose message leads with the code. */
export function refuseState(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_state", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

export interface WarehouseSettings { autoPickOnConfirm: boolean; deliveryFromPick: boolean }
/** The defaults of a company without a settings row (PG §4.2). */
export const DEFAULT_SETTINGS: WarehouseSettings = { autoPickOnConfirm: true, deliveryFromPick: true };

/** The company's Parámetros de bodega, read from the table (the processes decide by them whatever the caller's field visibility). */
export async function settingsOf(ctx: ProcessContext): Promise<WarehouseSettings> {
  const [row] = await ctx.tx<{ auto_pick_on_confirm: boolean; delivery_from_pick: boolean }[]>`
    select auto_pick_on_confirm, delivery_from_pick from warehouse.settings where company_id = ${ctx.companyId}`;
  return row ? { autoPickOnConfirm: row.auto_pick_on_confirm, deliveryFromPick: row.delivery_from_pick } : { ...DEFAULT_SETTINGS };
}

/**
 * When the warehouse module started for the company (RG-10, item 164): the company's switch (kernel.company_modules.enabled_at, while it is
 * on), else the first active purchase of `module:warehouse` by the tenant (kernel.tenant_entitlements.created_at, the company's own or
 * tenant-wide). Null when neither exists (the caller is not entitled anyway).
 */
export async function enabledSince(ctx: ProcessContext): Promise<Date | null> {
  const [row] = await ctx.tx<{ at: Date | null }[]>`
    select coalesce(
      (select m.enabled_at from kernel.company_modules m where m.company_id = ${ctx.companyId} and m.module_id = 'warehouse' and m.enabled),
      (select min(e.created_at) from kernel.tenant_entitlements e
        where e.tenant_id = ${ctx.tenantId} and e.key = 'module:warehouse' and e.enabled and (e.company_id is null or e.company_id = ${ctx.companyId}))
    ) as at`;
  return row?.at ?? null;
}

/** A pedido line as sales publishes it for an alistamiento (sales.v_pick_order_lines, migration 0170). */
export interface OrderLineRow {
  id: string; order_id: string; order_number: string | null; party_id: string; warehouse_id: string | null; order_stage: string; order_status: string;
  confirmed_at: Date | null; line_no: number; product_id: string; qty: string; committed_qty: string;
}

/** The pedido's lines, as the caller may read them (sales' RLS); empty when the pedido does not exist or is not visible. */
export async function orderLines(ctx: ProcessContext, orderId: string): Promise<OrderLineRow[]> {
  return ctx.tx<OrderLineRow[]>`
    select id, order_id, order_number, party_id, warehouse_id, order_stage, order_status, confirmed_at, line_no, product_id, qty::text, committed_qty::text
    from sales.v_pick_order_lines where order_id = ${orderId} order by line_no`;
}

/** The pedido stages sales calls firm (confirmed and on its way): an alistamiento is made only for one of these. */
export const FIRM_ORDER_STAGES: ReadonlySet<string> = new Set(["confirmed", "partially_delivered"]);

/** The company's today (its time zone) as an ISO date. */
export async function companyToday(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ today: string }[]>`select (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today from kernel.companies where id = ${ctx.companyId}`;
  return row!.today;
}

/** How inventory follows a product (inventory.v_product_tracking; none when it has no row). */
export type Tracking = "none" | "lot" | "serial";
export async function trackingOf(ctx: ProcessContext, productIds: string[]): Promise<Map<string, { tracking: Tracking; blockExpired: boolean }>> {
  if (productIds.length === 0) return new Map();
  const rows = await ctx.tx<{ product_id: string; tracking: Tracking | null; block_expired: boolean | null }[]>`
    select product_id, tracking, block_expired from inventory.v_product_tracking where product_id = any(${productIds}::uuid[])`;
  const map = new Map(rows.map((r) => [r.product_id, { tracking: r.tracking ?? "none", blockExpired: r.block_expired ?? true }]));
  for (const p of productIds) if (!map.has(p)) map.set(p, { tracking: "none", blockExpired: true });
  return map;
}

/** A bucket of stock an alistamiento may propose: on hand in a storage ubicación of the bodega, its lot sellable, minus what reservations' allocations already hold. */
export interface Bucket { productId: string; locationId: string; locationCode: string; lotId: string | null; lotCode: string | null; expiresOn: string | null; producedOn: string | null; free: number }

/**
 * The stock of `productIds` in the bodega, per bucket (ubicación, lot), FEFO first (RG-4: expires_on, produced_on, lot code, nulls last;
 * blocked lots and, when the product blocks them, lots expired at `on` left out), then the ubicación with most free stock, then its code.
 * Read through inventory's published views and inventory.lot_sellable (granted: the one rule of RG-4, never copied here); free = on hand −
 * what the allocations of other active reservations already hold of the bucket, less `credit` (the stale part of the pedido's own
 * allocation a re-pick replaces).
 * A serial product's buckets are summed per ubicación and lot: the proposal names where its units are, never which serial (serials are
 * scanned or typed by the picker, never chosen by the system, PG §7 call 5).
 */
/** What a re-pick does not count as held in a bucket: the stale part of the pedido's own allocation (pick.ts propose). */
export interface Credit { productId: string; locationId: string; lotId: string | null; qty: number }

export async function buckets(ctx: ProcessContext, warehouseId: string, productIds: string[], on: string, credit: Credit[] = []): Promise<Bucket[]> {
  if (productIds.length === 0) return [];
  const rows = await ctx.tx<{ product_id: string; location_id: string; location_code: string; lot_id: string | null; lot_code: string | null; expires_on: string | null; produced_on: string | null; free: string }[]>`
    with stock as (
      select s.product_id, s.location_id, s.lot_id, sum(s.on_hand) as on_hand
      from inventory.v_stock_levels s
      where s.warehouse_id = ${warehouseId} and s.product_id = any(${productIds}::uuid[]) and s.on_hand > 0
      group by s.product_id, s.location_id, s.lot_id
    ), held as (
      select a.location_id, a.lot_id, r.product_id, sum(a.qty) as qty
      from inventory.v_reservation_allocations a join inventory.v_reservations r on r.id = a.reservation_id
      where r.warehouse_id = ${warehouseId} and r.status = 'active' and r.product_id = any(${productIds}::uuid[])
      group by a.location_id, a.lot_id, r.product_id
    ), credited as (
      select c.product_id, c.location_id, c.lot_id, sum(c.qty) as qty
      from unnest(${credit.map((c) => c.productId)}::uuid[], ${credit.map((c) => c.locationId)}::uuid[], ${credit.map((c) => c.lotId)}::uuid[],
                  ${credit.map((c) => c.qty)}::numeric[]) as c(product_id, location_id, lot_id, qty)
      group by c.product_id, c.location_id, c.lot_id
    ), held_net as (
      select h.product_id, h.location_id, h.lot_id, greatest(h.qty - coalesce(c.qty, 0), 0) as qty
      from held h left join credited c on c.product_id = h.product_id and c.location_id is not distinct from h.location_id and c.lot_id is not distinct from h.lot_id
    )
    select st.product_id, st.location_id, loc.code as location_code, st.lot_id, l.code as lot_code, l.expires_on::text, l.produced_on::text,
           (st.on_hand - coalesce(h.qty, 0))::text as free
    from stock st
    join inventory.v_locations loc on loc.id = st.location_id and loc.kind = 'storage'
    left join inventory.v_lots l on l.id = st.lot_id
    left join held_net h on h.product_id = st.product_id and h.location_id is not distinct from st.location_id and h.lot_id is not distinct from st.lot_id
    where (st.lot_id is null or (l.id is not null and inventory.lot_sellable(st.lot_id, ${on}::date)))
      and st.on_hand - coalesce(h.qty, 0) > 0
    order by st.product_id, l.expires_on asc nulls last, l.produced_on asc nulls last, l.code asc nulls last,
             st.on_hand - coalesce(h.qty, 0) desc, loc.code asc`;
  return rows.map((r) => ({
    productId: r.product_id, locationId: r.location_id, locationCode: r.location_code, lotId: r.lot_id, lotCode: r.lot_code,
    expiresOn: r.expires_on, producedOn: r.produced_on, free: num(r.free),
  }));
}
