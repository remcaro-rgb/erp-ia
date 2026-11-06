-- 0069_inventory_transfers_counts
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/transfer.integration.test.ts,
-- adjustment.integration.test.ts, count.integration.test.ts and entities.test.ts (the masked views match the entity definitions).
-- Transfers, adjustments and counts (design §8.1, plan 2B Task 7). A traslado (documento with lines) moves stock between two bodegas
-- through the company's transit ubicación: ship takes it out of the source and puts it in transit, receive takes it out of transit and
-- puts it in the destination (inventory.transfer.ship / .receive). A conteo (documento with lines) records what was counted next to what
-- the system held and applies the differences as ONE adjustment. An adjustment is a movement of kind `adjustment` (inventory.adjustment.post,
-- step-up); it needs no table of its own. inventory.v_stock now names the kind of each ubicación so the stock in transit is visible.
-- Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, writes only through inventory processes.

-- ---------------------------------------------------------------------------------------------
-- Traslados
-- ---------------------------------------------------------------------------------------------
create table inventory.transfers (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  number            text,
  date              date not null,
  from_warehouse_id uuid not null references inventory.warehouses (id),
  to_warehouse_id   uuid not null references inventory.warehouses (id),
  reference         text check (reference is null or char_length(reference) <= 100),
  description       text check (description is null or char_length(description) <= 500),
  stage             text not null default 'requested' check (stage in ('requested', 'in_transit', 'received')),
  shipped_at        timestamptz,
  received_at       timestamptz,
  -- The transit ubicación the stock sat in between ship and receive (set by ship).
  transit_location_id uuid references inventory.locations (id),
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check (from_warehouse_id <> to_warehouse_id),
  check ((stage = 'requested') = (shipped_at is null)),
  check ((stage = 'received') = (received_at is not null)),
  check ((stage = 'requested') = (transit_location_id is null))
);
create index transfers_company_date_idx on inventory.transfers (company_id, date);
create index transfers_from_idx on inventory.transfers (from_warehouse_id);
create index transfers_to_idx on inventory.transfers (to_warehouse_id);
create index transfers_in_transit_idx on inventory.transfers (company_id) where stage = 'in_transit';

create table inventory.transfer_lines (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  transfer_id      uuid not null references inventory.transfers (id),
  line_no          int not null check (line_no > 0),
  product_id       uuid not null,
  from_location_id uuid references inventory.locations (id),
  to_location_id   uuid references inventory.locations (id),
  qty              numeric(18,4) not null check (qty > 0),
  uom              text not null check (char_length(uom) between 1 and 10),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  unique (transfer_id, line_no)
);
create index transfer_lines_product_idx on inventory.transfer_lines (company_id, product_id);

-- ---------------------------------------------------------------------------------------------
-- Conteos físicos
-- ---------------------------------------------------------------------------------------------
create table inventory.counts (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  number        text,
  date          date not null,
  warehouse_id  uuid not null references inventory.warehouses (id),
  description   text check (description is null or char_length(description) <= 500),
  stage         text not null default 'open' check (stage in ('open', 'applied')),
  applied_at    timestamptz,
  -- The adjustment the count posted (null while open, and when nothing differed).
  adjustment_id uuid references inventory.movements (id),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check ((stage = 'applied') = (applied_at is not null)),
  check (adjustment_id is null or stage = 'applied')
);
create index counts_company_date_idx on inventory.counts (company_id, date);
create index counts_warehouse_idx on inventory.counts (warehouse_id);
create unique index counts_adjustment_key on inventory.counts (adjustment_id) where adjustment_id is not null;

-- A line names a product (and ubicación) to count. Recording stores what was counted, what the system held at that moment and the
-- difference (counted − system): the adjustment applies that difference.
create table inventory.count_lines (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  count_id    uuid not null references inventory.counts (id),
  line_no     int not null check (line_no > 0),
  product_id  uuid not null,
  location_id uuid references inventory.locations (id),
  system_qty  numeric(18,4),
  counted_qty numeric(18,4) check (counted_qty is null or counted_qty >= 0),
  difference  numeric(18,4),
  recorded_at timestamptz,
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  unique (count_id, line_no),
  check ((counted_qty is null) = (recorded_at is null))
);
create unique index count_lines_bucket_key on inventory.count_lines (count_id, product_id, location_id) nulls not distinct;
create index count_lines_product_idx on inventory.count_lines (company_id, product_id);

-- ---------------------------------------------------------------------------------------------
-- Company RLS, row audit, seq, touch, typed lifecycle (as in 0066)
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('inventory', 'transfers');
select kernel.enable_company_rls('inventory', 'transfer_lines');
select kernel.enable_company_rls('inventory', 'counts');
select kernel.enable_company_rls('inventory', 'count_lines');
select kernel.enable_row_audit('inventory', 'transfers');
select kernel.enable_row_audit('inventory', 'transfer_lines');
select kernel.enable_row_audit('inventory', 'counts');
select kernel.enable_row_audit('inventory', 'count_lines');

create trigger assign_seq before insert on inventory.transfers      for each row execute function core.assign_seq('inventory.transfer');
create trigger assign_seq before insert on inventory.transfer_lines for each row execute function core.assign_seq('inventory.transfer_line');
create trigger assign_seq before insert on inventory.counts         for each row execute function core.assign_seq('inventory.count');
create trigger assign_seq before insert on inventory.count_lines    for each row execute function core.assign_seq('inventory.count_line');
create trigger touch_row before update on inventory.transfers      for each row execute function core.touch_row();
create trigger touch_row before update on inventory.transfer_lines for each row execute function core.touch_row();
create trigger touch_row before update on inventory.counts         for each row execute function core.touch_row();
create trigger touch_row before update on inventory.count_lines    for each row execute function core.touch_row();

select kernel.typed_columns('inventory', 'transfers', 'documento', 'inventory.transfer');
select kernel.typed_columns('inventory', 'counts', 'documento', 'inventory.count');
select kernel.typed_lines('inventory', 'transfer_lines', 'inventory.transfer', 'transfer_id');
select kernel.typed_lines('inventory', 'count_lines', 'inventory.count', 'count_id');

grant select, insert, update on inventory.transfers, inventory.transfer_lines, inventory.counts, inventory.count_lines to authenticated;
grant delete on inventory.transfers, inventory.transfer_lines, inventory.counts, inventory.count_lines to authenticated;
grant all on inventory.transfers, inventory.transfer_lines, inventory.counts, inventory.count_lines to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['transfers', 'transfer_lines', 'counts', 'count_lines'] loop
    execute format($p$create policy via_process_insert on inventory.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
    execute format($p$create policy via_process_update on inventory.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
    execute format($p$create policy via_process_delete on inventory.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
  end loop;
end;
$$;

-- Eliminar (D1): only a Borrador (never numbered), whoever issues the statement.
create or replace function inventory.document_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'erp:invalid_input:Solo se elimina un documento en Borrador';
  end if;
  return old;
end;
$$;
create trigger delete_draft_only before delete on inventory.transfers for each row execute function inventory.document_delete_draft_only();
create trigger delete_draft_only before delete on inventory.counts    for each row execute function inventory.document_delete_draft_only();

-- A traslado's lines are written while it is a Borrador only: what is moved does not change after (void and make another).
create or replace function inventory.transfer_lines_frozen() returns trigger
language plpgsql
as $$
declare
  v_transfer uuid := case when tg_op = 'DELETE' then old.transfer_id else new.transfer_id end;
  v_status text;
begin
  select status into v_status from inventory.transfers where id = v_transfer;
  if v_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Las líneas de un traslado registrado no cambian: anúlalo y registra otro';
end;
$$;
create trigger transfer_lines_frozen before insert or update or delete on inventory.transfer_lines
  for each row execute function inventory.transfer_lines_frozen();

-- A conteo's lines are added while it is a Borrador; once saved only their counted columns change, and only while the count is open
-- (an applied count is history).
create or replace function inventory.count_lines_guard() returns trigger
language plpgsql
as $$
declare
  v_count uuid := case when tg_op = 'DELETE' then old.count_id else new.count_id end;
  v_status text;
  v_stage text;
begin
  select status, stage into v_status, v_stage from inventory.counts where id = v_count;
  if v_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and v_stage = 'open' and v_status <> 'voided'
     and (new.count_id, new.line_no, new.product_id, new.location_id) is not distinct from (old.count_id, old.line_no, old.product_id, old.location_id) then
    return new;
  end if;
  raise exception 'erp:invalid_input:Las líneas de un conteo aplicado o anulado no cambian';
end;
$$;
create trigger count_lines_guard before insert or update or delete on inventory.count_lines
  for each row execute function inventory.count_lines_guard();

-- ---------------------------------------------------------------------------------------------
-- Entity -> table rows and references
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('inventory.transfer', 'inventory', 'documento', 'inventory', 'transfers', 'inventory.transfer_line'),
  ('inventory.count',    'inventory', 'documento', 'inventory', 'counts',    'inventory.count_line')
on conflict (entity) do nothing;

select kernel.register_reference('inventory.warehouse', 'inventory', 'transfers',      'from_warehouse_id');
select kernel.register_reference('inventory.warehouse', 'inventory', 'transfers',      'to_warehouse_id');
select kernel.register_reference('inventory.warehouse', 'inventory', 'counts',         'warehouse_id');
select kernel.register_reference('inventory.location',  'inventory', 'transfer_lines', 'from_location_id');
select kernel.register_reference('inventory.location',  'inventory', 'transfer_lines', 'to_location_id');
select kernel.register_reference('inventory.location',  'inventory', 'transfers',      'transit_location_id');
select kernel.register_reference('inventory.location',  'inventory', 'count_lines',    'location_id');
select kernel.register_reference('core.product',        'inventory', 'transfer_lines', 'product_id');
select kernel.register_reference('core.product',        'inventory', 'count_lines',    'product_id');

-- ---------------------------------------------------------------------------------------------
-- inventory.v_stock: the same buckets, now with the kind of the ubicación (storage | transit) so a screen and the other modules see
-- the stock travelling between two bodegas (appended column: the first seven are unchanged).
-- ---------------------------------------------------------------------------------------------
create or replace view inventory.v_stock with (security_invoker = true) as
with buckets as (
  select s.company_id, s.product_id, s.warehouse_id, s.location_id, s.on_hand, 0::numeric as reserved
  from inventory.stock_levels s
  union all
  select r.company_id, r.product_id, r.warehouse_id, r.location_id, 0::numeric, r.qty - r.released_qty
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
  (sum(b.on_hand) - sum(b.reserved))::numeric(18,4) as available,
  l.kind as location_kind
from buckets b
left join inventory.locations l on l.id = b.location_id
group by b.company_id, b.product_id, b.warehouse_id, b.location_id, l.kind;
grant select on inventory.v_stock to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/inventory/src/entities.ts and pasted here;
-- entities.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------

create or replace view inventory.v_transfers with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.transfer', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.transfer', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('inventory.transfer', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('inventory.transfer', 'from_warehouse_id')) then "from_warehouse_id" else null end as "from_warehouse_id",
  case when (select kernel.field_visible('inventory.transfer', 'to_warehouse_id')) then "to_warehouse_id" else null end as "to_warehouse_id",
  case when (select kernel.field_visible('inventory.transfer', 'reference')) then "reference" else null end as "reference",
  case when (select kernel.field_visible('inventory.transfer', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('inventory.transfer', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('inventory.transfer', 'shipped_at')) then "shipped_at" else null end as "shipped_at",
  case when (select kernel.field_visible('inventory.transfer', 'received_at')) then "received_at" else null end as "received_at",
  case when (select kernel.field_visible('inventory.transfer', 'transit_location_id')) then "transit_location_id" else null end as "transit_location_id",
  case when (select kernel.field_visible('inventory.transfer', 'extra')) then kernel.mask_extra('inventory.transfer', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.transfer', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.transfer', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.transfer', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('inventory.transfer', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('inventory.transfer', 'void_reason')) then "void_reason" else null end as "void_reason"
from inventory.transfers;
grant select on inventory.v_transfers to authenticated;

create or replace view inventory.v_transfer_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.transfer_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.transfer_line', 'transfer_id')) then "transfer_id" else null end as "transfer_id",
  case when (select kernel.field_visible('inventory.transfer_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('inventory.transfer_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.transfer_line', 'from_location_id')) then "from_location_id" else null end as "from_location_id",
  case when (select kernel.field_visible('inventory.transfer_line', 'to_location_id')) then "to_location_id" else null end as "to_location_id",
  case when (select kernel.field_visible('inventory.transfer_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('inventory.transfer_line', 'uom')) then "uom" else null end as "uom",
  case when (select kernel.field_visible('inventory.transfer_line', 'extra')) then kernel.mask_extra('inventory.transfer_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.transfer_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.transfer_lines;
grant select on inventory.v_transfer_lines to authenticated;

create or replace view inventory.v_counts with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.count', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.count', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('inventory.count', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('inventory.count', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('inventory.count', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('inventory.count', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('inventory.count', 'applied_at')) then "applied_at" else null end as "applied_at",
  case when (select kernel.field_visible('inventory.count', 'adjustment_id')) then "adjustment_id" else null end as "adjustment_id",
  case when (select kernel.field_visible('inventory.count', 'extra')) then kernel.mask_extra('inventory.count', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.count', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.count', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.count', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('inventory.count', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('inventory.count', 'void_reason')) then "void_reason" else null end as "void_reason"
from inventory.counts;
grant select on inventory.v_counts to authenticated;

create or replace view inventory.v_count_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.count_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.count_line', 'count_id')) then "count_id" else null end as "count_id",
  case when (select kernel.field_visible('inventory.count_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('inventory.count_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.count_line', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('inventory.count_line', 'system_qty')) then "system_qty" else null end as "system_qty",
  case when (select kernel.field_visible('inventory.count_line', 'counted_qty')) then "counted_qty" else null end as "counted_qty",
  case when (select kernel.field_visible('inventory.count_line', 'difference')) then "difference" else null end as "difference",
  case when (select kernel.field_visible('inventory.count_line', 'recorded_at')) then "recorded_at" else null end as "recorded_at",
  case when (select kernel.field_visible('inventory.count_line', 'extra')) then kernel.mask_extra('inventory.count_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.count_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.count_lines;
grant select on inventory.v_count_lines to authenticated;

