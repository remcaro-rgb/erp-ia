-- 0084_sales_orders
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/order.integration.test.ts (sales and inventory loaded
-- together) and packages/modules/sales/src/__tests__/entities.test.ts (the masked views match the entity definitions).
-- Plan 2B Task 13 (the plan named it 0064; 0084 was the next free number):
--   * sales.orders (pedidos de venta: a documento numbered PED- on save, never posted, waiting for approval when the customer's credit limit
--     or the company's discount threshold is crossed) with sales.order_lines, and the module's number counter (sales.document_numbers,
--     sales.next_number: a system counter like crm's, an exception to rule 7 as core.entity_sequences is);
--   * sales.credit_exposure(): the customer's credit limit and the total of their confirmed pedidos, read by the processes under a lock of the
--     customer's credit for the transaction (two confirmations of the same customer queue);
--   * the credit limit per customer (sales.customer_terms.credit_limit) and the discount threshold of pedidos
--     (sales.settings.order_approval_discount_pct), appended to their tables and masked views;
--   * crm's published views of its cotizaciones for the pedido that converts them (crm.v_quote_offers, crm.v_quote_offer_lines): sales reads
--     the accepted cotización's stored prices there (rule 3), never crm's tables, and never writes crm.
-- Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the module's
-- processes (restrictive policies on erp.audit_process_id). The cotización, the oportunidad and the bodega of a pedido are other modules'
-- records, named by id: no foreign key leaves the schema (rule 3).

-- =============================================================================================
-- Parámetros: the discount threshold of pedidos, the credit limit of each customer (company currency; null: none)
-- =============================================================================================
alter table sales.settings add column order_approval_discount_pct numeric(7,4)
  check (order_approval_discount_pct is null or order_approval_discount_pct between 0 and 100);
alter table sales.customer_terms add column credit_limit numeric(18,4) check (credit_limit is null or credit_limit >= 0);

-- =============================================================================================
-- Pedidos
-- =============================================================================================
-- Money (rule 8): amounts in the document currency with its exchange-rate snapshot; the total also in the company currency (what the credit
-- limit is compared with). `stage` is the commercial state beside the lifecycle `status`; `credit_exceeded` / `discount_exceeded` say why it
-- waits (or waited) for approval.
create table sales.orders (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  number            text,
  party_id          uuid not null,
  quote_id          uuid,
  opportunity_id    uuid,
  owner_id          uuid,
  warehouse_id      uuid,
  issue_date        date not null,
  delivery_date     date,
  stage             text not null default 'open' check (stage in ('open', 'confirmed', 'cancelled')),
  currency          text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate     numeric(18,6) not null default 1 check (exchange_rate > 0),
  subtotal          numeric(18,4) not null default 0 check (subtotal >= 0),
  discount_total    numeric(18,4) not null default 0 check (discount_total >= 0),
  tax_total         numeric(18,4) not null default 0 check (tax_total >= 0),
  total             numeric(18,4) not null default 0 check (total >= 0),
  total_company     numeric(18,4) not null default 0 check (total_company >= 0),
  max_discount_pct  numeric(7,4) not null default 0 check (max_discount_pct between 0 and 100),
  credit_exceeded   boolean not null default false,
  discount_exceeded boolean not null default false,
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  notes             text check (notes is null or char_length(notes) <= 2000),
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check (delivery_date is null or delivery_date >= issue_date),
  check (stage <> 'confirmed' or confirmed_at is not null),
  check ((stage = 'cancelled') = (cancelled_at is not null))
);
create index orders_company_stage_idx on sales.orders (company_id, stage);
create index orders_party_idx on sales.orders (company_id, party_id);
create index orders_quote_idx on sales.orders (company_id, quote_id) where quote_id is not null;

-- Lines: the product (core's, invoice_ready: checked by the processes through core.v_product_sales), the quantity, the unit price and the
-- list it came from, the discount, the taxes the country pack computed, and the cotización line it was copied from.
create table sales.order_lines (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  order_id      uuid not null references sales.orders (id),
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
  quote_line_id uuid,
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (order_id, line_no)
);
create index order_lines_product_idx on sales.order_lines (company_id, product_id);

-- The pedido numbers (PED-1, PED-2 …) per company: a system counter (no seq, like crm.document_numbers), drawn on the first Grabar.
create table sales.document_numbers (
  company_id uuid not null references kernel.companies (id),
  prefix     text not null check (prefix ~ '^[A-Z]{1,5}-$'),
  next       bigint not null default 1 check (next > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);
select kernel.enable_company_rls('sales', 'document_numbers');
grant select on sales.document_numbers to authenticated;
grant all on sales.document_numbers to service_role;

create or replace function sales.next_number(p_company uuid, p_prefix text) returns text
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
  insert into sales.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;
revoke execute on function sales.next_number(uuid, text) from public, anon;
grant execute on function sales.next_number(uuid, text) to authenticated, service_role;

select kernel.enable_company_rls('sales', 'orders');
select kernel.enable_company_rls('sales', 'order_lines');
select kernel.enable_row_audit('sales', 'orders');
select kernel.enable_row_audit('sales', 'order_lines');
create trigger assign_seq before insert on sales.orders      for each row execute function core.assign_seq('sales.order');
create trigger assign_seq before insert on sales.order_lines for each row execute function core.assign_seq('sales.order_line');
create trigger touch_row before update on sales.orders      for each row execute function core.touch_row();
create trigger touch_row before update on sales.order_lines for each row execute function core.touch_row();

-- The typed lifecycle (entity types spec §5): the pedido's state columns, the flags copied at insert (sales sets them itself) and the
-- record-access read policy; the lines inherit the pedido's read right.
select kernel.typed_columns('sales', 'orders', 'documento', 'sales.order');
select kernel.typed_lines('sales', 'order_lines', 'sales.order', 'order_id');

-- One live pedido per cotización: a cancelled (voided) one frees it.
create unique index orders_one_per_quote on sales.orders (company_id, quote_id) where quote_id is not null and stage <> 'cancelled' and status <> 'voided';

-- Grants: the handlers run as the caller. A Borrador pedido (never numbered) may be deleted by the lifecycle (D1); sales.order.update
-- replaces the lines of an open one.
grant select, insert, update on sales.orders, sales.order_lines to authenticated;
grant delete on sales.orders, sales.order_lines to authenticated;
grant all on sales.orders, sales.order_lines to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['orders', 'order_lines'] loop
    execute format($p$create policy via_process_insert on sales.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
    execute format($p$create policy via_process_update on sales.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
    execute format($p$create policy via_process_delete on sales.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
  end loop;
end;
$$;

-- Eliminar (D1): only a Borrador (never numbered), whoever issues the statement.
create or replace function sales.document_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'erp:invalid_input:Solo se elimina un documento en Borrador';
  end if;
  return old;
end;
$$;
create trigger delete_draft_only before delete on sales.orders for each row execute function sales.document_delete_draft_only();

-- A pedido's lines are written while it is open and editable (Borrador, Grabado or No aprobado): once it waits for approval, is approved,
-- confirmed or cancelled, what was ordered does not change.
create or replace function sales.order_lines_locked() returns trigger
language plpgsql
as $$
declare
  v_order uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from sales.orders where id = v_order;
  if v_stage = 'open' and v_status in ('draft', 'saved', 'rejected') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_stage = 'confirmed' then
    raise exception 'erp:invalid_input:Las líneas de un pedido confirmado no cambian';
  end if;
  raise exception 'erp:invalid_input:Las líneas de un pedido solo cambian mientras está abierto y sin aprobar';
end;
$$;
create trigger order_lines_locked before insert or update or delete on sales.order_lines
  for each row execute function sales.order_lines_locked();

-- A confirmed pedido keeps what was confirmed: its customer, currency, dates, bodega and amounts never change (it may still be cancelled);
-- a cancelled one stays cancelled.
create or replace function sales.order_confirmed_frozen() returns trigger
language plpgsql
as $$
begin
  if old.stage = 'cancelled' and new.stage <> 'cancelled' then
    raise exception 'erp:invalid_input:Un pedido cancelado no vuelve a abrirse';
  end if;
  if old.stage = 'confirmed' and (new.stage = 'open' or (
       new.party_id, new.quote_id, new.opportunity_id, new.warehouse_id, new.issue_date, new.delivery_date, new.currency, new.exchange_rate,
       new.subtotal, new.discount_total, new.tax_total, new.total, new.total_company, new.max_discount_pct, new.confirmed_at
     ) is distinct from (
       old.party_id, old.quote_id, old.opportunity_id, old.warehouse_id, old.issue_date, old.delivery_date, old.currency, old.exchange_rate,
       old.subtotal, old.discount_total, old.tax_total, old.total, old.total_company, old.max_discount_pct, old.confirmed_at
     )) then
    raise exception 'erp:invalid_input:Un pedido confirmado no cambia';
  end if;
  return new;
end;
$$;
create trigger order_confirmed_frozen before update on sales.orders for each row execute function sales.order_confirmed_frozen();

-- The customer's credit: their limit (sales.customer_terms.credit_limit, company currency; null when none) and the total in the company
-- currency of their confirmed pedidos other than `p_except`. Definer: the sum covers every pedido of the customer in the caller's company,
-- whoever can see them (a record rule hiding a pedido from the caller must not lift the customer's limit). It takes a transaction lock on
-- the customer's credit, so two pedidos of the same customer are checked and confirmed one after the other. Open receivables (invoices not
-- yet paid) are not counted: invoicing (Task 16) publishes them. INTERIM (Task 13, review of 2026-11-05): Task 16 redefines the exposure as
-- "confirmed pedidos not yet invoiced + open issued invoices" (a forward migration replacing this function), and Task 14 adds the delivery
-- stage. sales.order.confirm calls this function on every confirmation, approved ones included, for the lock.
create or replace function sales.credit_exposure(p_party uuid, p_except uuid)
returns table (credit_limit numeric, exposure numeric)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sales.credit:' || v_company::text || ':' || p_party::text, 0));
  return query
    select (select t.credit_limit from sales.customer_terms t where t.company_id = v_company and t.party_id = p_party),
           coalesce((select sum(o.total_company) from sales.orders o
                     where o.company_id = v_company and o.party_id = p_party and o.stage = 'confirmed' and o.status <> 'voided'
                       and o.id is distinct from p_except), 0);
end;
$$;
revoke execute on function sales.credit_exposure(uuid, uuid) from public, anon;
grant execute on function sales.credit_exposure(uuid, uuid) to authenticated, service_role;

-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones work
-- from the migration on.
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('sales.order', 'sales', 'documento', 'sales', 'orders', 'sales.order_line')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',      'sales', 'orders',      'party_id');
select kernel.register_reference('core.product',    'sales', 'order_lines', 'product_id');
select kernel.register_reference('core.price_list', 'sales', 'order_lines', 'price_list_id');

-- =============================================================================================
-- crm: the cotizaciones as published for their pedido (rule 3)
-- =============================================================================================
-- What sales.order.from_quote reads of a cotización: its customer, oportunidad, stage and status, currency and exchange rate, and its lines
-- with the price, list and discount the customer accepted. security_invoker: crm's RLS applies as the caller (company, the salesperson's own
-- cotizaciones, record rules). Deliberately unmasked: a pedido copies the accepted prices whatever the caller's field visibility, as the
-- cotización's processes compute them (the pedido's own masked views then govern what the caller sees of it).
create or replace view crm.v_quote_offers with (security_invoker = true) as
select q.id, q.company_id, q.number, q.party_id, q.opportunity_id, q.owner_id, q.stage, q.status, q.currency, q.exchange_rate,
       q.issue_date, q.valid_until, q.accepted_at, q.notes
from crm.quotes q;
grant select on crm.v_quote_offers to authenticated;

create or replace view crm.v_quote_offer_lines with (security_invoker = true) as
select l.id, l.company_id, l.quote_id, l.line_no, l.product_id, l.description, l.qty, l.unit_price, l.price_list_id, l.discount_pct
from crm.quote_lines l;
grant select on crm.v_quote_offer_lines to authenticated;
comment on view crm.v_quote_offers is
  'Published for sales (rule 3): the cotización a pedido converts (sales.order.from_quote). Unmasked, security_invoker (crm RLS as the caller).';
comment on view crm.v_quote_offer_lines is
  'Published for sales (rule 3): the accepted prices, lists and discounts a pedido copies. Unmasked, security_invoker (crm RLS as the caller).';

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/sales/src/entities.ts and pasted here; the entities test fails when they drift. sales.v_settings and
-- sales.v_customer_terms gain their new column at the end.
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
  case when (select kernel.field_visible('sales.settings', 'order_approval_discount_pct')) then "order_approval_discount_pct" else null end as "order_approval_discount_pct"
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
  "updated_at",
  case when (select kernel.field_visible('sales.customer_terms', 'credit_limit')) then "credit_limit" else null end as "credit_limit"
from sales.customer_terms;
grant select on sales.v_customer_terms to authenticated;

create or replace view sales.v_orders with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.order', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.order', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('sales.order', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('sales.order', 'quote_id')) then "quote_id" else null end as "quote_id",
  case when (select kernel.field_visible('sales.order', 'opportunity_id')) then "opportunity_id" else null end as "opportunity_id",
  case when (select kernel.field_visible('sales.order', 'owner_id')) then "owner_id" else null end as "owner_id",
  case when (select kernel.field_visible('sales.order', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('sales.order', 'issue_date')) then "issue_date" else null end as "issue_date",
  case when (select kernel.field_visible('sales.order', 'delivery_date')) then "delivery_date" else null end as "delivery_date",
  case when (select kernel.field_visible('sales.order', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('sales.order', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('sales.order', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('sales.order', 'subtotal')) then "subtotal" else null end as "subtotal",
  case when (select kernel.field_visible('sales.order', 'discount_total')) then "discount_total" else null end as "discount_total",
  case when (select kernel.field_visible('sales.order', 'tax_total')) then "tax_total" else null end as "tax_total",
  case when (select kernel.field_visible('sales.order', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('sales.order', 'total_company')) then "total_company" else null end as "total_company",
  case when (select kernel.field_visible('sales.order', 'max_discount_pct')) then "max_discount_pct" else null end as "max_discount_pct",
  case when (select kernel.field_visible('sales.order', 'credit_exceeded')) then "credit_exceeded" else null end as "credit_exceeded",
  case when (select kernel.field_visible('sales.order', 'discount_exceeded')) then "discount_exceeded" else null end as "discount_exceeded",
  case when (select kernel.field_visible('sales.order', 'confirmed_at')) then "confirmed_at" else null end as "confirmed_at",
  case when (select kernel.field_visible('sales.order', 'cancelled_at')) then "cancelled_at" else null end as "cancelled_at",
  case when (select kernel.field_visible('sales.order', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.order', 'extra')) then kernel.mask_extra('sales.order', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.order', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.order', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.order', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('sales.order', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('sales.order', 'void_reason')) then "void_reason" else null end as "void_reason"
from sales.orders;
grant select on sales.v_orders to authenticated;

create or replace view sales.v_order_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.order_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.order_line', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('sales.order_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('sales.order_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('sales.order_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('sales.order_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('sales.order_line', 'unit_price')) then "unit_price" else null end as "unit_price",
  case when (select kernel.field_visible('sales.order_line', 'price_list_id')) then "price_list_id" else null end as "price_list_id",
  case when (select kernel.field_visible('sales.order_line', 'discount_pct')) then "discount_pct" else null end as "discount_pct",
  case when (select kernel.field_visible('sales.order_line', 'discount')) then "discount" else null end as "discount",
  case when (select kernel.field_visible('sales.order_line', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('sales.order_line', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('sales.order_line', 'iva')) then "iva" else null end as "iva",
  case when (select kernel.field_visible('sales.order_line', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('sales.order_line', 'inc')) then "inc" else null end as "inc",
  case when (select kernel.field_visible('sales.order_line', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('sales.order_line', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('sales.order_line', 'quote_line_id')) then "quote_line_id" else null end as "quote_line_id",
  case when (select kernel.field_visible('sales.order_line', 'extra')) then kernel.mask_extra('sales.order_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.order_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from sales.order_lines;
grant select on sales.v_order_lines to authenticated;
