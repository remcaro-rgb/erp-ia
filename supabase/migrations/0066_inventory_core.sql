-- 0066_inventory_core
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/movement.integration.test.ts,
-- stock-level.integration.test.ts and entities.test.ts (the masked views match the entity definitions).
-- The inventory module (design §8, plan 2B Task 6): bodegas and ubicaciones (maestros), movimientos (a documento numbered on save, with
-- its lines), the stock per product / bodega / ubicación and the reservations, plus inventory.v_stock, the view the other modules read
-- (sales, Task 13). Rule 3: no foreign key leaves the schema (product ids are core's, checked by the processes through
-- core.v_product_stock, migration 0067). Lots and serials arrive in 2B.2 (OD-8): `lot_id` / `serial_id` exist on the lines and the stock
-- rows, nullable and unused, so that task needs no rewrite. Every table: uuid v7, company, seq, extra / extra_free, audit columns,
-- company RLS, row audit, and writes only through the inventory processes (restrictive policies on erp.audit_process_id).

create schema if not exists inventory;
grant usage on schema inventory to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Bodegas. OD-3: an issue that leaves stock below zero is refused unless the bodega allows backorders.
-- ---------------------------------------------------------------------------------------------
create table inventory.warehouses (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  code             text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  name             text not null check (char_length(btrim(name)) between 1 and 120),
  address_line     text check (address_line is null or char_length(address_line) <= 200),
  allow_backorders boolean not null default false,
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq)
);

-- Ubicaciones of a bodega: `storage` holds stock, `transit` the stock travelling between two bodegas (transfers, Task 7). A ubicación
-- never changes bodega (its stock rows name both: the composite key below).
create table inventory.locations (
  id           uuid primary key default kernel.uuid_v7(),
  seq          bigint not null,
  company_id   uuid not null references kernel.companies (id),
  warehouse_id uuid not null references inventory.warehouses (id),
  code         text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  kind         text not null default 'storage' check (kind in ('storage', 'transit')),
  extra        jsonb not null default '{}'::jsonb,
  extra_free   jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default kernel.current_user_id(),
  updated_by   uuid,
  unique (company_id, seq),
  unique (id, warehouse_id)
);
create index locations_warehouse_id_idx on inventory.locations (warehouse_id);

-- ---------------------------------------------------------------------------------------------
-- Movimientos. `kind` fixes the sign of the quantities (receipt / sale_return add, issue / sale_issue / transfer_out take, an adjustment
-- either). `applied_at` is when the movement reached the stock (inventory.movement.post, in the same transaction as its Grabar).
-- Money (rule 8): unit costs are in the company currency, the header keeps it with its exchange-rate snapshot (1).
-- ---------------------------------------------------------------------------------------------
create table inventory.movements (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  number        text,
  kind          text not null check (kind in ('receipt', 'issue', 'sale_issue', 'sale_return', 'adjustment', 'transfer_out', 'transfer_in')),
  date          date not null,
  warehouse_id  uuid not null references inventory.warehouses (id),
  reference     text check (reference is null or char_length(reference) <= 100),
  description   text check (description is null or char_length(description) <= 500),
  currency      text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(18,6) not null default 1 check (exchange_rate > 0),
  source_entity text check (source_entity is null or source_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  source_id     uuid,
  applied_at    timestamptz,
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (company_id, number)
);
create index movements_company_date_idx on inventory.movements (company_id, date);
create index movements_warehouse_id_idx on inventory.movements (warehouse_id);
create index movements_source_idx on inventory.movements (company_id, source_entity, source_id) where source_id is not null;

-- Lines: signed quantity in the product's unit. The source line (a delivery line, a return line) is the idempotency key of the movement
-- that answers it: one movement line per source line (Review Focus 1: a redelivered event never moves stock twice).
create table inventory.movement_lines (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  movement_id    uuid not null references inventory.movements (id),
  line_no        int not null check (line_no > 0),
  product_id     uuid not null,
  location_id    uuid references inventory.locations (id),
  lot_id         uuid,
  serial_id      uuid,
  qty            numeric(18,4) not null check (qty <> 0),
  uom            text not null check (char_length(uom) between 1 and 10),
  unit_cost      numeric(18,4) check (unit_cost is null or unit_cost >= 0),
  source_entity  text check (source_entity is null or source_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  source_line_id uuid,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (movement_id, line_no),
  check ((source_entity is null) = (source_line_id is null))
);
create index movement_lines_product_id_idx on inventory.movement_lines (company_id, product_id);
create unique index movement_lines_source_key on inventory.movement_lines (company_id, source_entity, source_line_id) where source_line_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Existencias: on hand per product, bodega and ubicación (a null ubicación is the bodega's own stock; lot and serial null until 2B.2).
-- One row per bucket, nulls not distinct, so the movements lock exactly one row per bucket. No check on on_hand: a bodega that allows
-- backorders goes below zero; the processes refuse it everywhere else.
-- ---------------------------------------------------------------------------------------------
create table inventory.stock_levels (
  id           uuid primary key default kernel.uuid_v7(),
  seq          bigint not null,
  company_id   uuid not null references kernel.companies (id),
  product_id   uuid not null,
  warehouse_id uuid not null references inventory.warehouses (id),
  location_id  uuid,
  lot_id       uuid,
  serial_id    uuid,
  on_hand      numeric(18,4) not null default 0,
  extra        jsonb not null default '{}'::jsonb,
  extra_free   jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default kernel.current_user_id(),
  updated_by   uuid,
  unique (company_id, seq),
  foreign key (location_id, warehouse_id) references inventory.locations (id, warehouse_id)
);
create unique index stock_levels_bucket_key on inventory.stock_levels (company_id, product_id, warehouse_id, location_id, lot_id, serial_id) nulls not distinct;
create index stock_levels_warehouse_idx on inventory.stock_levels (company_id, warehouse_id, product_id);

-- Reservas: stock promised to a source line (an order line, Task 13). What stays reserved is qty − released_qty while active. One
-- reservation per source line: a redelivered event finds it. `location_id` stays null until picking (2B.2).
create table inventory.reservations (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  source_entity  text not null check (source_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  source_line_id uuid not null,
  product_id     uuid not null,
  warehouse_id   uuid not null references inventory.warehouses (id),
  location_id    uuid,
  qty            numeric(18,4) not null check (qty > 0),
  released_qty   numeric(18,4) not null default 0 check (released_qty >= 0 and released_qty <= qty),
  status         text not null default 'active' check (status in ('active', 'released')),
  released_at    timestamptz,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (company_id, source_entity, source_line_id),
  foreign key (location_id, warehouse_id) references inventory.locations (id, warehouse_id),
  check ((status = 'released') = (released_at is not null))
);
create index reservations_product_idx on inventory.reservations (company_id, product_id, warehouse_id) where status = 'active';

-- ---------------------------------------------------------------------------------------------
-- Movement numbers (D9: by company sequence): one gap-free counter per company and prefix (EN-, SA-, SV-, DV-, AJ-, TS-, TE-). Drawn in the
-- movement's transaction, so a refused movement consumes no number. Written only by inventory.next_movement_number.
-- ---------------------------------------------------------------------------------------------
create table inventory.movement_numbers (
  company_id uuid not null references kernel.companies (id),
  prefix     text not null check (prefix ~ '^[A-Z]{1,5}-$'),
  next       bigint not null default 1 check (next > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);
select kernel.enable_company_rls('inventory', 'movement_numbers');
grant select on inventory.movement_numbers to authenticated;
grant all on inventory.movement_numbers to service_role;

create or replace function inventory.next_movement_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into inventory.movement_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;
revoke execute on function inventory.next_movement_number(uuid, text) from public, anon;
grant execute on function inventory.next_movement_number(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (core's shared trigger, rule 7) and the touch trigger.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('inventory', 'warehouses');
select kernel.enable_company_rls('inventory', 'locations');
select kernel.enable_company_rls('inventory', 'movements');
select kernel.enable_company_rls('inventory', 'movement_lines');
select kernel.enable_company_rls('inventory', 'stock_levels');
select kernel.enable_company_rls('inventory', 'reservations');
select kernel.enable_row_audit('inventory', 'warehouses');
select kernel.enable_row_audit('inventory', 'locations');
select kernel.enable_row_audit('inventory', 'movements');
select kernel.enable_row_audit('inventory', 'movement_lines');
select kernel.enable_row_audit('inventory', 'stock_levels');
select kernel.enable_row_audit('inventory', 'reservations');

create trigger assign_seq before insert on inventory.warehouses     for each row execute function core.assign_seq('inventory.warehouse');
create trigger assign_seq before insert on inventory.locations      for each row execute function core.assign_seq('inventory.location');
create trigger assign_seq before insert on inventory.movements      for each row execute function core.assign_seq('inventory.movement');
create trigger assign_seq before insert on inventory.movement_lines for each row execute function core.assign_seq('inventory.movement_line');
create trigger assign_seq before insert on inventory.stock_levels   for each row execute function core.assign_seq('inventory.stock_level');
create trigger assign_seq before insert on inventory.reservations   for each row execute function core.assign_seq('inventory.reservation');
create trigger touch_row before update on inventory.warehouses     for each row execute function core.touch_row();
create trigger touch_row before update on inventory.locations      for each row execute function core.touch_row();
create trigger touch_row before update on inventory.movements      for each row execute function core.touch_row();
create trigger touch_row before update on inventory.movement_lines for each row execute function core.touch_row();
create trigger touch_row before update on inventory.stock_levels   for each row execute function core.touch_row();
create trigger touch_row before update on inventory.reservations   for each row execute function core.touch_row();

-- The typed lifecycle (entity types spec §5): the maestros' and the movement's state columns, the flags copied at insert and the
-- record-access read policy; the lines inherit the movement's read right.
select kernel.typed_columns('inventory', 'warehouses', 'maestro', 'inventory.warehouse');
select kernel.typed_columns('inventory', 'locations', 'maestro', 'inventory.location');
select kernel.typed_columns('inventory', 'movements', 'documento', 'inventory.movement');
select kernel.typed_lines('inventory', 'movement_lines', 'inventory.movement', 'movement_id');

-- Codes are unique among the records not deleted, whatever their case.
create unique index warehouses_company_code_key on inventory.warehouses (company_id, lower(code)) where deleted_at is null;
create unique index locations_warehouse_code_key on inventory.locations (warehouse_id, lower(code)) where deleted_at is null;

-- Grants: the handlers run as the caller. A Borrador movement (never numbered) may be deleted with its lines by the lifecycle (D1).
grant select, insert, update on inventory.warehouses, inventory.locations, inventory.movements, inventory.movement_lines,
  inventory.stock_levels, inventory.reservations to authenticated;
grant delete on inventory.movements, inventory.movement_lines to authenticated;
grant all on inventory.warehouses, inventory.locations, inventory.movements, inventory.movement_lines, inventory.stock_levels,
  inventory.reservations to service_role;

-- Writes only through the process pipeline (rule 1): runProcess sets erp.audit_process_id for its transaction, so a user writing the
-- tables directly (through the API, say) is refused. Inventory tables are written by inventory processes and by the kernel's lifecycle
-- processes of the inventory entities (`inventory.<entity>.save` …), whose ids share the prefix.
do $$
declare
  t text;
begin
  foreach t in array array['warehouses', 'locations', 'movements', 'movement_lines', 'stock_levels', 'reservations'] loop
    execute format($p$create policy via_process_insert on inventory.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
    execute format($p$create policy via_process_update on inventory.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
  end loop;
  foreach t in array array['movements', 'movement_lines'] loop
    execute format($p$create policy via_process_delete on inventory.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
  end loop;
end;
$$;

-- A movement in the stock does not change (Review Focus 1): its lines are written only while it is a Borrador (inventory.movement.post
-- writes them before its Grabar); a Grabado or Anulado one is corrected by Anular and a new movement.
create or replace function inventory.movement_lines_frozen() returns trigger
language plpgsql
as $$
declare
  v_movement uuid := case when tg_op = 'DELETE' then old.movement_id else new.movement_id end;
  v_status text;
begin
  select status into v_status from inventory.movements where id = v_movement;
  if v_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Las líneas de un movimiento registrado en el inventario no cambian: anúlalo y registra otro';
end;
$$;
create trigger movement_lines_frozen before insert or update or delete on inventory.movement_lines
  for each row execute function inventory.movement_lines_frozen();

-- Eliminar (D1): only a Borrador, never a movement that reached the stock, whoever issues the statement.
create or replace function inventory.movements_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'erp:invalid_input:Solo se elimina un movimiento en Borrador';
  end if;
  return old;
end;
$$;
create trigger movements_delete_draft_only before delete on inventory.movements for each row execute function inventory.movements_delete_draft_only();

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones
-- work from the migration on.
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('inventory.warehouse', 'inventory', 'maestro',   'inventory', 'warehouses', null),
  ('inventory.location',  'inventory', 'maestro',   'inventory', 'locations',  null),
  ('inventory.movement',  'inventory', 'documento', 'inventory', 'movements',  'inventory.movement_line')
on conflict (entity) do nothing;

-- Who uses an inventory maestro or a product (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no.
select kernel.register_reference('inventory.warehouse', 'inventory', 'locations',      'warehouse_id');
select kernel.register_reference('inventory.warehouse', 'inventory', 'movements',      'warehouse_id');
select kernel.register_reference('inventory.warehouse', 'inventory', 'stock_levels',   'warehouse_id');
select kernel.register_reference('inventory.warehouse', 'inventory', 'reservations',   'warehouse_id');
select kernel.register_reference('inventory.location',  'inventory', 'movement_lines', 'location_id');
select kernel.register_reference('inventory.location',  'inventory', 'stock_levels',   'location_id');
select kernel.register_reference('core.product',        'inventory', 'movement_lines', 'product_id');
select kernel.register_reference('core.product',        'inventory', 'stock_levels',   'product_id');
select kernel.register_reference('core.product',        'inventory', 'reservations',   'product_id');

-- ---------------------------------------------------------------------------------------------
-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and kernel.notify_custom_field_changed, 0008,
-- raise when the module has none). Inventory records derive no readiness from their files or their extra data: both are no-ops.
-- ---------------------------------------------------------------------------------------------
create or replace function inventory.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function inventory.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function inventory.attachments_changed(text, uuid, uuid) to service_role;

create or replace function inventory.custom_field_changed(p_entity text, p_company uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function inventory.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function inventory.custom_field_changed(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/inventory/src/entities.ts and pasted here; entities.test.ts fails when they drift. The maestros' views drop deleted rows.
-- ---------------------------------------------------------------------------------------------

create or replace view inventory.v_warehouses with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.warehouse', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.warehouse', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('inventory.warehouse', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('inventory.warehouse', 'address_line')) then "address_line" else null end as "address_line",
  case when (select kernel.field_visible('inventory.warehouse', 'allow_backorders')) then "allow_backorders" else null end as "allow_backorders",
  case when (select kernel.field_visible('inventory.warehouse', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('inventory.warehouse', 'extra')) then kernel.mask_extra('inventory.warehouse', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.warehouse', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.warehouse', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.warehouse', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from inventory.warehouses
where deleted_at is null;
grant select on inventory.v_warehouses to authenticated;

create or replace view inventory.v_locations with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.location', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.location', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('inventory.location', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('inventory.location', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('inventory.location', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('inventory.location', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('inventory.location', 'extra')) then kernel.mask_extra('inventory.location', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.location', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.location', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.location', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from inventory.locations
where deleted_at is null;
grant select on inventory.v_locations to authenticated;

create or replace view inventory.v_movements with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.movement', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.movement', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('inventory.movement', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('inventory.movement', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('inventory.movement', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('inventory.movement', 'reference')) then "reference" else null end as "reference",
  case when (select kernel.field_visible('inventory.movement', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('inventory.movement', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('inventory.movement', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('inventory.movement', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('inventory.movement', 'source_id')) then "source_id" else null end as "source_id",
  case when (select kernel.field_visible('inventory.movement', 'applied_at')) then "applied_at" else null end as "applied_at",
  case when (select kernel.field_visible('inventory.movement', 'extra')) then kernel.mask_extra('inventory.movement', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.movement', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.movement', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.movement', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('inventory.movement', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('inventory.movement', 'void_reason')) then "void_reason" else null end as "void_reason"
from inventory.movements;
grant select on inventory.v_movements to authenticated;

create or replace view inventory.v_movement_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.movement_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.movement_line', 'movement_id')) then "movement_id" else null end as "movement_id",
  case when (select kernel.field_visible('inventory.movement_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('inventory.movement_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.movement_line', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('inventory.movement_line', 'lot_id')) then "lot_id" else null end as "lot_id",
  case when (select kernel.field_visible('inventory.movement_line', 'serial_id')) then "serial_id" else null end as "serial_id",
  case when (select kernel.field_visible('inventory.movement_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('inventory.movement_line', 'uom')) then "uom" else null end as "uom",
  case when (select kernel.field_visible('inventory.movement_line', 'unit_cost')) then "unit_cost" else null end as "unit_cost",
  case when (select kernel.field_visible('inventory.movement_line', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('inventory.movement_line', 'source_line_id')) then "source_line_id" else null end as "source_line_id",
  case when (select kernel.field_visible('inventory.movement_line', 'extra')) then kernel.mask_extra('inventory.movement_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.movement_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.movement_lines;
grant select on inventory.v_movement_lines to authenticated;

create or replace view inventory.v_stock_levels with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.stock_level', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.stock_level', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.stock_level', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('inventory.stock_level', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('inventory.stock_level', 'lot_id')) then "lot_id" else null end as "lot_id",
  case when (select kernel.field_visible('inventory.stock_level', 'serial_id')) then "serial_id" else null end as "serial_id",
  case when (select kernel.field_visible('inventory.stock_level', 'on_hand')) then "on_hand" else null end as "on_hand",
  case when (select kernel.field_visible('inventory.stock_level', 'extra')) then kernel.mask_extra('inventory.stock_level', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.stock_level', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.stock_levels;
grant select on inventory.v_stock_levels to authenticated;

create or replace view inventory.v_reservations with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.reservation', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.reservation', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('inventory.reservation', 'source_line_id')) then "source_line_id" else null end as "source_line_id",
  case when (select kernel.field_visible('inventory.reservation', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.reservation', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('inventory.reservation', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('inventory.reservation', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('inventory.reservation', 'released_qty')) then "released_qty" else null end as "released_qty",
  case when (select kernel.field_visible('inventory.reservation', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.reservation', 'released_at')) then "released_at" else null end as "released_at",
  case when (select kernel.field_visible('inventory.reservation', 'extra')) then kernel.mask_extra('inventory.reservation', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.reservation', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.reservations;
grant select on inventory.v_reservations to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Published for the other modules (rule 3): the stock of every product per bodega and ubicación, what is reserved and what is available
-- (on hand − reserved). Reservations sit at the bodega level (a null ubicación) until picking (2B.2), so the sum over a bodega's rows is
-- its availability. Security invoker: company RLS applies; stock carries no masked field.
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
  company_id,
  product_id,
  warehouse_id,
  location_id,
  sum(on_hand)::numeric(18,4) as on_hand,
  sum(reserved)::numeric(18,4) as reserved,
  (sum(on_hand) - sum(reserved))::numeric(18,4) as available
from buckets
group by company_id, product_id, warehouse_id, location_id;
grant select on inventory.v_stock to authenticated;
