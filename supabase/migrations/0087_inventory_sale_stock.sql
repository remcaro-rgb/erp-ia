-- 0087_inventory_sale_stock
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/delivery.integration.test.ts (the ship check and the
-- void of a devolución read these functions) and packages/modules/inventory/src/__tests__/sale-stock.integration.test.ts.
-- Plan 2B Task 14 (review): inventory's published stock for the remisiones and devoluciones of sales, in inventory's own migration (rule 3:
-- sales reads inventory only through what inventory publishes). Nothing is written. Every function is security definer and unmasked (a
-- computation, not a display: the caller's field visibility must never change whether goods ship), limited to the caller's active company,
-- and answers only inside a sales or inventory process run (erp.audit_process_id).
--
-- The figures are the ones inventory's own sale issue uses (packages/modules/inventory/src/processes/sales-deliveries.ts): only the stock
-- without lot or serial, in the bodega itself (no ubicación) or in a ubicación that is not deleted and not a transit one. Each remisión line
-- leaves from ONE such bucket (until picking, 2B.2), so a line is shippable only when one bucket holds it: `max_bucket` is the most any
-- single bucket holds.

create or replace function inventory.sale_stock(p_warehouse uuid, p_products uuid[])
returns table (product_id uuid, on_hand numeric, reserved numeric, allow_backorders boolean, max_bucket numeric)
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
    raise exception 'inventory.sale_stock answers only inside a sales or inventory process' using errcode = 'insufficient_privilege';
  end if;
  return query
    with buckets as (
      select s.product_id, s.on_hand
      from inventory.stock_levels s left join inventory.locations l on l.id = s.location_id
      where s.company_id = v_company and s.warehouse_id = p_warehouse and s.product_id = any(p_products)
        and s.lot_id is null and s.serial_id is null
        and (s.location_id is null or (l.deleted_at is null and l.kind <> 'transit'))
    )
    select p.id,
           coalesce((select sum(b.on_hand) from buckets b where b.product_id = p.id), 0)::numeric,
           coalesce((select sum(r.qty - r.released_qty) from inventory.reservations r
                     where r.company_id = v_company and r.warehouse_id = p_warehouse and r.product_id = p.id and r.status = 'active'), 0)::numeric,
           (select w.allow_backorders from inventory.warehouses w where w.id = p_warehouse and w.company_id = v_company),
           coalesce((select max(b.on_hand) from buckets b where b.product_id = p.id), 0)::numeric
    from unnest(p_products) as p(id);
end;
$$;
revoke execute on function inventory.sale_stock(uuid, uuid[]) from public, anon;
grant execute on function inventory.sale_stock(uuid, uuid[]) to authenticated, service_role;
comment on function inventory.sale_stock(uuid, uuid[]) is
  'Published for sales (rule 3): on hand (shippable buckets), reserved, the backorder switch and the largest single bucket of a bodega per product.';

create or replace function inventory.source_reservations(p_source_entity text, p_lines uuid[])
returns table (source_line_id uuid, product_id uuid, warehouse_id uuid, reserved numeric)
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
    raise exception 'inventory.source_reservations answers only inside a sales or inventory process' using errcode = 'insufficient_privilege';
  end if;
  return query
    select r.source_line_id, r.product_id, r.warehouse_id, sum(r.qty - r.released_qty)::numeric
    from inventory.reservations r
    where r.company_id = v_company and r.source_entity = p_source_entity and r.source_line_id = any(p_lines) and r.status = 'active'
    group by r.source_line_id, r.product_id, r.warehouse_id;
end;
$$;
revoke execute on function inventory.source_reservations(text, uuid[]) from public, anon;
grant execute on function inventory.source_reservations(text, uuid[]) to authenticated, service_role;
comment on function inventory.source_reservations(text, uuid[]) is
  'Published for sales (rule 3): the active reservation of each pedido line, for the remisión that delivers it.';

-- The bucket each movement line of a source document sits in (saved movements only) and what that bucket holds now: what the Anular of a
-- received devolución takes back out, line by line, from where it entered.
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
                       and s.location_id is not distinct from ml.location_id and s.lot_id is null and s.serial_id is null), 0)::numeric,
           w.allow_backorders
    from inventory.movement_lines ml
    join inventory.movements m on m.id = ml.movement_id
    join inventory.warehouses w on w.id = m.warehouse_id
    where ml.company_id = v_company and ml.source_entity = p_source_entity and ml.source_line_id = any(p_lines) and m.status = 'saved';
end;
$$;
revoke execute on function inventory.source_line_stock(text, uuid[]) from public, anon;
grant execute on function inventory.source_line_stock(text, uuid[]) to authenticated, service_role;
comment on function inventory.source_line_stock(text, uuid[]) is
  'Published for sales (rule 3): per source line, its saved movement line, the bucket it sits in and what that bucket holds now.';
