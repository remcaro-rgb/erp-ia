-- 0164_inventory_sale_stock_lots
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/fefo.integration.test.ts (FEFO issue, sale stock,
-- reservation availability, returns by lot) and packages/modules/sales/src/__tests__/delivery-lots.integration.test.ts (a lot product
-- confirmed, reserved and shipped through sales). Plan 2B.2 Task 28.3 (Part G design PG §3.3, §3.7; RG-4, Review Focus 1 and 2):
--   * inventory.lot_sellable(lot, date): whether a bucket's lot may be sold on that date: no lot (untracked, or a serial bucket), or a lot
--     that is not deleted, not blocked and, when its product blocks expired lots (block_expired, default true), not expired before the
--     date. The one predicate FEFO, inventory.sale_stock and the reservation availability share, so a reservation never promises stock
--     FEFO later cannot issue (RG-4).
--   * inventory.sale_stock gains the date (default the company's today) and counts every sellable bucket: the untracked ones as before,
--     the lot buckets per lot_sellable, the serial buckets on hand. A lot or serial product's line may be split over buckets at the issue
--     (FEFO, or one serial per bucket), so its `max_bucket` is its whole sellable stock; an untracked product keeps the largest bucket
--     (each line leaves from one bucket, as before: RG-2).
--   * inventory.source_line_stock reads each movement line's own bucket (location, lot and serial).
--   * movement_lines_source_key is keyed on the bucket too (location, lot, serial): one delivery or return line may move several buckets
--     (a FEFO split, one line per serial), each once. An untracked line has a null lot and serial, and postMovement still refuses a source
--     line twice in one request when it names no lot or serial (RG-2).

create or replace function inventory.lot_sellable(p_lot uuid, p_on date)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_lot is null or exists (
    select 1 from inventory.lots l
    left join inventory.product_tracking t on t.company_id = l.company_id and t.product_id = l.product_id
    where l.id = p_lot and l.deleted_at is null and l.lot_status = 'active'
      and not (coalesce(t.block_expired, true) and l.expires_on is not null and l.expires_on < p_on));
$$;
revoke execute on function inventory.lot_sellable(uuid, date) from public, anon;
grant execute on function inventory.lot_sellable(uuid, date) to authenticated, service_role;
comment on function inventory.lot_sellable(uuid, date) is
  'A bucket''s lot may be sold on the date: no lot, or an active lot not deleted and not expired before the date when its product blocks expired lots (RG-4).';

drop function inventory.sale_stock(uuid, uuid[]);
create function inventory.sale_stock(p_warehouse uuid, p_products uuid[], p_on date default null)
returns table (product_id uuid, on_hand numeric, reserved numeric, allow_backorders boolean, max_bucket numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
  v_on date;
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  if not (v_process like 'sales.%' or v_process like 'inventory.%') then
    raise exception 'inventory.sale_stock answers only inside a sales or inventory process' using errcode = 'insufficient_privilege';
  end if;
  v_on := coalesce(p_on, (select (now() at time zone c.timezone)::date from kernel.companies c where c.id = v_company));
  return query
    with buckets as (
      select s.product_id, s.on_hand
      from inventory.stock_levels s left join inventory.locations l on l.id = s.location_id
      where s.company_id = v_company and s.warehouse_id = p_warehouse and s.product_id = any(p_products)
        and (s.location_id is null or (l.deleted_at is null and l.kind <> 'transit'))
        and inventory.lot_sellable(s.lot_id, v_on)
    )
    select p.id,
           coalesce((select sum(b.on_hand) from buckets b where b.product_id = p.id), 0)::numeric,
           coalesce((select sum(r.qty - r.released_qty) from inventory.reservations r
                     where r.company_id = v_company and r.warehouse_id = p_warehouse and r.product_id = p.id and r.status = 'active'), 0)::numeric,
           (select w.allow_backorders from inventory.warehouses w where w.id = p_warehouse and w.company_id = v_company),
           (case when exists (select 1 from inventory.product_tracking t where t.company_id = v_company and t.product_id = p.id and t.tracking <> 'none')
                 then coalesce((select sum(b.on_hand) from buckets b where b.product_id = p.id), 0)
                 else coalesce((select max(b.on_hand) from buckets b where b.product_id = p.id), 0) end)::numeric
    from unnest(p_products) as p(id);
end;
$$;
revoke execute on function inventory.sale_stock(uuid, uuid[], date) from public, anon;
grant execute on function inventory.sale_stock(uuid, uuid[], date) to authenticated, service_role;
comment on function inventory.sale_stock(uuid, uuid[], date) is
  'Published for sales (rule 3): on hand (sellable buckets at the date, RG-4), reserved, the backorder switch and the most one line can take per product.';

create or replace function inventory.source_line_stock(p_source_entity text, p_lines uuid[])
returns table (source_line_id uuid, product_id uuid, warehouse_id uuid, qty numeric, on_hand numeric, allow_backorders boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  if not (v_process like 'sales.%' or v_process like 'inventory.%') then
    raise exception 'inventory.source_line_stock answers only inside a sales or inventory process' using errcode = 'insufficient_privilege';
  end if;
  return query
    select ml.source_line_id, ml.product_id, m.warehouse_id, ml.qty,
           coalesce((select s.on_hand from inventory.stock_levels s
                     where s.company_id = v_company and s.warehouse_id = m.warehouse_id and s.product_id = ml.product_id
                       and s.location_id is not distinct from ml.location_id and s.lot_id is not distinct from ml.lot_id
                       and s.serial_id is not distinct from ml.serial_id), 0)::numeric,
           w.allow_backorders
    from inventory.movement_lines ml
    join inventory.movements m on m.id = ml.movement_id
    join inventory.warehouses w on w.id = m.warehouse_id
    where ml.company_id = v_company and ml.source_entity = p_source_entity and ml.source_line_id = any(p_lines) and m.status = 'saved';
end;
$$;
comment on function inventory.source_line_stock(text, uuid[]) is
  'Published for sales (rule 3): per source line, each saved movement line, the bucket (location, lot, serial) it sits in and what that bucket holds now.';

drop index inventory.movement_lines_source_key;
create unique index movement_lines_source_key on inventory.movement_lines (company_id, source_entity, source_line_id, location_id, lot_id, serial_id) nulls not distinct
  where source_line_id is not null;
