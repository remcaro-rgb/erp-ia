-- 0162_inventory_lots_serials
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/lots.integration.test.ts and entities.test.ts
-- (the masked views match the entity definitions). Plan 2B.2 Task 28.1 (Part G design PG §3.1; owner items 145, 146; RG-2, RG-3):
--   * inventory.lots (maestro inventory.lot): a lot of one product, its code unique per product whatever its case (item 145), expiry and
--     production dates (FEFO, 28.3) and `lot_status` active | blocked. The maestro lifecycle `status` is kernel.typed_columns', so the
--     lot's own state has its own column.
--   * inventory.serials (maestro inventory.serial): one unit of a product, its number unique per product, optionally inside a lot of the
--     same product; `serial_status` available | issued | scrapped, kept by the movements (28.2), null until a receipt brings it.
--   * inventory.product_tracking (parametro): one row per product, tracking none | lot | serial, fefo, expiry_required, block_expired.
--     Inventory owns it because core.products is core's (rule 3).
--   * FKs from movement_lines and stock_levels lot_id / serial_id to the maestros, on (id, product_id): a line or bucket never names a lot
--     or serial of another product. Untracked rows keep both null (RG-2: byte for byte as before).
--   * The serial check on stock_levels (RG-3): a serial bucket holds 0 or 1.
--   * inventory.movements.party_id (core ref, nullable): the customer a sale issue or return answers to (recall, PG §3.6; filled in 28.3).
--   * inventory.reservation_allocations (sistema): where, from which lot and serial a reservation will be picked; empty until 29.1
--     (written only by inventory.reservation.allocate).
--   Every new table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the
--   inventory processes (restrictive policies on erp.audit_process_id).

-- ---------------------------------------------------------------------------------------------
-- Lotes
-- ---------------------------------------------------------------------------------------------
create table inventory.lots (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  product_id  uuid not null,
  code        text not null check (char_length(btrim(code)) between 1 and 60),
  expires_on  date,
  produced_on date,
  lot_status  text not null default 'active' check (lot_status in ('active', 'blocked')),
  note        text check (note is null or char_length(note) <= 500),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  unique (id, product_id),
  check (produced_on is null or expires_on is null or produced_on <= expires_on)
);
create index lots_product_idx on inventory.lots (company_id, product_id, expires_on);

-- ---------------------------------------------------------------------------------------------
-- Seriales
-- ---------------------------------------------------------------------------------------------
create table inventory.serials (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  product_id    uuid not null,
  serial_no     text not null check (char_length(btrim(serial_no)) between 1 and 80),
  lot_id        uuid,
  serial_status text check (serial_status is null or serial_status in ('available', 'issued', 'scrapped')),
  note          text check (note is null or char_length(note) <= 500),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (id, product_id),
  foreign key (lot_id, product_id) references inventory.lots (id, product_id)
);
create index serials_product_idx on inventory.serials (company_id, product_id);
create index serials_lot_idx on inventory.serials (lot_id) where lot_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Seguimiento por producto (parametro). A product without a row is untracked (none, fefo, expiry not required, expired blocked).
-- ---------------------------------------------------------------------------------------------
create table inventory.product_tracking (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  product_id      uuid not null,
  tracking        text not null default 'none' check (tracking in ('none', 'lot', 'serial')),
  fefo            boolean not null default true,
  expiry_required boolean not null default false,
  block_expired   boolean not null default true,
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  unique (company_id, product_id)
);

-- ---------------------------------------------------------------------------------------------
-- The line and stock columns of 0066 now name the maestros (same schema: allowed, rule 3). Composite on the product, so a lot or serial
-- of another product is refused by the database too. The serial bucket holds 0 or 1 (RG-3).
-- ---------------------------------------------------------------------------------------------
alter table inventory.movement_lines
  add constraint movement_lines_lot_fkey foreign key (lot_id, product_id) references inventory.lots (id, product_id),
  add constraint movement_lines_serial_fkey foreign key (serial_id, product_id) references inventory.serials (id, product_id);
alter table inventory.stock_levels
  add constraint stock_levels_lot_fkey foreign key (lot_id, product_id) references inventory.lots (id, product_id),
  add constraint stock_levels_serial_fkey foreign key (serial_id, product_id) references inventory.serials (id, product_id),
  add constraint stock_levels_serial_qty_check check (serial_id is null or on_hand between 0 and 1);
create index movement_lines_lot_idx on inventory.movement_lines (lot_id) where lot_id is not null;
create index movement_lines_serial_idx on inventory.movement_lines (serial_id) where serial_id is not null;

-- The customer a movement answers to (core ref, no FK across schemas).
alter table inventory.movements add column party_id uuid;
create index movements_party_idx on inventory.movements (company_id, party_id) where party_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Asignaciones de una reserva (sistema, Task 29.1 writes them). One reservation may be split over several lots; the one-active-row-per-
-- source-line index of the reservations stays.
-- ---------------------------------------------------------------------------------------------
create table inventory.reservation_allocations (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  reservation_id uuid not null references inventory.reservations (id),
  location_id    uuid references inventory.locations (id),
  lot_id         uuid references inventory.lots (id),
  serial_id      uuid references inventory.serials (id),
  qty            numeric(18,4) not null check (qty > 0),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  check (serial_id is null or qty = 1)
);
create index reservation_allocations_reservation_idx on inventory.reservation_allocations (reservation_id);

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), seq (rule 7), touch.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('inventory', 'lots');
select kernel.enable_company_rls('inventory', 'serials');
select kernel.enable_company_rls('inventory', 'product_tracking');
select kernel.enable_company_rls('inventory', 'reservation_allocations');
select kernel.enable_row_audit('inventory', 'lots');
select kernel.enable_row_audit('inventory', 'serials');
select kernel.enable_row_audit('inventory', 'product_tracking');
select kernel.enable_row_audit('inventory', 'reservation_allocations');

create trigger assign_seq before insert on inventory.lots                    for each row execute function core.assign_seq('inventory.lot');
create trigger assign_seq before insert on inventory.serials                 for each row execute function core.assign_seq('inventory.serial');
create trigger assign_seq before insert on inventory.product_tracking        for each row execute function core.assign_seq('inventory.product_tracking');
create trigger assign_seq before insert on inventory.reservation_allocations for each row execute function core.assign_seq('inventory.reservation_allocation');
create trigger touch_row before update on inventory.lots                    for each row execute function core.touch_row();
create trigger touch_row before update on inventory.serials                 for each row execute function core.touch_row();
create trigger touch_row before update on inventory.product_tracking        for each row execute function core.touch_row();
create trigger touch_row before update on inventory.reservation_allocations for each row execute function core.touch_row();

-- The typed lifecycle of the two maestros (entity types spec §5): status, Requiere aprobación, Activo, deleted_at, record access.
select kernel.typed_columns('inventory', 'lots', 'maestro', 'inventory.lot');
select kernel.typed_columns('inventory', 'serials', 'maestro', 'inventory.serial');

-- Codes are unique per product among the records not deleted, whatever their case (item 145).
create unique index lots_product_code_key on inventory.lots (company_id, product_id, lower(code)) where deleted_at is null;
create unique index serials_product_serial_key on inventory.serials (company_id, product_id, lower(serial_no)) where deleted_at is null;

grant select, insert, update on inventory.lots, inventory.serials, inventory.product_tracking, inventory.reservation_allocations to authenticated;
grant all on inventory.lots, inventory.serials, inventory.product_tracking, inventory.reservation_allocations to service_role;

-- Writes only through the process pipeline (rule 1), as 0066.
do $$
declare
  t text;
begin
  foreach t in array array['lots', 'serials', 'product_tracking', 'reservation_allocations'] loop
    execute format($p$create policy via_process_insert on inventory.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
    execute format($p$create policy via_process_update on inventory.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'inventory.%%')$p$, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows (syncModuleManifest upserts them too) and who uses a lot, a serial or a product: a referenced one cannot be
-- deleted, only set Activo = no.
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('inventory.lot',    'inventory', 'maestro', 'inventory', 'lots',    null),
  ('inventory.serial', 'inventory', 'maestro', 'inventory', 'serials', null)
on conflict (entity) do nothing;

select kernel.register_reference('inventory.lot',      'inventory', 'movement_lines',          'lot_id');
select kernel.register_reference('inventory.lot',      'inventory', 'stock_levels',            'lot_id');
select kernel.register_reference('inventory.lot',      'inventory', 'serials',                 'lot_id');
select kernel.register_reference('inventory.lot',      'inventory', 'reservation_allocations', 'lot_id');
select kernel.register_reference('inventory.serial',   'inventory', 'movement_lines',          'serial_id');
select kernel.register_reference('inventory.serial',   'inventory', 'stock_levels',            'serial_id');
select kernel.register_reference('inventory.serial',   'inventory', 'reservation_allocations', 'serial_id');
select kernel.register_reference('inventory.location', 'inventory', 'reservation_allocations', 'location_id');
select kernel.register_reference('core.product',       'inventory', 'lots',                    'product_id');
select kernel.register_reference('core.product',       'inventory', 'serials',                 'product_id');
select kernel.register_reference('core.product',       'inventory', 'product_tracking',        'product_id');
select kernel.register_reference('core.party',         'inventory', 'movements',               'party_id');

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/inventory/src/entities.ts and pasted here;
-- entities.test.ts fails when they drift. inventory.v_movements is re-created with party_id appended; v_lots, v_serials and
-- v_product_tracking are what the other modules read (published, field_visible). The maestros' views drop deleted rows.
-- ---------------------------------------------------------------------------------------------

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
  case when (select kernel.field_visible('inventory.movement', 'void_reason')) then "void_reason" else null end as "void_reason",
  case when (select kernel.field_visible('inventory.movement', 'party_id')) then "party_id" else null end as "party_id"
from inventory.movements;
grant select on inventory.v_movements to authenticated;
grant select on inventory.v_movements to authenticated;

create or replace view inventory.v_lots with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.lot', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.lot', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.lot', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('inventory.lot', 'expires_on')) then "expires_on" else null end as "expires_on",
  case when (select kernel.field_visible('inventory.lot', 'produced_on')) then "produced_on" else null end as "produced_on",
  case when (select kernel.field_visible('inventory.lot', 'lot_status')) then "lot_status" else null end as "lot_status",
  case when (select kernel.field_visible('inventory.lot', 'note')) then "note" else null end as "note",
  case when (select kernel.field_visible('inventory.lot', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('inventory.lot', 'extra')) then kernel.mask_extra('inventory.lot', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.lot', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.lot', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.lot', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from inventory.lots
where deleted_at is null;
grant select on inventory.v_lots to authenticated;
grant select on inventory.v_lots to authenticated;

create or replace view inventory.v_serials with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.serial', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.serial', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.serial', 'serial_no')) then "serial_no" else null end as "serial_no",
  case when (select kernel.field_visible('inventory.serial', 'lot_id')) then "lot_id" else null end as "lot_id",
  case when (select kernel.field_visible('inventory.serial', 'serial_status')) then "serial_status" else null end as "serial_status",
  case when (select kernel.field_visible('inventory.serial', 'note')) then "note" else null end as "note",
  case when (select kernel.field_visible('inventory.serial', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('inventory.serial', 'extra')) then kernel.mask_extra('inventory.serial', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.serial', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('inventory.serial', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('inventory.serial', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from inventory.serials
where deleted_at is null;
grant select on inventory.v_serials to authenticated;
grant select on inventory.v_serials to authenticated;

create or replace view inventory.v_product_tracking with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.product_tracking', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.product_tracking', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('inventory.product_tracking', 'tracking')) then "tracking" else null end as "tracking",
  case when (select kernel.field_visible('inventory.product_tracking', 'fefo')) then "fefo" else null end as "fefo",
  case when (select kernel.field_visible('inventory.product_tracking', 'expiry_required')) then "expiry_required" else null end as "expiry_required",
  case when (select kernel.field_visible('inventory.product_tracking', 'block_expired')) then "block_expired" else null end as "block_expired",
  case when (select kernel.field_visible('inventory.product_tracking', 'extra')) then kernel.mask_extra('inventory.product_tracking', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.product_tracking', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.product_tracking;
grant select on inventory.v_product_tracking to authenticated;
grant select on inventory.v_product_tracking to authenticated;

create or replace view inventory.v_reservation_allocations with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'reservation_id')) then "reservation_id" else null end as "reservation_id",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'lot_id')) then "lot_id" else null end as "lot_id",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'serial_id')) then "serial_id" else null end as "serial_id",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'extra')) then kernel.mask_extra('inventory.reservation_allocation', "extra") else null end as "extra",
  case when (select kernel.field_visible('inventory.reservation_allocation', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from inventory.reservation_allocations;
grant select on inventory.v_reservation_allocations to authenticated;
grant select on inventory.v_reservation_allocations to authenticated;

