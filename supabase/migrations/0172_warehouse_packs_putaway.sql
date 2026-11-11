-- 0172_warehouse_packs_putaway
-- Forward-only migration (rule 34). Covered by packages/modules/warehouse/src/__tests__/pack.integration.test.ts (the empaques),
-- packages/modules/warehouse/src/__tests__/putaway.integration.test.ts (the Reglas de ubicación) and
-- packages/modules/warehouse/src/__tests__/entities.test.ts (the masked views match the entities).
-- Plan 2B.2 Task 29.3 (PG §4.2, §4.3 steps 6 and 8; owner items 154, 155): packing and put-away of the warehouse module.
--   * warehouse.packs (empaques: a documento numbered EMP- on save that never posts and never waits for approval; it gates nothing) with
--     warehouse.pack_packages (one package: number, weight in kg, dimensions, and what it holds of the alistamiento's lines, `items`
--     [{ pickLineId, qty }], with `contents`, the same in words for the «Lista de empaque»);
--   * warehouse.putaway_rules (Reglas de ubicación, parametro: in a bodega, a category's goods, or any goods, go to a ubicación; the
--     lowest priority wins).
-- Bins are inventory locations (item 151): a rule names inventory's bodega and ubicación and core's category by id, read through their
-- published views; no foreign key leaves the schema (rule 3). Every table: uuid v7, company, seq, extra / extra_free, audit columns,
-- company RLS, row audit, and writes only through the module's processes (restrictive policies on erp.audit_process_id).

-- =============================================================================================
-- Empaques
-- =============================================================================================
create table warehouse.packs (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  number           text,
  pick_id          uuid not null references warehouse.picks (id),
  pick_number      text,
  order_id         uuid not null,
  order_number     text,
  warehouse_id     uuid not null,
  party_id         uuid not null,
  stage            text not null default 'open' check (stage in ('open', 'closed')),
  packages_count   int not null default 0 check (packages_count >= 0),
  total_weight_kg  numeric(18,4) check (total_weight_kg is null or total_weight_kg >= 0),
  closed_at        timestamptz,
  notes            text check (notes is null or char_length(notes) <= 2000),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check (stage <> 'closed' or closed_at is not null)
);
create index packs_pick_idx on warehouse.packs (company_id, pick_id);

create table warehouse.pack_packages (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  pack_id     uuid not null references warehouse.packs (id),
  package_no  int not null check (package_no > 0),
  weight_kg   numeric(18,4) check (weight_kg is null or weight_kg >= 0),
  dimensions  text check (dimensions is null or char_length(dimensions) <= 100),
  items       jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  contents    text check (contents is null or char_length(contents) <= 4000),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  unique (pack_id, package_no)
);

-- =============================================================================================
-- Reglas de ubicación
-- =============================================================================================
create table warehouse.putaway_rules (
  id           uuid primary key default kernel.uuid_v7(),
  seq          bigint not null,
  company_id   uuid not null references kernel.companies (id),
  warehouse_id uuid not null,
  category_id  uuid,
  location_id  uuid not null,
  priority     int not null check (priority between 0 and 9999),
  extra        jsonb not null default '{}'::jsonb,
  extra_free   jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default kernel.current_user_id(),
  updated_by   uuid,
  unique (company_id, seq)
);
-- One rule per bodega, category (or any) and ubicación.
create unique index putaway_rules_unique on warehouse.putaway_rules (company_id, warehouse_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), location_id);
create index putaway_rules_warehouse_idx on warehouse.putaway_rules (company_id, warehouse_id, priority);

-- =============================================================================================
-- Company RLS (rule 12), row audit (rule 16), seq (rule 7), touch, the typed lifecycle (entity types spec §5)
-- =============================================================================================
select kernel.enable_company_rls('warehouse', 'packs');
select kernel.enable_company_rls('warehouse', 'pack_packages');
select kernel.enable_company_rls('warehouse', 'putaway_rules');
select kernel.enable_row_audit('warehouse', 'packs');
select kernel.enable_row_audit('warehouse', 'pack_packages');
select kernel.enable_row_audit('warehouse', 'putaway_rules');
create trigger assign_seq before insert on warehouse.packs         for each row execute function core.assign_seq('warehouse.pack');
create trigger assign_seq before insert on warehouse.pack_packages for each row execute function core.assign_seq('warehouse.pack_package');
create trigger assign_seq before insert on warehouse.putaway_rules for each row execute function core.assign_seq('warehouse.putaway_rule');
create trigger touch_row before update on warehouse.packs         for each row execute function core.touch_row();
create trigger touch_row before update on warehouse.pack_packages for each row execute function core.touch_row();
create trigger touch_row before update on warehouse.putaway_rules for each row execute function core.touch_row();

-- The empaque's state columns, the flags copied at insert (warehouse sets them itself: never approval, never posting) and the record-access
-- read policy; the packages inherit the empaque's read right.
select kernel.typed_columns('warehouse', 'packs', 'documento', 'warehouse.pack');
select kernel.typed_lines('warehouse', 'pack_packages', 'warehouse.pack', 'pack_id');

-- One empaque not voided per alistamiento (warehouse.pack.create answers the open one).
create unique index packs_one_per_pick on warehouse.packs (company_id, pick_id) where status <> 'voided';

-- Grants: the handlers run as the caller. An update rewrites the packages of an open empaque; a rule is deleted by its process.
grant select, insert, update, delete on warehouse.packs, warehouse.pack_packages, warehouse.putaway_rules to authenticated;
grant all on warehouse.packs, warehouse.pack_packages, warehouse.putaway_rules to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['packs', 'pack_packages', 'putaway_rules'] loop
    execute format($p$create policy via_process_insert on warehouse.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')$p$, t);
    execute format($p$create policy via_process_update on warehouse.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')$p$, t);
    execute format($p$create policy via_process_delete on warehouse.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%%')$p$, t);
  end loop;
end;
$$;

-- Eliminar (D1): only a Borrador (never numbered) empaque, whoever issues the statement (0170's function).
create trigger delete_draft_only before delete on warehouse.packs for each row execute function warehouse.document_delete_draft_only();

-- An empaque's packages change while it is open and not voided: once closed (or voided) what was packed does not change.
create or replace function warehouse.pack_packages_locked() returns trigger
language plpgsql
as $$
declare
  v_pack uuid := case when tg_op = 'DELETE' then old.pack_id else new.pack_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from warehouse.packs where id = v_pack;
  if v_status = 'voided' then
    raise exception 'erp:invalid_input:Los paquetes de un empaque anulado no cambian';
  end if;
  if v_stage = 'closed' then
    raise exception 'erp:invalid_input:Los paquetes de un empaque cerrado no cambian';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger pack_packages_locked before insert or update or delete on warehouse.pack_packages
  for each row execute function warehouse.pack_packages_locked();

-- The entity -> table rows syncModuleManifest also writes (an upsert there); and who an empaque or a rule names (a referenced maestro
-- cannot be deleted, only set Activo = no).
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('warehouse.pack', 'warehouse', 'documento', 'warehouse', 'packs', 'warehouse.pack_package')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',            'warehouse', 'packs',         'party_id');
select kernel.register_reference('inventory.warehouse',   'warehouse', 'packs',         'warehouse_id');
select kernel.register_reference('inventory.warehouse',   'warehouse', 'putaway_rules', 'warehouse_id');
select kernel.register_reference('inventory.location',    'warehouse', 'putaway_rules', 'location_id');
select kernel.register_reference('core.product_category', 'warehouse', 'putaway_rules', 'category_id');

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/warehouse/src/entities.ts and pasted here; the entities test fails when they drift.
-- =============================================================================================

create or replace view warehouse.v_packs with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('warehouse.pack', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('warehouse.pack', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('warehouse.pack', 'pick_id')) then "pick_id" else null end as "pick_id",
  case when (select kernel.field_visible('warehouse.pack', 'pick_number')) then "pick_number" else null end as "pick_number",
  case when (select kernel.field_visible('warehouse.pack', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('warehouse.pack', 'order_number')) then "order_number" else null end as "order_number",
  case when (select kernel.field_visible('warehouse.pack', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('warehouse.pack', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('warehouse.pack', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('warehouse.pack', 'packages_count')) then "packages_count" else null end as "packages_count",
  case when (select kernel.field_visible('warehouse.pack', 'total_weight_kg')) then "total_weight_kg" else null end as "total_weight_kg",
  case when (select kernel.field_visible('warehouse.pack', 'closed_at')) then "closed_at" else null end as "closed_at",
  case when (select kernel.field_visible('warehouse.pack', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('warehouse.pack', 'extra')) then kernel.mask_extra('warehouse.pack', "extra") else null end as "extra",
  case when (select kernel.field_visible('warehouse.pack', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('warehouse.pack', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('warehouse.pack', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('warehouse.pack', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('warehouse.pack', 'void_reason')) then "void_reason" else null end as "void_reason"
from warehouse.packs;
grant select on warehouse.v_packs to authenticated;

create or replace view warehouse.v_pack_packages with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('warehouse.pack_package', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('warehouse.pack_package', 'pack_id')) then "pack_id" else null end as "pack_id",
  case when (select kernel.field_visible('warehouse.pack_package', 'package_no')) then "package_no" else null end as "package_no",
  case when (select kernel.field_visible('warehouse.pack_package', 'weight_kg')) then "weight_kg" else null end as "weight_kg",
  case when (select kernel.field_visible('warehouse.pack_package', 'dimensions')) then "dimensions" else null end as "dimensions",
  case when (select kernel.field_visible('warehouse.pack_package', 'items')) then "items" else null end as "items",
  case when (select kernel.field_visible('warehouse.pack_package', 'contents')) then "contents" else null end as "contents",
  case when (select kernel.field_visible('warehouse.pack_package', 'extra')) then kernel.mask_extra('warehouse.pack_package', "extra") else null end as "extra",
  case when (select kernel.field_visible('warehouse.pack_package', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from warehouse.pack_packages;
grant select on warehouse.v_pack_packages to authenticated;

create or replace view warehouse.v_putaway_rules with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'location_id')) then "location_id" else null end as "location_id",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'priority')) then "priority" else null end as "priority",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'extra')) then kernel.mask_extra('warehouse.putaway_rule', "extra") else null end as "extra",
  case when (select kernel.field_visible('warehouse.putaway_rule', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from warehouse.putaway_rules;
grant select on warehouse.v_putaway_rules to authenticated;
