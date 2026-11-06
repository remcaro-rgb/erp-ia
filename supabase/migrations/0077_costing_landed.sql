-- 0077_costing_landed
-- Forward-only migration (rule 34). Covered by packages/modules/costing/src/__tests__/landed-cost.integration.test.ts and
-- entities.test.ts (the masked views match the entity definitions).
-- Landed costs (plan 2B Task 9, design §8.1): freight, duties or insurance allocated to the lines of a receipt, which raises the value of
-- their cost layers. `costing.landed_costs` is a documento (contabiliza: Dr inventory / Cr the offset role the user names, through the
-- default rules the costing manifest ships) with `costing.landed_cost_lines` (what each receipt line was given). The allocation is recorded
-- in the layer as cost events of kind `landed_cost` (qty 0, amount = the line's share, positive; a void writes the same amounts negative),
-- so the layer's value stays the sum of its cost events' amounts (migration 0075). The costing method stays `average` (OD-5): the
-- `costing.settings` table and its check were shaped for the phase 3 FIFO in 0073; this migration only adds the entity's masked view.
-- Rule 3: no foreign key leaves the schema (the receipt and its lines are inventory's, product and bodega are core's / inventory's).

-- ---------------------------------------------------------------------------------------------
-- Cost events: the kind `landed_cost` moves value, not units, and has no movement line of its own (movement_line_id is generated).
-- ---------------------------------------------------------------------------------------------
comment on column costing.cost_events.movement_line_id is 'The inventory movement line valued; a landed_cost event has none of its own, so the id is generated (the receipt line is landed_cost_lines.movement_line_id).';
alter table costing.cost_events drop constraint cost_events_kind_check;
alter table costing.cost_events add constraint cost_events_kind_check
  check (kind in ('receipt', 'issue', 'sale_issue', 'sale_return', 'adjustment', 'transfer_out', 'transfer_in', 'landed_cost'));
alter table costing.cost_events drop constraint cost_events_cost_source_check;
alter table costing.cost_events add constraint cost_events_cost_source_check
  check (cost_source in ('line', 'average', 'standard', 'original_issue', 'transfer', 'none', 'landed_cost'));
alter table costing.cost_events drop constraint cost_events_qty_check;
alter table costing.cost_events add constraint cost_events_qty_check check ((kind = 'landed_cost') = (qty = 0));
alter table costing.cost_events drop constraint cost_events_check;
-- The sign of the amount follows the quantity's; a landed cost has no quantity and its amount takes either sign (a void takes it back).
alter table costing.cost_events add constraint cost_events_amount_sign_check check (kind = 'landed_cost' or amount = 0 or sign(amount) = sign(qty));

-- ---------------------------------------------------------------------------------------------
-- Costo en destino.
-- ---------------------------------------------------------------------------------------------
create table costing.landed_costs (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  number          text,
  date            date not null,
  -- The receipt (inventory.movement of kind receipt) the cost is allocated to.
  movement_id     uuid not null,
  movement_number text,
  basis           text not null check (basis in ('value', 'quantity', 'weight')),
  amount          numeric(18,4) not null check (amount > 0),
  offset_role     text not null check (offset_role in ('payable', 'supplier_advances', 'cash', 'bank', 'suspense')),
  -- The supplier (core.party) whose bill it is: required by the process for the roles that are owed to someone (payable, advances).
  party_id        uuid,
  reference       text check (reference is null or char_length(reference) <= 100),
  description     text check (description is null or char_length(description) <= 500),
  currency        text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  applied_at      timestamptz,
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  unique (company_id, number)
);
create index landed_costs_movement_idx on costing.landed_costs (company_id, movement_id);
create index landed_costs_company_date_idx on costing.landed_costs (company_id, date);

create table costing.landed_cost_lines (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  landed_cost_id   uuid not null references costing.landed_costs (id),
  line_no          int not null check (line_no > 0),
  movement_line_id uuid not null,
  product_id       uuid not null,
  warehouse_id     uuid not null,
  qty              numeric(18,4) not null check (qty > 0),
  base             numeric(18,4) not null check (base >= 0),
  weight           numeric(18,4) check (weight is null or weight >= 0),
  amount           numeric(18,4) not null check (amount >= 0),
  unit_cost_added  numeric(18,4) not null check (unit_cost_added >= 0),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  unique (landed_cost_id, line_no)
);
create index landed_cost_lines_line_idx on costing.landed_cost_lines (company_id, movement_line_id);

-- The record number (D9): a company counter per prefix, written only by costing.next_document_number inside the action that numbers the
-- document (a system counter, an exception to rule 7 like inventory.movement_numbers: no id / seq / audit of its own).
create table costing.document_numbers (
  company_id uuid not null references kernel.companies (id),
  prefix     text not null check (prefix ~ '^[A-Z]{1,5}-$'),
  next       bigint not null default 1 check (next > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);
select kernel.enable_company_rls('costing', 'document_numbers');
grant select on costing.document_numbers to authenticated;
grant all on costing.document_numbers to service_role;

create or replace function costing.next_document_number(p_company uuid, p_prefix text) returns text
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
  insert into costing.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;
revoke execute on function costing.next_document_number(uuid, text) from public, anon;
grant execute on function costing.next_document_number(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (rule 7), the touch trigger and the typed lifecycle columns.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('costing', 'landed_costs');
select kernel.enable_company_rls('costing', 'landed_cost_lines');
select kernel.enable_row_audit('costing', 'landed_costs');
select kernel.enable_row_audit('costing', 'landed_cost_lines');
create trigger assign_seq before insert on costing.landed_costs      for each row execute function core.assign_seq('costing.landed_cost');
create trigger assign_seq before insert on costing.landed_cost_lines for each row execute function core.assign_seq('costing.landed_cost_line');
create trigger touch_row before update on costing.landed_costs      for each row execute function core.touch_row();
create trigger touch_row before update on costing.landed_cost_lines for each row execute function core.touch_row();
select kernel.typed_columns('costing', 'landed_costs', 'documento', 'costing.landed_cost');
select kernel.typed_lines('costing', 'landed_cost_lines', 'costing.landed_cost', 'landed_cost_id');

-- Grants: the handlers run as the caller. A Borrador (never numbered) would be deleted with its lines by the lifecycle (D1).
grant select, insert, update on costing.landed_costs, costing.landed_cost_lines to authenticated;
grant delete on costing.landed_costs, costing.landed_cost_lines to authenticated;
grant all on costing.landed_costs, costing.landed_cost_lines to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['landed_costs', 'landed_cost_lines'] loop
    execute format($p$create policy via_process_insert on costing.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')$p$, t);
    execute format($p$create policy via_process_update on costing.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')$p$, t);
    execute format($p$create policy via_process_delete on costing.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'costing.%%')$p$, t);
  end loop;
end;
$$;

-- Who uses a product or a bodega (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no.
select kernel.register_reference('core.product',        'costing', 'landed_cost_lines', 'product_id');
select kernel.register_reference('inventory.warehouse', 'costing', 'landed_cost_lines', 'warehouse_id');
select kernel.register_reference('core.party',          'costing', 'landed_costs',      'party_id');

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/costing/src/entities.ts and pasted here.
-- ---------------------------------------------------------------------------------------------

create or replace view costing.v_landed_costs with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.landed_cost', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.landed_cost', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('costing.landed_cost', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('costing.landed_cost', 'movement_id')) then "movement_id" else null end as "movement_id",
  case when (select kernel.field_visible('costing.landed_cost', 'movement_number')) then "movement_number" else null end as "movement_number",
  case when (select kernel.field_visible('costing.landed_cost', 'basis')) then "basis" else null end as "basis",
  case when (select kernel.field_visible('costing.landed_cost', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('costing.landed_cost', 'offset_role')) then "offset_role" else null end as "offset_role",
  case when (select kernel.field_visible('costing.landed_cost', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('costing.landed_cost', 'reference')) then "reference" else null end as "reference",
  case when (select kernel.field_visible('costing.landed_cost', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('costing.landed_cost', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('costing.landed_cost', 'applied_at')) then "applied_at" else null end as "applied_at",
  case when (select kernel.field_visible('costing.landed_cost', 'extra')) then kernel.mask_extra('costing.landed_cost', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.landed_cost', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('costing.landed_cost', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('costing.landed_cost', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('costing.landed_cost', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('costing.landed_cost', 'void_reason')) then "void_reason" else null end as "void_reason"
from costing.landed_costs;
grant select on costing.v_landed_costs to authenticated;

create or replace view costing.v_landed_cost_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.landed_cost_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.landed_cost_line', 'landed_cost_id')) then "landed_cost_id" else null end as "landed_cost_id",
  case when (select kernel.field_visible('costing.landed_cost_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('costing.landed_cost_line', 'movement_line_id')) then "movement_line_id" else null end as "movement_line_id",
  case when (select kernel.field_visible('costing.landed_cost_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('costing.landed_cost_line', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('costing.landed_cost_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('costing.landed_cost_line', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('costing.landed_cost_line', 'weight')) then "weight" else null end as "weight",
  case when (select kernel.field_visible('costing.landed_cost_line', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('costing.landed_cost_line', 'unit_cost_added')) then "unit_cost_added" else null end as "unit_cost_added",
  case when (select kernel.field_visible('costing.landed_cost_line', 'extra')) then kernel.mask_extra('costing.landed_cost_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.landed_cost_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.landed_cost_lines;
grant select on costing.v_landed_cost_lines to authenticated;

create or replace view costing.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.settings', 'method')) then "method" else null end as "method",
  case when (select kernel.field_visible('costing.settings', 'extra')) then kernel.mask_extra('costing.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.settings;
grant select on costing.v_settings to authenticated;
