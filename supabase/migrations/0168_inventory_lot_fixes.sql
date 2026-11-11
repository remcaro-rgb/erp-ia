-- 0168_inventory_lot_fixes
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/fefo.integration.test.ts ((6): v_stock's available
-- without blocked and expired lots; (R3): an inactive lot is neither issued by FEFO nor counted by inventory.sale_stock or v_stock).
-- Review fixes of plan 2B.2 Tasks 28.1–28.3 (Part G design PG §3.3, §3.7; RG-4, Review Focus 2):
--   * inventory.lot_sellable(lot, date) also requires the lot maestro to be usable, the rule the movement's save applies
--     (kernel.record_usable: is_active, and status saved, or approved when the lot requires approval). Before, FEFO and the availability
--     counted an inactive lot that the save then refused (maestro_not_usable), so a reservation promised stock the issue could not take.
--     Inlined rather than calling kernel.record_usable: that helper reads the session's company, and this predicate also runs inside
--     inventory.v_stock for every company the caller may read.
--   * inventory.v_stock: `available` counts only the sellable buckets (PG §3.7: blocked lots, inactive lots and, with block_expired,
--     lots expired at the company's today are out of it); `on_hand` still counts every bucket. Same columns, same order and types, same
--     security_invoker option and grant: the readers of other modules are unchanged.

create or replace function inventory.lot_sellable(p_lot uuid, p_on date)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_lot is null or exists (
    select 1 from inventory.lots l
    left join inventory.product_tracking t on t.company_id = l.company_id and t.product_id = l.product_id
    where l.id = p_lot and l.deleted_at is null and l.lot_status = 'active'
      and l.is_active and l.status = case when l.requires_approval then 'approved' else 'saved' end
      and not (coalesce(t.block_expired, true) and l.expires_on is not null and l.expires_on < p_on));
$$;
comment on function inventory.lot_sellable(uuid, date) is
  'A bucket''s lot may be sold on the date: no lot, or an active lot whose maestro is usable (active; saved, or approved when it requires approval), not deleted and not expired before the date when its product blocks expired lots (RG-4, 0168).';

create or replace view inventory.v_stock with (security_invoker = true) as
with buckets as (
  select s.company_id, s.product_id, s.warehouse_id, s.location_id, s.on_hand, 0::numeric as reserved,
         case when s.lot_id is null
                or inventory.lot_sellable(s.lot_id, (now() at time zone coalesce(c.timezone, 'America/Bogota'))::date)
              then s.on_hand else 0::numeric end as sellable
  from inventory.stock_levels s
  left join kernel.companies c on c.id = s.company_id
  union all
  select r.company_id, r.product_id, r.warehouse_id, r.location_id, 0::numeric, r.qty - r.released_qty, 0::numeric
  from inventory.reservations r
  where r.status = 'active'
)
select
  b.company_id,
  b.product_id,
  b.warehouse_id,
  b.location_id,
  sum(b.on_hand)::numeric(18,4) as on_hand,
  sum(b.reserved)::numeric(18,4) as reserved,
  (sum(b.sellable) - sum(b.reserved))::numeric(18,4) as available,
  l.kind as location_kind
from buckets b
left join inventory.locations l on l.id = b.location_id
group by b.company_id, b.product_id, b.warehouse_id, b.location_id, l.kind;
grant select on inventory.v_stock to authenticated;

comment on view inventory.v_stock is
  'Published stock per product, bodega and ubicación (rule 3): on_hand, reserved, available. Reservations sit at the bodega level '
  '(location_id null) until picking (2B.2), so the availability of a bodega is the SUM over all its rows (Task 13 reads it that way, '
  'never one ubicación row). available counts only sellable buckets (inventory.lot_sellable at the company''s today: no blocked, inactive '
  'or, with block_expired, expired lot; PG §3.7, 0168); on_hand counts them all. on_hand here is not masked: a screen (Task 10) reads the '
  'masked inventory.v_stock_levels for what a role sees.';
