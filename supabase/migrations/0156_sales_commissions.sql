-- 0156_sales_commissions
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/commission-bases.integration.test.ts (RLS, audit, seq,
-- the record rule and the masking, the bases an issued invoice writes) and packages/modules/sales/src/__tests__/entities.test.ts (the masked
-- views match the entity definitions).
-- Plan 2B.2 Task 30.1 (Part G design PG §5.1, §5.2, §5.5; owner items 156–158, 162, 163; rulings RG-11, RG-12, RG-14), the first migration
-- of Task 30's block (0156–0161):
--   * sales.commission_plans (maestro sales.commission_plan): the payee (a core party, employee or agent), the default rate, the days the
--     provision is due after its date, the validity; Activo is the maestro's is_active. sales.commission_plan_users: the users whose pedidos
--     it covers (one active plan per user at a date, checked by sales.commission_plan.create / update under a lock per user).
--     sales.commission_plan_lines: a rate per product category.
--   * sales.commission_bases (sistema sales.commission_base): one row per invoice line billed from a pedido whose owner has an active plan
--     at the invoice date, written by sales.commission.compute from invoicing.invoice.issued (unique per invoice line: a redelivery writes
--     nothing twice): payee, plan, basis and rate frozen at the issue, the base (subtotal before taxes, after discounts) in pesos and in the
--     invoice's currency with its rate (rule 8), the commission on each, what was accrued and reversed of it (Tasks 30.2, 30.3).
--   * sales.commissions (documento sales.commission, contabiliza, COM- on save) with sales.commission_lines: the provision documents of
--     Task 30.2. The documento's lifecycle is the kernel's `status`; where the commission stands (posted | reversed | paid) is `stage`. A
--     commission is never voided by the lifecycle: it is reversed (Task 30.3).
--   * sales.settings.commission_basis: on_collection (default, item 162) or on_invoice.
--   * The record rule of item 163 (RG-14): a user reads a plan only when it lists them, and the bases and commissions of such plans; whoever
--     may run sales.commission.consult_all (a company admin always may) reads every one. The plan's users and lines follow it. Rates and
--     amounts are confidential fields (masked for the non-admin roles by the manifest sync and the role defaults).
-- Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the module's
-- commission processes (restrictive policies on erp.audit_process_id). The party, the category, the product, the invoice and its lines,
-- the cost center and the users are other modules' records, named by id: no foreign key leaves the schema (rule 3).

-- =============================================================================================
-- Parámetros de ventas: when a commission is earned
-- =============================================================================================
alter table sales.settings add column if not exists commission_basis text not null default 'on_collection'
  constraint settings_commission_basis_check check (commission_basis in ('on_collection', 'on_invoice'));

-- =============================================================================================
-- Planes de comisión
-- =============================================================================================
create table sales.commission_plans (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  name             text not null check (char_length(name) between 1 and 120),
  payee_party_id   uuid not null,
  payee_kind       text not null check (payee_kind in ('employee', 'agent')),
  default_rate_pct numeric(7,4) not null default 0 check (default_rate_pct between 0 and 100),
  payment_days     int not null default 30 check (payment_days between 0 and 365),
  valid_from       date not null,
  valid_to         date,
  notes            text check (notes is null or char_length(notes) <= 2000),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  check (valid_to is null or valid_to >= valid_from)
);
create index commission_plans_payee_idx on sales.commission_plans (company_id, payee_party_id);

create table sales.commission_plan_users (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  plan_id    uuid not null references sales.commission_plans (id),
  user_id    uuid not null,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (plan_id, user_id)
);
create index commission_plan_users_user_idx on sales.commission_plan_users (company_id, user_id);

create table sales.commission_plan_lines (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  plan_id     uuid not null references sales.commission_plans (id),
  category_id uuid not null,
  rate_pct    numeric(7,4) not null check (rate_pct between 0 and 100),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  unique (plan_id, category_id)
);

-- =============================================================================================
-- Bases de comisión
-- =============================================================================================
create table sales.commission_bases (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  invoice_id      uuid not null,
  invoice_number  text,
  invoice_line_id uuid not null,
  invoice_date    date not null,
  order_id        uuid not null references sales.orders (id),
  order_line_id   uuid not null references sales.order_lines (id),
  product_id      uuid,
  category_id     uuid,
  cost_center_id  uuid,
  user_id         uuid not null,
  plan_id         uuid not null references sales.commission_plans (id),
  payee_party_id  uuid not null,
  payee_kind      text not null check (payee_kind in ('employee', 'agent')),
  basis           text not null check (basis in ('on_collection', 'on_invoice')),
  rate_pct        numeric(7,4) not null check (rate_pct between 0 and 100),
  currency        char(3) not null,
  exchange_rate   numeric(18,6) not null check (exchange_rate > 0),
  base            numeric(18,4) not null,
  base_doc        numeric(18,4) not null,
  commission      numeric(18,4) not null,
  commission_doc  numeric(18,4) not null,
  accrued         numeric(18,4) not null default 0,
  reversed        numeric(18,4) not null default 0,
  status          text not null default 'open' check (status in ('open', 'closed')),
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  unique (company_id, invoice_line_id)
);
create index commission_bases_invoice_idx on sales.commission_bases (company_id, invoice_id);
create index commission_bases_plan_idx on sales.commission_bases (company_id, plan_id);

-- =============================================================================================
-- Comisiones (the provision documents of Task 30.2)
-- =============================================================================================
create table sales.commissions (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  number         text,
  date           date not null,
  due_date       date,
  payee_party_id uuid not null,
  payee_kind     text not null check (payee_kind in ('employee', 'agent')),
  plan_id        uuid not null references sales.commission_plans (id),
  source_kind    text not null check (source_kind in ('invoice', 'receipt', 'advance', 'note', 'annulment', 'void')),
  source_id      uuid not null,
  currency       char(3) not null,
  amount         numeric(18,4) not null,
  stage          text not null default 'posted' check (stage in ('posted', 'reversed', 'paid')),
  reverses_id    uuid references sales.commissions (id),
  notes          text check (notes is null or char_length(notes) <= 2000),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (company_id, number)
);
create index commissions_source_idx on sales.commissions (company_id, source_kind, source_id);
create index commissions_plan_idx on sales.commissions (company_id, plan_id);

create table sales.commission_lines (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  commission_id  uuid not null references sales.commissions (id),
  line_no        int not null check (line_no > 0),
  base_id        uuid not null references sales.commission_bases (id),
  cost_center_id uuid,
  amount         numeric(18,4) not null,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (commission_id, line_no)
);
create index commission_lines_base_idx on sales.commission_lines (company_id, base_id);

-- =============================================================================================
-- RLS, audit, seq, the typed lifecycle, grants and the writes through the processes
-- =============================================================================================
do $$
declare
  t text;
begin
  foreach t in array array['commission_plans', 'commission_plan_users', 'commission_plan_lines', 'commission_bases', 'commissions', 'commission_lines'] loop
    perform kernel.enable_company_rls('sales', t);
    perform kernel.enable_row_audit('sales', t);
    execute format('create trigger touch_row before update on sales.%I for each row execute function core.touch_row()', t);
  end loop;
end;
$$;
create trigger assign_seq before insert on sales.commission_plans      for each row execute function core.assign_seq('sales.commission_plan');
create trigger assign_seq before insert on sales.commission_plan_users for each row execute function core.assign_seq('sales.commission_plan_user');
create trigger assign_seq before insert on sales.commission_plan_lines for each row execute function core.assign_seq('sales.commission_plan_line');
create trigger assign_seq before insert on sales.commission_bases      for each row execute function core.assign_seq('sales.commission_base');
create trigger assign_seq before insert on sales.commissions           for each row execute function core.assign_seq('sales.commission');
create trigger assign_seq before insert on sales.commission_lines      for each row execute function core.assign_seq('sales.commission_line');

select kernel.typed_columns('sales', 'commission_plans', 'maestro', 'sales.commission_plan');
select kernel.typed_columns('sales', 'commissions', 'documento', 'sales.commission');
select kernel.typed_lines('sales', 'commission_lines', 'sales.commission', 'commission_id');

grant select, insert, update, delete on sales.commission_plans, sales.commission_plan_users, sales.commission_plan_lines,
  sales.commission_bases, sales.commissions, sales.commission_lines to authenticated;
grant all on sales.commission_plans, sales.commission_plan_users, sales.commission_plan_lines,
  sales.commission_bases, sales.commissions, sales.commission_lines to service_role;

-- Writes only through the processes: the plan and its users and lines by sales.commission_plan.*, the bases and the commissions by
-- sales.commission.* (compute, and Tasks 30.2–30.3: accrue, reverse; the generic Grabar of a commission changes no data, its validate hook).
do $$
declare
  t text;
  p text;
begin
  for t, p in select * from (values
      ('commission_plans', 'sales.commission\_plan.%'), ('commission_plan_users', 'sales.commission\_plan.%'), ('commission_plan_lines', 'sales.commission\_plan.%'),
      ('commission_bases', 'sales.commission.%'), ('commissions', 'sales.commission.%'), ('commission_lines', 'sales.commission.%')) v(t, p) loop
    execute format($f$create policy via_process_insert on sales.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like %L)$f$, t, p);
    execute format($f$create policy via_process_update on sales.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like %L)
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like %L)$f$, t, p, p);
    execute format($f$create policy via_process_delete on sales.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like %L)$f$, t, p);
  end loop;
end;
$$;

-- The record rule (item 163, RG-14): restrictive, so the company policy still applies. A FOR UPDATE lock follows it.
create policy commission_scope on sales.commission_plan_users as restrictive for select to authenticated
  using (user_id = (select kernel.current_user_id()) or (select kernel.can_run_process('sales.commission.consult_all')));
create policy commission_scope on sales.commission_plans as restrictive for select to authenticated
  using (exists (select 1 from sales.commission_plan_users u where u.plan_id = commission_plans.id and u.user_id = (select kernel.current_user_id()))
         or (select kernel.can_run_process('sales.commission.consult_all')));
create policy commission_scope on sales.commission_plan_lines as restrictive for select to authenticated
  using (exists (select 1 from sales.commission_plans p where p.id = commission_plan_lines.plan_id));
create policy commission_scope on sales.commission_bases as restrictive for select to authenticated
  using (exists (select 1 from sales.commission_plan_users u where u.plan_id = commission_bases.plan_id and u.user_id = (select kernel.current_user_id()))
         or (select kernel.can_run_process('sales.commission.consult_all')));
create policy commission_scope on sales.commissions as restrictive for select to authenticated
  using (exists (select 1 from sales.commission_plan_users u where u.plan_id = commissions.plan_id and u.user_id = (select kernel.current_user_id()))
         or (select kernel.can_run_process('sales.commission.consult_all')));
create policy commission_scope on sales.commission_lines as restrictive for select to authenticated
  using (exists (select 1 from sales.commissions c where c.id = commission_lines.commission_id));

-- Eliminar (D1): only a Borrador (0084's function). A commission is never voided by the lifecycle (it is reversed, Task 30.3), and once
-- posted it keeps its payee, plan, source, date and amount; only its stage moves (reversed, paid).
create trigger delete_draft_only before delete on sales.commissions for each row execute function sales.document_delete_draft_only();

create or replace function sales.commission_frozen() returns trigger
language plpgsql
as $$
begin
  if new.status = 'voided' and old.status <> 'voided' then
    raise exception 'erp:invalid_input:Una comisión no se anula: se revierte';
  end if;
  if old.status = 'posted' and (new.date, new.payee_party_id, new.payee_kind, new.plan_id, new.source_kind, new.source_id, new.currency, new.amount, new.reverses_id)
       is distinct from (old.date, old.payee_party_id, old.payee_kind, old.plan_id, old.source_kind, old.source_id, old.currency, old.amount, old.reverses_id) then
    raise exception 'erp:invalid_input:Una comisión contabilizada no cambia: se revierte';
  end if;
  return new;
end;
$$;
create trigger commission_frozen before update on sales.commissions for each row execute function sales.commission_frozen();

-- A base keeps what it was frozen with at the invoice's issue: only what was accrued, reversed and its status move (Tasks 30.2, 30.3;
-- a partial credit note reduces the base and the commission at the frozen rate, which is sales.commission.adjust_for_note's own column set).
create or replace function sales.commission_base_frozen() returns trigger
language plpgsql
as $$
begin
  if (new.invoice_id, new.invoice_line_id, new.invoice_date, new.order_id, new.order_line_id, new.user_id, new.plan_id, new.payee_party_id,
      new.payee_kind, new.basis, new.rate_pct, new.currency, new.exchange_rate)
     is distinct from (old.invoice_id, old.invoice_line_id, old.invoice_date, old.order_id, old.order_line_id, old.user_id, old.plan_id, old.payee_party_id,
      old.payee_kind, old.basis, old.rate_pct, old.currency, old.exchange_rate) then
    raise exception 'erp:invalid_input:Una base de comisión conserva el plan, la tasa y la factura con que se calculó';
  end if;
  return new;
end;
$$;
create trigger commission_base_frozen before update on sales.commission_bases for each row execute function sales.commission_base_frozen();

-- One active plan per user at a date (item 156): the plans of the company, other than p_plan, active and live (Grabado, Pendiente or
-- Aprobado), listing one of p_users, whose validity overlaps [p_from, p_to] (null = open-ended). Definer: a plan the caller cannot read (the
-- record rule) still counts. Only inside a run of sales.commission_plan.create / update, for the caller's active company.
create or replace function sales.commission_plan_overlaps(p_plan uuid, p_users uuid[], p_from date, p_to date)
returns table (user_id uuid, plan_id uuid, name text, valid_from date, valid_to date)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if v_process not in ('sales.commission_plan.create', 'sales.commission_plan.update') then
    raise exception 'sales.commission_plan_overlaps is called only inside sales.commission_plan.create or update' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select u.user_id, p.id, p.name, p.valid_from, p.valid_to
    from sales.commission_plans p join sales.commission_plan_users u on u.plan_id = p.id
    where p.company_id = v_company and p.id is distinct from p_plan and u.user_id = any (p_users)
      and p.is_active and p.deleted_at is null and p.status in ('saved', 'pending', 'approved')
      and p.valid_from <= coalesce(p_to, 'infinity'::date) and coalesce(p.valid_to, 'infinity'::date) >= p_from
    order by u.user_id, p.valid_from;
end;
$$;
revoke execute on function sales.commission_plan_overlaps(uuid, uuid[], date, date) from public, anon;
grant execute on function sales.commission_plan_overlaps(uuid, uuid[], date, date) to authenticated, service_role;

-- The entity -> table rows syncModuleManifest also writes, so the usability gate, the reference check and Versiones work from the migration on.
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('sales.commission_plan', 'sales', 'maestro', 'sales', 'commission_plans', null),
  ('sales.commission', 'sales', 'documento', 'sales', 'commissions', 'sales.commission_line')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',            'sales', 'commission_plans',      'payee_party_id');
select kernel.register_reference('core.product_category', 'sales', 'commission_plan_lines', 'category_id');
select kernel.register_reference('core.party',            'sales', 'commissions',           'payee_party_id');

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/sales/src/entities.ts and pasted here; the entities test fails when they drift. sales.v_settings gains its new column at
-- the end. sales.v_commission_plan_lines is the plan's own detail (not an entity): its rate masked with the plan's default rate.
-- =============================================================================================

create or replace view sales.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.settings', 'default_price_list_id')) then "default_price_list_id" else null end as "default_price_list_id",
  case when (select kernel.field_visible('sales.settings', 'extra')) then kernel.mask_extra('sales.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.settings', 'order_approval_discount_pct')) then "order_approval_discount_pct" else null end as "order_approval_discount_pct",
  case when (select kernel.field_visible('sales.settings', 'commission_basis')) then "commission_basis" else null end as "commission_basis"
from sales.settings;
grant select on sales.v_settings to authenticated;
create or replace view sales.v_commission_plans with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.commission_plan', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.commission_plan', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('sales.commission_plan', 'payee_party_id')) then "payee_party_id" else null end as "payee_party_id",
  case when (select kernel.field_visible('sales.commission_plan', 'payee_kind')) then "payee_kind" else null end as "payee_kind",
  case when (select kernel.field_visible('sales.commission_plan', 'default_rate_pct')) then "default_rate_pct" else null end as "default_rate_pct",
  case when (select kernel.field_visible('sales.commission_plan', 'payment_days')) then "payment_days" else null end as "payment_days",
  case when (select kernel.field_visible('sales.commission_plan', 'valid_from')) then "valid_from" else null end as "valid_from",
  case when (select kernel.field_visible('sales.commission_plan', 'valid_to')) then "valid_to" else null end as "valid_to",
  case when (select kernel.field_visible('sales.commission_plan', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.commission_plan', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('sales.commission_plan', 'extra')) then kernel.mask_extra('sales.commission_plan', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.commission_plan', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.commission_plan', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.commission_plan', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from sales.commission_plans;
grant select on sales.v_commission_plans to authenticated;
create or replace view sales.v_commission_bases with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.commission_base', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.commission_base', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('sales.commission_base', 'invoice_number')) then "invoice_number" else null end as "invoice_number",
  case when (select kernel.field_visible('sales.commission_base', 'invoice_line_id')) then "invoice_line_id" else null end as "invoice_line_id",
  case when (select kernel.field_visible('sales.commission_base', 'invoice_date')) then "invoice_date" else null end as "invoice_date",
  case when (select kernel.field_visible('sales.commission_base', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('sales.commission_base', 'order_line_id')) then "order_line_id" else null end as "order_line_id",
  case when (select kernel.field_visible('sales.commission_base', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('sales.commission_base', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('sales.commission_base', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('sales.commission_base', 'user_id')) then "user_id" else null end as "user_id",
  case when (select kernel.field_visible('sales.commission_base', 'plan_id')) then "plan_id" else null end as "plan_id",
  case when (select kernel.field_visible('sales.commission_base', 'payee_party_id')) then "payee_party_id" else null end as "payee_party_id",
  case when (select kernel.field_visible('sales.commission_base', 'payee_kind')) then "payee_kind" else null end as "payee_kind",
  case when (select kernel.field_visible('sales.commission_base', 'basis')) then "basis" else null end as "basis",
  case when (select kernel.field_visible('sales.commission_base', 'rate_pct')) then "rate_pct" else null end as "rate_pct",
  case when (select kernel.field_visible('sales.commission_base', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('sales.commission_base', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('sales.commission_base', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('sales.commission_base', 'base_doc')) then "base_doc" else null end as "base_doc",
  case when (select kernel.field_visible('sales.commission_base', 'commission')) then "commission" else null end as "commission",
  case when (select kernel.field_visible('sales.commission_base', 'commission_doc')) then "commission_doc" else null end as "commission_doc",
  case when (select kernel.field_visible('sales.commission_base', 'accrued')) then "accrued" else null end as "accrued",
  case when (select kernel.field_visible('sales.commission_base', 'reversed')) then "reversed" else null end as "reversed",
  case when (select kernel.field_visible('sales.commission_base', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.commission_base', 'extra')) then kernel.mask_extra('sales.commission_base', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.commission_base', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from sales.commission_bases;
grant select on sales.v_commission_bases to authenticated;
create or replace view sales.v_commissions with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.commission', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.commission', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('sales.commission', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('sales.commission', 'due_date')) then "due_date" else null end as "due_date",
  case when (select kernel.field_visible('sales.commission', 'payee_party_id')) then "payee_party_id" else null end as "payee_party_id",
  case when (select kernel.field_visible('sales.commission', 'payee_kind')) then "payee_kind" else null end as "payee_kind",
  case when (select kernel.field_visible('sales.commission', 'plan_id')) then "plan_id" else null end as "plan_id",
  case when (select kernel.field_visible('sales.commission', 'source_kind')) then "source_kind" else null end as "source_kind",
  case when (select kernel.field_visible('sales.commission', 'source_id')) then "source_id" else null end as "source_id",
  case when (select kernel.field_visible('sales.commission', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('sales.commission', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('sales.commission', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('sales.commission', 'reverses_id')) then "reverses_id" else null end as "reverses_id",
  case when (select kernel.field_visible('sales.commission', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.commission', 'extra')) then kernel.mask_extra('sales.commission', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.commission', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.commission', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.commission', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('sales.commission', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('sales.commission', 'void_reason')) then "void_reason" else null end as "void_reason"
from sales.commissions;
grant select on sales.v_commissions to authenticated;
create or replace view sales.v_commission_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.commission_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.commission_line', 'commission_id')) then "commission_id" else null end as "commission_id",
  case when (select kernel.field_visible('sales.commission_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('sales.commission_line', 'base_id')) then "base_id" else null end as "base_id",
  case when (select kernel.field_visible('sales.commission_line', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('sales.commission_line', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('sales.commission_line', 'extra')) then kernel.mask_extra('sales.commission_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.commission_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from sales.commission_lines;
grant select on sales.v_commission_lines to authenticated;
create or replace view sales.v_commission_plan_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  "plan_id",
  "category_id",
  case when (select kernel.field_visible('sales.commission_plan', 'default_rate_pct')) then "rate_pct" else null end as "rate_pct",
  "created_at",
  "updated_at"
from sales.commission_plan_lines;
grant select on sales.v_commission_plan_lines to authenticated;
