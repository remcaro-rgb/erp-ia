-- 0082_sales_quotes
-- Forward-only migration (rule 34). Covered by packages/modules/crm/src/__tests__/quote.integration.test.ts,
-- packages/modules/sales/src/__tests__/pricing.integration.test.ts and the entities tests of both modules (the masked views match the
-- entity definitions).
-- Plan 2B Task 12 (the plan named it 0063; 0081 and this one were the next free numbers):
--   * the sales module's schema with its pricing parametros: sales.settings (the company's default price list) and sales.customer_terms
--     (each customer's price list and standing discount). The price lists are core's (design §8 table): referenced by id, no foreign key
--     leaves the schema (rule 3), checked by the processes through core's published views.
--   * crm's cotizaciones (design §8: quotes are crm's): crm.quotes (a documento numbered COT- on save, never posted, waiting for approval
--     when a line's discount is above the company's threshold) with crm.quote_lines, and crm.settings (that threshold and the default
--     validity). An accepted cotización's lines and amounts never change (triggers). A salesperson sees only their own cotizaciones (the
--     opportunity rule of 0079/0080).
-- Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the module's
-- processes (restrictive policies on erp.audit_process_id).

-- =============================================================================================
-- sales
-- =============================================================================================
create schema if not exists sales;
grant usage on schema sales to authenticated, service_role;

create table sales.settings (
  id                    uuid primary key default kernel.uuid_v7(),
  seq                   bigint not null,
  company_id            uuid not null references kernel.companies (id),
  default_price_list_id uuid,
  extra                 jsonb not null default '{}'::jsonb,
  extra_free            jsonb not null default '[]'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid default kernel.current_user_id(),
  updated_by            uuid,
  unique (company_id, seq),
  unique (company_id)
);

create table sales.customer_terms (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  party_id      uuid not null,
  price_list_id uuid,
  discount_pct  numeric(7,4) not null default 0 check (discount_pct between 0 and 100),
  notes         text check (notes is null or char_length(notes) <= 500),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (company_id, party_id)
);

select kernel.enable_company_rls('sales', 'settings');
select kernel.enable_company_rls('sales', 'customer_terms');
select kernel.enable_row_audit('sales', 'settings');
select kernel.enable_row_audit('sales', 'customer_terms');
create trigger assign_seq before insert on sales.settings       for each row execute function core.assign_seq('sales.settings');
create trigger assign_seq before insert on sales.customer_terms for each row execute function core.assign_seq('sales.customer_terms');
create trigger touch_row before update on sales.settings       for each row execute function core.touch_row();
create trigger touch_row before update on sales.customer_terms for each row execute function core.touch_row();

grant select, insert, update on sales.settings, sales.customer_terms to authenticated;
grant all on sales.settings, sales.customer_terms to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['settings', 'customer_terms'] loop
    execute format($p$create policy via_process_insert on sales.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
    execute format($p$create policy via_process_update on sales.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
  end loop;
end;
$$;

-- Who uses a tercero or a price list (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no.
select kernel.register_reference('core.party',      'sales', 'customer_terms', 'party_id');
select kernel.register_reference('core.price_list', 'sales', 'customer_terms', 'price_list_id');
select kernel.register_reference('core.price_list', 'sales', 'settings',       'default_price_list_id');

-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and kernel.notify_custom_field_changed, 0008):
-- sales records derive no readiness from their files or their extra data, so both are no-ops.
create or replace function sales.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function sales.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function sales.attachments_changed(text, uuid, uuid) to service_role;

create or replace function sales.custom_field_changed(p_entity text, p_company uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function sales.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function sales.custom_field_changed(text, uuid) to service_role;

-- =============================================================================================
-- crm: cotizaciones
-- =============================================================================================

-- Cotizaciones. Money (rule 8): amounts in the document currency with its exchange-rate snapshot; the total also in the company currency.
-- `stage` is the commercial state beside the lifecycle `status`; `max_discount_pct` is the largest line discount (what the approval threshold
-- is compared with).
create table crm.quotes (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  number           text,
  party_id         uuid not null,
  opportunity_id   uuid references crm.opportunities (id),
  owner_id         uuid,
  issue_date       date not null,
  valid_until      date not null,
  stage            text not null default 'open' check (stage in ('open', 'sent', 'accepted', 'expired')),
  currency         text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate    numeric(18,6) not null default 1 check (exchange_rate > 0),
  subtotal         numeric(18,4) not null default 0 check (subtotal >= 0),
  discount_total   numeric(18,4) not null default 0 check (discount_total >= 0),
  tax_total        numeric(18,4) not null default 0 check (tax_total >= 0),
  total            numeric(18,4) not null default 0 check (total >= 0),
  total_company    numeric(18,4) not null default 0 check (total_company >= 0),
  max_discount_pct numeric(7,4) not null default 0 check (max_discount_pct between 0 and 100),
  sent_at          timestamptz,
  accepted_at      timestamptz,
  expired_at       timestamptz,
  notes            text check (notes is null or char_length(notes) <= 2000),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check (valid_until >= issue_date),
  check ((stage = 'accepted') = (accepted_at is not null)),
  check ((stage = 'expired') = (expired_at is not null)),
  check (stage <> 'sent' or sent_at is not null)
);
create index quotes_company_stage_idx on crm.quotes (company_id, stage);
create index quotes_party_idx on crm.quotes (company_id, party_id);
create index quotes_owner_idx on crm.quotes (company_id, owner_id);
create index quotes_opportunity_idx on crm.quotes (opportunity_id) where opportunity_id is not null;

-- Lines: the product (core's, invoice_ready: checked by the processes through core.v_product_sales), the quantity, the unit price and the
-- list it came from, the discount, and the taxes the country pack computed.
create table crm.quote_lines (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  quote_id      uuid not null references crm.quotes (id),
  line_no       int not null check (line_no > 0),
  product_id    uuid not null,
  description   text check (description is null or char_length(description) <= 300),
  qty           numeric(18,4) not null check (qty > 0),
  unit_price    numeric(18,4) not null check (unit_price >= 0),
  price_list_id uuid,
  discount_pct  numeric(7,4) not null default 0 check (discount_pct between 0 and 100),
  discount      numeric(18,4) not null default 0 check (discount >= 0),
  base          numeric(18,4) not null default 0 check (base >= 0),
  iva_rate      text,
  iva           numeric(18,4) not null default 0 check (iva >= 0),
  inc_rate      text,
  inc           numeric(18,4) not null default 0 check (inc >= 0),
  other_taxes   numeric(18,4) not null default 0 check (other_taxes >= 0),
  total         numeric(18,4) not null default 0 check (total >= 0),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (quote_id, line_no)
);
create index quote_lines_product_idx on crm.quote_lines (company_id, product_id);

-- Parámetros de CRM: one row per company.
create table crm.settings (
  id                          uuid primary key default kernel.uuid_v7(),
  seq                         bigint not null,
  company_id                  uuid not null references kernel.companies (id),
  quote_approval_discount_pct numeric(7,4) check (quote_approval_discount_pct is null or quote_approval_discount_pct between 0 and 100),
  quote_validity_days         int not null default 30 check (quote_validity_days between 1 and 365),
  extra                       jsonb not null default '{}'::jsonb,
  extra_free                  jsonb not null default '[]'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid default kernel.current_user_id(),
  updated_by                  uuid,
  unique (company_id, seq),
  unique (company_id)
);

select kernel.enable_company_rls('crm', 'quotes');
select kernel.enable_company_rls('crm', 'quote_lines');
select kernel.enable_company_rls('crm', 'settings');
select kernel.enable_row_audit('crm', 'quotes');
select kernel.enable_row_audit('crm', 'quote_lines');
select kernel.enable_row_audit('crm', 'settings');
create trigger assign_seq before insert on crm.quotes      for each row execute function core.assign_seq('crm.quote');
create trigger assign_seq before insert on crm.quote_lines for each row execute function core.assign_seq('crm.quote_line');
create trigger assign_seq before insert on crm.settings    for each row execute function core.assign_seq('crm.settings');
create trigger touch_row before update on crm.quotes      for each row execute function core.touch_row();
create trigger touch_row before update on crm.quote_lines for each row execute function core.touch_row();
create trigger touch_row before update on crm.settings    for each row execute function core.touch_row();

-- The typed lifecycle (entity types spec §5): the cotización's state columns, the flags copied at insert (crm sets them itself) and the
-- record-access read policy; the lines inherit the cotización's read right.
select kernel.typed_columns('crm', 'quotes', 'documento', 'crm.quote');
select kernel.typed_lines('crm', 'quote_lines', 'crm.quote', 'quote_id');

-- Grants: the handlers run as the caller. A Borrador cotización (never numbered) may be deleted by the lifecycle (D1); crm.quote.update
-- replaces the lines of an open one.
grant select, insert, update on crm.quotes, crm.quote_lines, crm.settings to authenticated;
grant delete on crm.quotes, crm.quote_lines to authenticated;
grant all on crm.quotes, crm.quote_lines, crm.settings to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['quotes', 'quote_lines', 'settings'] loop
    execute format($p$create policy via_process_insert on crm.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')$p$, t);
    execute format($p$create policy via_process_update on crm.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')$p$, t);
  end loop;
  foreach t in array array['quotes', 'quote_lines'] loop
    execute format($p$create policy via_process_delete on crm.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')$p$, t);
  end loop;
end;
$$;

-- Row isolation (design §6, as the oportunidades of 0079/0080): a salesperson sees their own cotizaciones and the ones nobody owns; whoever
-- may run crm.opportunity.reassign (the sales manager; a company admin always may) sees all. A line is visible exactly when its cotización is.
create policy owner_scope on crm.quotes as restrictive for select to authenticated
  using (owner_id is null or owner_id = (select kernel.current_user_id()) or (select kernel.can_run_process('crm.opportunity.reassign')));
create policy owner_scope on crm.quote_lines as restrictive for select to authenticated
  using (exists (select 1 from crm.quotes q where q.id = quote_id));

-- Eliminar (D1): only a Borrador (never numbered), whoever issues the statement.
create trigger delete_draft_only before delete on crm.quotes for each row execute function crm.document_delete_draft_only();

-- A cotización's lines are written while it is open and editable (Borrador, Grabado or No aprobado): once it is sent, waiting for approval,
-- approved, accepted, expired or voided, what was offered does not change.
create or replace function crm.quote_lines_locked() returns trigger
language plpgsql
as $$
declare
  v_quote uuid := case when tg_op = 'DELETE' then old.quote_id else new.quote_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from crm.quotes where id = v_quote;
  if v_stage = 'open' and v_status in ('draft', 'saved', 'rejected') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_stage = 'accepted' then
    raise exception 'erp:invalid_input:Las líneas de una cotización aceptada no cambian';
  end if;
  raise exception 'erp:invalid_input:Las líneas de una cotización solo cambian mientras está abierta y sin aprobar';
end;
$$;
create trigger quote_lines_locked before insert or update or delete on crm.quote_lines
  for each row execute function crm.quote_lines_locked();

-- An accepted cotización keeps what was accepted: its customer, currency, dates and amounts never change (it may still be voided).
create or replace function crm.quote_accepted_frozen() returns trigger
language plpgsql
as $$
begin
  if old.stage = 'accepted' and (
       new.stage, new.party_id, new.issue_date, new.valid_until, new.currency, new.exchange_rate,
       new.subtotal, new.discount_total, new.tax_total, new.total, new.total_company, new.max_discount_pct, new.accepted_at
     ) is distinct from (
       old.stage, old.party_id, old.issue_date, old.valid_until, old.currency, old.exchange_rate,
       old.subtotal, old.discount_total, old.tax_total, old.total, old.total_company, old.max_discount_pct, old.accepted_at
     ) then
    raise exception 'erp:invalid_input:Una cotización aceptada no cambia';
  end if;
  return new;
end;
$$;
create trigger quote_accepted_frozen before update on crm.quotes for each row execute function crm.quote_accepted_frozen();

-- The entity -> table row syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones work
-- from the migration on.
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('crm.quote', 'crm', 'documento', 'crm', 'quotes', 'crm.quote_line')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',      'crm', 'quotes',      'party_id');
select kernel.register_reference('core.product',    'crm', 'quote_lines', 'product_id');
select kernel.register_reference('core.price_list', 'crm', 'quote_lines', 'price_list_id');

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/sales/src/entities.ts and packages/modules/crm/src/entities.ts and pasted here; the entities tests fail when they drift.
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
  "updated_at"
from sales.settings;
grant select on sales.v_settings to authenticated;

create or replace view sales.v_customer_terms with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.customer_terms', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.customer_terms', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('sales.customer_terms', 'price_list_id')) then "price_list_id" else null end as "price_list_id",
  case when (select kernel.field_visible('sales.customer_terms', 'discount_pct')) then "discount_pct" else null end as "discount_pct",
  case when (select kernel.field_visible('sales.customer_terms', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.customer_terms', 'extra')) then kernel.mask_extra('sales.customer_terms', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.customer_terms', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from sales.customer_terms;
grant select on sales.v_customer_terms to authenticated;

create or replace view crm.v_quotes with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.quote', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.quote', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('crm.quote', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('crm.quote', 'opportunity_id')) then "opportunity_id" else null end as "opportunity_id",
  case when (select kernel.field_visible('crm.quote', 'owner_id')) then "owner_id" else null end as "owner_id",
  case when (select kernel.field_visible('crm.quote', 'issue_date')) then "issue_date" else null end as "issue_date",
  case when (select kernel.field_visible('crm.quote', 'valid_until')) then "valid_until" else null end as "valid_until",
  case when (select kernel.field_visible('crm.quote', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('crm.quote', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('crm.quote', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('crm.quote', 'subtotal')) then "subtotal" else null end as "subtotal",
  case when (select kernel.field_visible('crm.quote', 'discount_total')) then "discount_total" else null end as "discount_total",
  case when (select kernel.field_visible('crm.quote', 'tax_total')) then "tax_total" else null end as "tax_total",
  case when (select kernel.field_visible('crm.quote', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('crm.quote', 'total_company')) then "total_company" else null end as "total_company",
  case when (select kernel.field_visible('crm.quote', 'max_discount_pct')) then "max_discount_pct" else null end as "max_discount_pct",
  case when (select kernel.field_visible('crm.quote', 'sent_at')) then "sent_at" else null end as "sent_at",
  case when (select kernel.field_visible('crm.quote', 'accepted_at')) then "accepted_at" else null end as "accepted_at",
  case when (select kernel.field_visible('crm.quote', 'expired_at')) then "expired_at" else null end as "expired_at",
  case when (select kernel.field_visible('crm.quote', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('crm.quote', 'extra')) then kernel.mask_extra('crm.quote', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.quote', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('crm.quote', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('crm.quote', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('crm.quote', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('crm.quote', 'void_reason')) then "void_reason" else null end as "void_reason"
from crm.quotes;
grant select on crm.v_quotes to authenticated;

create or replace view crm.v_quote_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.quote_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.quote_line', 'quote_id')) then "quote_id" else null end as "quote_id",
  case when (select kernel.field_visible('crm.quote_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('crm.quote_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('crm.quote_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('crm.quote_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('crm.quote_line', 'unit_price')) then "unit_price" else null end as "unit_price",
  case when (select kernel.field_visible('crm.quote_line', 'price_list_id')) then "price_list_id" else null end as "price_list_id",
  case when (select kernel.field_visible('crm.quote_line', 'discount_pct')) then "discount_pct" else null end as "discount_pct",
  case when (select kernel.field_visible('crm.quote_line', 'discount')) then "discount" else null end as "discount",
  case when (select kernel.field_visible('crm.quote_line', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('crm.quote_line', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('crm.quote_line', 'iva')) then "iva" else null end as "iva",
  case when (select kernel.field_visible('crm.quote_line', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('crm.quote_line', 'inc')) then "inc" else null end as "inc",
  case when (select kernel.field_visible('crm.quote_line', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('crm.quote_line', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('crm.quote_line', 'extra')) then kernel.mask_extra('crm.quote_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.quote_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from crm.quote_lines;
grant select on crm.v_quote_lines to authenticated;

create or replace view crm.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.settings', 'quote_approval_discount_pct')) then "quote_approval_discount_pct" else null end as "quote_approval_discount_pct",
  case when (select kernel.field_visible('crm.settings', 'quote_validity_days')) then "quote_validity_days" else null end as "quote_validity_days",
  case when (select kernel.field_visible('crm.settings', 'extra')) then kernel.mask_extra('crm.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from crm.settings;
grant select on crm.v_settings to authenticated;
