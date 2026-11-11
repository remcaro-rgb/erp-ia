-- 0073_costing_core
-- Forward-only migration (rule 34). Covered by packages/modules/costing/src/__tests__/average.integration.test.ts, cogs.integration.test.ts
-- and entities.test.ts (the masked views match the entity definitions).
-- The costing module (design §8, §8.1, plan 2B Task 8): the weighted average cost of every product per bodega (cost layers), one cost
-- event per inventory movement line (its valuation), the products issued without a cost (cost_missing, main §5.8b: never a gate on
-- invoice_ready), the feed position that keeps the valuation in the inventory's own order, and the settings row whose `method` accepts only
-- `average` in 2B (OD-5; Task 9 adds its process, phase 3 adds `fifo` by widening the check: the layers carry `method` and the FIFO
-- columns already, so no data migration). Rule 3: no foreign key leaves the schema (product, bodega and movement ids are core's and
-- inventory's, read through inventory.movement_feed, migration 0074, and core.v_product_stock). Every company table: uuid v7, company,
-- seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the costing processes.

create schema if not exists costing;
grant usage on schema costing to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Capas de costo. One `average` layer per product and bodega: qty as costing knows it, its value and the weighted average cost (null
-- until the first cost). Money (rule 8) in the company currency (`currency`; the movements carry rate 1). FIFO (phase 3) opens one layer
-- per receipt line (`source_line_id`, `opened_on`) with `method = fifo`, beside these rows.
-- ---------------------------------------------------------------------------------------------
create table costing.cost_layers (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  product_id        uuid not null,
  warehouse_id      uuid not null,
  method            text not null default 'average' check (method in ('average')),
  source_line_id    uuid,
  opened_on         date,
  qty               numeric(18,4) not null default 0,
  value             numeric(18,4) not null default 0,
  avg_cost          numeric(18,4) check (avg_cost is null or avg_cost >= 0),
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  last_movement_id  uuid,
  last_movement_seq bigint,
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  -- A layer holding units is never worth less than nothing (a negative average cost is refused).
  check (qty <= 0 or value >= 0)
);
create unique index cost_layers_average_key on costing.cost_layers (company_id, product_id, warehouse_id) where method = 'average';

-- Eventos de costo: the valuation of one inventory movement line, in the movement's order (`movement_seq`, inventory's gap-free seq).
-- Signed: qty and amount are + into the layer, − out of it. One per movement line (redelivery finds it). `cogs_posted_at` is when the
-- line's cost of sales left in costing.cogs.posted (sale issues only).
create table costing.cost_events (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  movement_id       uuid not null,
  movement_line_id  uuid not null,
  movement_seq      bigint not null,
  movement_number   text,
  kind              text not null check (kind in ('receipt', 'issue', 'sale_issue', 'sale_return', 'adjustment', 'transfer_out', 'transfer_in')),
  date              date not null,
  product_id        uuid not null,
  category_id       uuid,
  warehouse_id      uuid not null,
  layer_id          uuid not null references costing.cost_layers (id),
  qty               numeric(18,4) not null check (qty <> 0),
  unit_cost         numeric(18,4) not null check (unit_cost >= 0),
  amount            numeric(18,4) not null,
  cost_source       text not null check (cost_source in ('line', 'average', 'standard', 'original_issue', 'transfer', 'none')),
  cost_missing      boolean not null default false,
  qty_after         numeric(18,4) not null,
  value_after       numeric(18,4) not null,
  avg_after         numeric(18,4) check (avg_after is null or avg_after >= 0),
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  exchange_rate     numeric(18,6) not null default 1 check (exchange_rate > 0),
  source_entity     text,
  source_id         uuid,
  source_line_id    uuid,
  return_of_line_id uuid,
  cogs_posted_at    timestamptz,
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, movement_line_id),
  -- The sign of the amount follows the quantity's (a zero amount is a line valued at 0).
  check (amount = 0 or sign(amount) = sign(qty)),
  check (cogs_posted_at is null or kind = 'sale_issue')
);
create index cost_events_movement_idx on costing.cost_events (company_id, movement_id);
create index cost_events_layer_idx on costing.cost_events (layer_id, movement_seq);
create index cost_events_source_idx on costing.cost_events (company_id, source_id, kind) where source_id is not null;

-- Productos sin costo: one open row per product and bodega while it is valued at 0; a later entry that brings a cost resolves it.
create table costing.cost_missing (
  id                   uuid primary key default kernel.uuid_v7(),
  seq                  bigint not null,
  company_id           uuid not null references kernel.companies (id),
  product_id           uuid not null,
  warehouse_id         uuid not null,
  status               text not null default 'open' check (status in ('open', 'resolved')),
  occurrences          integer not null default 1 check (occurrences > 0),
  qty                  numeric(18,4) not null default 0 check (qty >= 0),
  first_movement_id    uuid not null,
  last_movement_id     uuid not null,
  first_date           date not null,
  last_date            date not null,
  resolved_at          timestamptz,
  resolved_movement_id uuid,
  extra                jsonb not null default '{}'::jsonb,
  extra_free           jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid default kernel.current_user_id(),
  updated_by           uuid,
  unique (company_id, seq),
  check ((status = 'resolved') = (resolved_at is not null))
);
create unique index cost_missing_open_key on costing.cost_missing (company_id, product_id, warehouse_id) where status = 'open';

-- Parámetros de costos (Task 9 adds the entity and its process; no row is written here: a company without one costs by `average`).
create table costing.settings (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  method     text not null default 'average' check (method in ('average')),
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id)
);

-- The feed position: the next inventory movement seq to value. A system counter (an exception to rule 7, like inventory.movement_numbers:
-- no id / seq / audit of its own), written only by costing.movement.cost under the company's feed lock.
create table costing.feeds (
  company_id uuid primary key references kernel.companies (id),
  next_seq   bigint not null default 1 check (next_seq > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (core's shared trigger, rule 7) and the touch trigger.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('costing', 'cost_layers');
select kernel.enable_company_rls('costing', 'cost_events');
select kernel.enable_company_rls('costing', 'cost_missing');
select kernel.enable_company_rls('costing', 'settings');
select kernel.enable_company_rls('costing', 'feeds');
select kernel.enable_row_audit('costing', 'cost_layers');
select kernel.enable_row_audit('costing', 'cost_events');
select kernel.enable_row_audit('costing', 'cost_missing');
select kernel.enable_row_audit('costing', 'settings');

create trigger assign_seq before insert on costing.cost_layers  for each row execute function core.assign_seq('costing.cost_layer');
create trigger assign_seq before insert on costing.cost_events  for each row execute function core.assign_seq('costing.cost_event');
create trigger assign_seq before insert on costing.cost_missing for each row execute function core.assign_seq('costing.cost_missing');
create trigger assign_seq before insert on costing.settings     for each row execute function core.assign_seq('costing.settings');
create trigger touch_row before update on costing.cost_layers  for each row execute function core.touch_row();
create trigger touch_row before update on costing.cost_events  for each row execute function core.touch_row();
create trigger touch_row before update on costing.cost_missing for each row execute function core.touch_row();
create trigger touch_row before update on costing.settings     for each row execute function core.touch_row();

-- A cost event is the valuation of a movement that already happened: once written, only its COGS mark changes.
create or replace function costing.cost_events_frozen() returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['cogs_posted_at', 'updated_at', 'updated_by']) is distinct from (to_jsonb(old) - array['cogs_posted_at', 'updated_at', 'updated_by']) then
    raise exception 'erp:invalid_input:Un evento de costo no cambia: es la valoración de un movimiento registrado';
  end if;
  return new;
end;
$$;
create trigger cost_events_frozen before update on costing.cost_events for each row execute function costing.cost_events_frozen();

-- Grants: the handlers run as the caller. Nothing is deleted (sistema rows are the history of the valuation).
grant select, insert, update on costing.cost_layers, costing.cost_events, costing.cost_missing, costing.settings, costing.feeds to authenticated;
grant all on costing.cost_layers, costing.cost_events, costing.cost_missing, costing.settings, costing.feeds to service_role;

-- Writes only through the process pipeline (rule 1): runProcess sets erp.audit_process_id for its transaction.
do $$
declare
  t text;
begin
  foreach t in array array['cost_layers', 'cost_events', 'cost_missing', 'settings', 'feeds'] loop
    execute format($p$create policy via_process_insert on costing.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')$p$, t);
    execute format($p$create policy via_process_update on costing.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')$p$, t);
  end loop;
end;
$$;

-- Who uses a product or a bodega (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no.
select kernel.register_reference('core.product',        'costing', 'cost_layers',  'product_id');
select kernel.register_reference('core.product',        'costing', 'cost_events',  'product_id');
select kernel.register_reference('core.product',        'costing', 'cost_missing', 'product_id');
select kernel.register_reference('inventory.warehouse', 'costing', 'cost_layers',  'warehouse_id');
select kernel.register_reference('inventory.warehouse', 'costing', 'cost_events',  'warehouse_id');
select kernel.register_reference('inventory.warehouse', 'costing', 'cost_missing', 'warehouse_id');

-- ---------------------------------------------------------------------------------------------
-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and kernel.notify_custom_field_changed, 0008,
-- raise when the module has none). Costing records derive nothing from their files or their extra data: both are no-ops.
-- ---------------------------------------------------------------------------------------------
create or replace function costing.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function costing.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function costing.attachments_changed(text, uuid, uuid) to service_role;

create or replace function costing.custom_field_changed(p_entity text, p_company uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function costing.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function costing.custom_field_changed(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The weighted average of products in a bodega, for inventory's valuation of an adjustment (plan 2B Task 7 carry-over): a computation,
-- not a display, so it does not depend on whether the caller's role may see the cost (rule 14 governs what is shown). It answers only
-- inside an inventory or costing process run (erp.audit_process_id), only for the caller's active company, and only layers with a cost.
-- ---------------------------------------------------------------------------------------------
create or replace function costing.average_costs(p_warehouse uuid, p_ids uuid[]) returns table (product_id uuid, avg_cost numeric)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'inventory.%'
     and coalesce(current_setting('erp.audit_process_id', true), '') not like 'costing.%' then
    raise exception 'costing.average_costs is read only inside an inventory or costing process' using errcode = 'insufficient_privilege';
  end if;
  return query
    select l.product_id, l.avg_cost
    from costing.cost_layers l
    where l.company_id = kernel.current_company_id()
      and array[l.company_id] <@ kernel.current_company_ids()
      and l.method = 'average'
      and l.warehouse_id = p_warehouse
      and l.product_id = any (p_ids)
      and l.avg_cost is not null and l.avg_cost > 0;
end;
$$;
revoke execute on function costing.average_costs(uuid, uuid[]) from public, anon;
grant execute on function costing.average_costs(uuid, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/costing/src/entities.ts and pasted here; entities.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------

create or replace view costing.v_cost_layers with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.cost_layer', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.cost_layer', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('costing.cost_layer', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('costing.cost_layer', 'method')) then "method" else null end as "method",
  case when (select kernel.field_visible('costing.cost_layer', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('costing.cost_layer', 'value')) then "value" else null end as "value",
  case when (select kernel.field_visible('costing.cost_layer', 'avg_cost')) then "avg_cost" else null end as "avg_cost",
  case when (select kernel.field_visible('costing.cost_layer', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('costing.cost_layer', 'last_movement_id')) then "last_movement_id" else null end as "last_movement_id",
  case when (select kernel.field_visible('costing.cost_layer', 'last_movement_seq')) then "last_movement_seq" else null end as "last_movement_seq",
  case when (select kernel.field_visible('costing.cost_layer', 'extra')) then kernel.mask_extra('costing.cost_layer', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.cost_layer', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.cost_layers;
grant select on costing.v_cost_layers to authenticated;

create or replace view costing.v_cost_events with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.cost_event', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.cost_event', 'movement_id')) then "movement_id" else null end as "movement_id",
  case when (select kernel.field_visible('costing.cost_event', 'movement_line_id')) then "movement_line_id" else null end as "movement_line_id",
  case when (select kernel.field_visible('costing.cost_event', 'movement_seq')) then "movement_seq" else null end as "movement_seq",
  case when (select kernel.field_visible('costing.cost_event', 'movement_number')) then "movement_number" else null end as "movement_number",
  case when (select kernel.field_visible('costing.cost_event', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('costing.cost_event', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('costing.cost_event', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('costing.cost_event', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('costing.cost_event', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('costing.cost_event', 'layer_id')) then "layer_id" else null end as "layer_id",
  case when (select kernel.field_visible('costing.cost_event', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('costing.cost_event', 'unit_cost')) then "unit_cost" else null end as "unit_cost",
  case when (select kernel.field_visible('costing.cost_event', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('costing.cost_event', 'cost_source')) then "cost_source" else null end as "cost_source",
  case when (select kernel.field_visible('costing.cost_event', 'cost_missing')) then "cost_missing" else null end as "cost_missing",
  case when (select kernel.field_visible('costing.cost_event', 'qty_after')) then "qty_after" else null end as "qty_after",
  case when (select kernel.field_visible('costing.cost_event', 'value_after')) then "value_after" else null end as "value_after",
  case when (select kernel.field_visible('costing.cost_event', 'avg_after')) then "avg_after" else null end as "avg_after",
  case when (select kernel.field_visible('costing.cost_event', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('costing.cost_event', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('costing.cost_event', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('costing.cost_event', 'source_id')) then "source_id" else null end as "source_id",
  case when (select kernel.field_visible('costing.cost_event', 'source_line_id')) then "source_line_id" else null end as "source_line_id",
  case when (select kernel.field_visible('costing.cost_event', 'return_of_line_id')) then "return_of_line_id" else null end as "return_of_line_id",
  case when (select kernel.field_visible('costing.cost_event', 'cogs_posted_at')) then "cogs_posted_at" else null end as "cogs_posted_at",
  case when (select kernel.field_visible('costing.cost_event', 'extra')) then kernel.mask_extra('costing.cost_event', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.cost_event', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.cost_events;
grant select on costing.v_cost_events to authenticated;

create or replace view costing.v_cost_missing with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.cost_missing', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.cost_missing', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('costing.cost_missing', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('costing.cost_missing', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('costing.cost_missing', 'occurrences')) then "occurrences" else null end as "occurrences",
  case when (select kernel.field_visible('costing.cost_missing', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('costing.cost_missing', 'first_movement_id')) then "first_movement_id" else null end as "first_movement_id",
  case when (select kernel.field_visible('costing.cost_missing', 'last_movement_id')) then "last_movement_id" else null end as "last_movement_id",
  case when (select kernel.field_visible('costing.cost_missing', 'first_date')) then "first_date" else null end as "first_date",
  case when (select kernel.field_visible('costing.cost_missing', 'last_date')) then "last_date" else null end as "last_date",
  case when (select kernel.field_visible('costing.cost_missing', 'resolved_at')) then "resolved_at" else null end as "resolved_at",
  case when (select kernel.field_visible('costing.cost_missing', 'resolved_movement_id')) then "resolved_movement_id" else null end as "resolved_movement_id",
  case when (select kernel.field_visible('costing.cost_missing', 'extra')) then kernel.mask_extra('costing.cost_missing', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.cost_missing', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.cost_missing;
grant select on costing.v_cost_missing to authenticated;

