-- 0170_warehouse_core
-- Forward-only migration (rule 34). Covered by packages/modules/warehouse/src/__tests__/pick.integration.test.ts (the warehouse, sales and
-- inventory modules loaded together) and packages/modules/warehouse/src/__tests__/entities.test.ts (the masked views match the entities).
-- Plan 2B.2 Task 29.1 (PG §4.1–§4.3, items 151, 153, 164; RG-7, RG-10): the warehouse module's schema.
--   * warehouse.settings (parametro, one row per company: auto_pick_on_confirm, delivery_from_pick, both on by default);
--   * warehouse.picks (alistamientos: a documento numbered ALI- on save that never posts and never waits for approval) with
--     warehouse.pick_lines (one pedido line from one bucket: ubicación, lot, serial), and the module's number counter
--     (warehouse.document_numbers, warehouse.next_number: a system counter like sales', 0084:108-135, an exception to rule 7);
--   * the pedido lines as published for an alistamiento (sales.v_pick_order_lines, rule 3): warehouse reads the pedido there, never sales'
--     tables, as 0084 published crm's cotizaciones for the pedido;
--   * inventory.reservation_allocations may be deleted inside an inventory process: the release of a reservation drops its allocations
--     (Task 29.1, «release drops allocations»), the allocation of a pick replaces the earlier allocation of the same reservation.
-- Bins are inventory locations (item 151): a pick line names inventory's ubicación, lot and serial by id; the pedido, its lines, the party
-- and the product are other modules' records, named by id: no foreign key leaves the schema (rule 3). Every table: uuid v7, company, seq,
-- extra / extra_free, audit columns, company RLS, row audit, and writes only through the module's processes (restrictive policies on
-- erp.audit_process_id).

create schema if not exists warehouse;
grant usage on schema warehouse to authenticated, service_role;

-- =============================================================================================
-- Parámetros de bodega
-- =============================================================================================
create table warehouse.settings (
  id                   uuid primary key default kernel.uuid_v7(),
  seq                  bigint not null,
  company_id           uuid not null references kernel.companies (id),
  auto_pick_on_confirm boolean not null default true,
  delivery_from_pick   boolean not null default true,
  extra                jsonb not null default '{}'::jsonb,
  extra_free           jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid default kernel.current_user_id(),
  updated_by           uuid,
  unique (company_id, seq),
  unique (company_id)
);

-- =============================================================================================
-- Alistamientos
-- =============================================================================================
-- `stage` is where it stands beside the lifecycle `status` (open → in_progress → confirmed; Anulado is status voided). The pedido's number
-- and party are copied at creation (what the picker reads on the sheet); allocation_* is inventory's answer to the confirmation.
create table warehouse.picks (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  number            text,
  order_id          uuid not null,
  order_number      text,
  warehouse_id      uuid not null,
  party_id          uuid not null,
  stage             text not null default 'open' check (stage in ('open', 'in_progress', 'confirmed')),
  picker_user_id    uuid,
  started_at        timestamptz,
  confirmed_at      timestamptz,
  allocation_status text check (allocation_status is null or allocation_status in ('allocated', 'short')),
  allocated_at      timestamptz,
  allocation_note   text check (allocation_note is null or char_length(allocation_note) <= 4000),
  notes             text check (notes is null or char_length(notes) <= 2000),
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check (stage <> 'confirmed' or confirmed_at is not null)
);
create index picks_order_idx on warehouse.picks (company_id, order_id);
create index picks_company_stage_idx on warehouse.picks (company_id, stage);

create table warehouse.pick_lines (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  pick_id       uuid not null references warehouse.picks (id),
  line_no       int not null check (line_no > 0),
  order_line_id uuid not null,
  product_id    uuid not null,
  qty_requested numeric(18,4) not null check (qty_requested >= 0),
  location_id   uuid,
  lot_id        uuid,
  serial_id     uuid,
  qty_picked    numeric(18,4) check (qty_picked is null or qty_picked >= 0),
  short_qty     numeric(18,4) check (short_qty is null or short_qty > 0),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (pick_id, line_no),
  check (serial_id is null or qty_picked is null or qty_picked <= 1)
);
create index pick_lines_order_line_idx on warehouse.pick_lines (company_id, order_line_id);

-- The alistamiento numbers (ALI-1, ALI-2 …) per company: a system counter (no seq, like sales.document_numbers), drawn on the first Grabar.
create table warehouse.document_numbers (
  company_id uuid not null references kernel.companies (id),
  prefix     text not null check (prefix ~ '^[A-Z]{1,5}-$'),
  next       bigint not null default 1 check (next > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);
select kernel.enable_company_rls('warehouse', 'document_numbers');
grant select on warehouse.document_numbers to authenticated;
grant all on warehouse.document_numbers to service_role;

create or replace function warehouse.next_number(p_company uuid, p_prefix text) returns text
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
  insert into warehouse.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;
revoke execute on function warehouse.next_number(uuid, text) from public, anon;
grant execute on function warehouse.next_number(uuid, text) to authenticated, service_role;

-- =============================================================================================
-- Company RLS (rule 12), row audit (rule 16), seq (rule 7), touch, the typed lifecycle (entity types spec §5)
-- =============================================================================================
select kernel.enable_company_rls('warehouse', 'settings');
select kernel.enable_company_rls('warehouse', 'picks');
select kernel.enable_company_rls('warehouse', 'pick_lines');
select kernel.enable_row_audit('warehouse', 'settings');
select kernel.enable_row_audit('warehouse', 'picks');
select kernel.enable_row_audit('warehouse', 'pick_lines');
create trigger assign_seq before insert on warehouse.settings   for each row execute function core.assign_seq('warehouse.settings');
create trigger assign_seq before insert on warehouse.picks      for each row execute function core.assign_seq('warehouse.pick');
create trigger assign_seq before insert on warehouse.pick_lines for each row execute function core.assign_seq('warehouse.pick_line');
create trigger touch_row before update on warehouse.settings   for each row execute function core.touch_row();
create trigger touch_row before update on warehouse.picks      for each row execute function core.touch_row();
create trigger touch_row before update on warehouse.pick_lines for each row execute function core.touch_row();

-- The alistamiento's state columns, the flags copied at insert (warehouse sets them itself: never approval, never posting) and the
-- record-access read policy; the lines inherit the alistamiento's read right.
select kernel.typed_columns('warehouse', 'picks', 'documento', 'warehouse.pick');
select kernel.typed_lines('warehouse', 'pick_lines', 'warehouse.pick', 'pick_id');

-- One open alistamiento per pedido (idempotent creation, Task 29.1): a confirmed or voided one frees the pedido for the next.
create unique index picks_one_open_per_order on warehouse.picks (company_id, order_id) where stage <> 'confirmed' and status <> 'voided';

-- Grants: the handlers run as the caller. A Borrador alistamiento (never numbered) may be deleted by the lifecycle (D1); the update and the
-- confirmation rewrite the lines of an open one.
grant select, insert, update on warehouse.settings to authenticated;
grant select, insert, update, delete on warehouse.picks, warehouse.pick_lines to authenticated;
grant all on warehouse.settings, warehouse.picks, warehouse.pick_lines to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['settings', 'picks', 'pick_lines'] loop
    execute format($p$create policy via_process_insert on warehouse.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')$p$, t);
    execute format($p$create policy via_process_update on warehouse.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')$p$, t);
  end loop;
  foreach t in array array['picks', 'pick_lines'] loop
    execute format($p$create policy via_process_delete on warehouse.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')$p$, t);
  end loop;
end;
$$;

-- Eliminar (D1): only a Borrador (never numbered), whoever issues the statement.
create or replace function warehouse.document_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'erp:invalid_input:Solo se elimina un documento en Borrador';
  end if;
  return old;
end;
$$;
create trigger delete_draft_only before delete on warehouse.picks for each row execute function warehouse.document_delete_draft_only();

-- An alistamiento's lines change while it is open or in progress and not voided: once confirmed (or voided) what was taken does not change.
create or replace function warehouse.pick_lines_locked() returns trigger
language plpgsql
as $$
declare
  v_pick uuid := case when tg_op = 'DELETE' then old.pick_id else new.pick_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from warehouse.picks where id = v_pick;
  if v_status = 'voided' then
    raise exception 'erp:invalid_input:Las líneas de un alistamiento anulado no cambian';
  end if;
  if v_stage = 'confirmed' then
    raise exception 'erp:invalid_input:Las líneas de un alistamiento confirmado no cambian';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger pick_lines_locked before insert or update or delete on warehouse.pick_lines
  for each row execute function warehouse.pick_lines_locked();

-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones work
-- from the migration on; and who an alistamiento names (a referenced maestro cannot be deleted, only set Activo = no).
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('warehouse.pick', 'warehouse', 'documento', 'warehouse', 'picks', 'warehouse.pick_line')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',          'warehouse', 'picks',      'party_id');
select kernel.register_reference('inventory.warehouse', 'warehouse', 'picks',      'warehouse_id');
select kernel.register_reference('core.product',        'warehouse', 'pick_lines', 'product_id');
select kernel.register_reference('inventory.location',  'warehouse', 'pick_lines', 'location_id');
select kernel.register_reference('inventory.lot',       'warehouse', 'pick_lines', 'lot_id');
select kernel.register_reference('inventory.serial',    'warehouse', 'pick_lines', 'serial_id');

-- =============================================================================================
-- sales: the pedido lines as published for an alistamiento (rule 3)
-- =============================================================================================
-- What warehouse.pick.create reads of a pedido: its number, customer, bodega, stage, status and confirmation time, and per line the product,
-- the quantity and what the entregas that are not voided already take of it (committed_qty: what is left to pick is qty - committed_qty).
-- security_invoker: sales' RLS applies as the caller (company, the salesperson's own pedidos). Deliberately unmasked, like
-- sales.v_invoice_order_lines: the alistamiento's own masked views govern what the caller sees of it.
create or replace view sales.v_pick_order_lines with (security_invoker = true) as
select l.id, l.company_id, l.order_id, o.number as order_number, o.party_id, o.warehouse_id, o.stage as order_stage, o.status as order_status,
       o.confirmed_at, l.line_no, l.product_id, l.qty,
       coalesce((select sum(dl.qty) from sales.delivery_lines dl join sales.deliveries d on d.id = dl.delivery_id
                 where dl.order_line_id = l.id and d.status <> 'voided'), 0)::numeric(18,4) as committed_qty
from sales.order_lines l join sales.orders o on o.id = l.order_id;
grant select on sales.v_pick_order_lines to authenticated;
comment on view sales.v_pick_order_lines is
  'Published for warehouse (rule 3): the pedido lines an alistamiento picks, with what the entregas not voided already take. Unmasked, security_invoker.';

-- =============================================================================================
-- inventory: the release of a reservation drops its allocations (Task 29.1)
-- =============================================================================================
-- inventory.reservation.allocate replaces the allocations of the reservations it allocates, and inventory.reservation.release deletes them
-- once the reservation is released; both are inventory processes (the same restrictive gate as 0162's insert and update). The row audit
-- keeps every deleted allocation.
grant delete on inventory.reservation_allocations to authenticated;
create policy via_process_delete on inventory.reservation_allocations as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%');

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/warehouse/src/entities.ts and pasted here; the entities test fails when they drift.
-- =============================================================================================

create or replace view warehouse.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('warehouse.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('warehouse.settings', 'auto_pick_on_confirm')) then "auto_pick_on_confirm" else null end as "auto_pick_on_confirm",
  case when (select kernel.field_visible('warehouse.settings', 'delivery_from_pick')) then "delivery_from_pick" else null end as "delivery_from_pick",
  case when (select kernel.field_visible('warehouse.settings', 'extra')) then kernel.mask_extra('warehouse.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('warehouse.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from warehouse.settings;
grant select on warehouse.v_settings to authenticated;

create or replace view warehouse.v_picks with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('warehouse.pick', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('warehouse.pick', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('warehouse.pick', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('warehouse.pick', 'order_number')) then "order_number" else null end as "order_number",
  case when (select kernel.field_visible('warehouse.pick', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('warehouse.pick', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('warehouse.pick', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('warehouse.pick', 'picker_user_id')) then "picker_user_id" else null end as "picker_user_id",
  case when (select kernel.field_visible('warehouse.pick', 'started_at')) then "started_at" else null end as "started_at",
  case when (select kernel.field_visible('warehouse.pick', 'confirmed_at')) then "confirmed_at" else null end as "confirmed_at",
  case when (select kernel.field_visible('warehouse.pick', 'allocation_status')) then "allocation_status" else null end as "allocation_status",
  case when (select kernel.field_visible('warehouse.pick', 'allocated_at')) then "allocated_at" else null end as "allocated_at",
  case when (select kernel.field_visible('warehouse.pick', 'allocation_note')) then "allocation_note" else null end as "allocation_note",
  case when (select kernel.field_visible('warehouse.pick', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('warehouse.pick', 'extra')) then kernel.mask_extra('warehouse.pick', "extra") else null end as "extra",
  case when (select kernel.field_visible('warehouse.pick', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('warehouse.pick', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('warehouse.pick', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('warehouse.pick', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('warehouse.pick', 'void_reason')) then "void_reason" else null end as "void_reason"
from warehouse.picks;
grant select on warehouse.v_picks to authenticated;

create or replace view warehouse.v_pick_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('warehouse.pick_line', 'pick_id')) then "pick_id" else null end as "pick_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('warehouse.pick_line', 'order_line_id')) then "order_line_id" else null end as "order_line_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'qty_requested')) then "qty_requested" else null end as "qty_requested",
  case when (select kernel.field_visible('warehouse.pick_line', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'lot_id')) then "lot_id" else null end as "lot_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'serial_id')) then "serial_id" else null end as "serial_id",
  case when (select kernel.field_visible('warehouse.pick_line', 'qty_picked')) then "qty_picked" else null end as "qty_picked",
  case when (select kernel.field_visible('warehouse.pick_line', 'short_qty')) then "short_qty" else null end as "short_qty",
  case when (select kernel.field_visible('warehouse.pick_line', 'extra')) then kernel.mask_extra('warehouse.pick_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('warehouse.pick_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from warehouse.pick_lines;
grant select on warehouse.v_pick_lines to authenticated;

