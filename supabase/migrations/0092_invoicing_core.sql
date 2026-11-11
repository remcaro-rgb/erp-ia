-- 0092_invoicing_core
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/issue.integration.test.ts, creation.integration.test.ts,
-- concurrency.integration.test.ts and entities.test.ts (the masked views match the entity definitions).
-- The invoicing module (design §8, §8.1; plan 2B Task 16, which named it 0067; 0092 was the next free number):
--   * invoicing.settings (Parámetros de facturación): how invoices are created (OD-2: manual | on_delivery | on_order_confirmation, default
--     manual), the DIAN environment the CUFE names, the default cost center of the revenue line and the days of credit;
--   * invoicing.invoices (facturas de venta: a documento that posts, numbered by the DIAN resolution on «Emitir», with its CUFE) with
--     invoicing.invoice_lines and invoicing.invoice_taxes (the taxes per tax and rate, with the ledger's code), and
--     invoicing.invoice_recommendations (an automatic invoice left in Borrador, and why);
--   * what the module publishes to the others (rule 3): which entrega lines issued invoices bill (sales maintains its invoiced_qty from it
--     and refuses to void an invoiced entrega), what each pedido has been invoiced and what each customer still owes on issued invoices
--     (sales' credit exposure, migration 0093).
-- Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the invoicing
-- processes (restrictive policies on erp.audit_process_id). Parties, products, pedidos and entregas are other modules' records, named by id:
-- no foreign key leaves the schema (rule 3).

create schema if not exists invoicing;
grant usage on schema invoicing to authenticated, service_role;

-- =============================================================================================
-- Parámetros de facturación: one row per company (none: manual, habilitación, 30 days of credit, no default cost center).
-- =============================================================================================
create table invoicing.settings (
  id                     uuid primary key default kernel.uuid_v7(),
  seq                    bigint not null,
  company_id             uuid not null references kernel.companies (id),
  invoice_creation       text not null default 'manual' check (invoice_creation in ('manual', 'on_delivery', 'on_order_confirmation')),
  dian_environment       text not null default 'habilitacion' check (dian_environment in ('habilitacion', 'produccion')),
  default_cost_center_id uuid,
  credit_days            int not null default 30 check (credit_days between 0 and 365),
  extra                  jsonb not null default '{}'::jsonb,
  extra_free             jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid default kernel.current_user_id(),
  updated_by             uuid,
  unique (company_id, seq),
  unique (company_id)
);

-- =============================================================================================
-- Facturas
-- =============================================================================================
-- Money (rule 8): amounts in the document currency with its exchange-rate snapshot; the total also in the company currency. `number` is
-- prefix || consecutive drawn from the DIAN resolution (core.next_document_number) on «Emitir»; `resolution` is the resolution it was drawn
-- from as the invoice prints it (number, prefix, range, validity; never the technical key). `auto_source` names the entrega or pedido an
-- automatic invoice (OD-2) was created for: one per source.
create table invoicing.invoices (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  number            text,
  prefix            text,
  consecutive       bigint check (consecutive is null or consecutive > 0),
  cufe              text check (cufe is null or cufe ~ '^[0-9a-f]{96}$'),
  party_id          uuid not null,
  issue_date        date not null,
  issue_time        text check (issue_time is null or issue_time ~ '^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$'),
  due_date          date,
  payment_form      text not null default '1' check (payment_form in ('1', '2')),
  payment_means     text not null default '10' check (payment_means ~ '^[0-9A-Z]{1,5}$'),
  stage             text not null default 'draft' check (stage in ('draft', 'issued', 'paid', 'voided')),
  dian_status       text not null default 'draft' check (dian_status in ('draft', 'submitted', 'accepted', 'rejected')),
  origin            text not null default 'manual' check (origin in ('manual', 'from_orders', 'on_delivery', 'on_order_confirmation')),
  auto_source       text,
  currency          text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate     numeric(18,6) not null default 1 check (exchange_rate > 0),
  subtotal          numeric(18,4) not null default 0 check (subtotal >= 0),
  discount_total    numeric(18,4) not null default 0 check (discount_total >= 0),
  tax_total         numeric(18,4) not null default 0 check (tax_total >= 0),
  total             numeric(18,4) not null default 0 check (total >= 0),
  total_company     numeric(18,4) not null default 0 check (total_company >= 0),
  -- Hooks for the payments (Task 23) and the notes (Task 18): what was paid and credited, the annulment credit note.
  paid_amount       numeric(18,4) not null default 0 check (paid_amount >= 0),
  credited_amount   numeric(18,4) not null default 0 check (credited_amount >= 0),
  resolution        jsonb,
  cost_center_id    uuid,
  issued_at         timestamptz,
  annulment_note_id uuid,
  notes             text check (notes is null or char_length(notes) <= 2000),
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, number),
  unique (company_id, cufe),
  check (due_date is null or due_date >= issue_date),
  -- Numbered and coded together, at «Emitir»: a Borrador has neither, an issued invoice both.
  check ((number is null) = (cufe is null)),
  check (stage = 'draft' or (number is not null and issued_at is not null))
);
create index invoices_company_stage_idx on invoicing.invoices (company_id, stage);
create index invoices_party_idx on invoicing.invoices (company_id, party_id);
create unique index invoices_auto_source_key on invoicing.invoices (company_id, auto_source) where auto_source is not null;

-- Lines: the product (core's, invoice_ready at «Emitir»), quantity, price, discount and the taxes the country pack computed; the pedido line
-- and the entrega line it bills (sales' ids). A free sample (muestra gratis) is billed at 0 and taxed on its reference price.
create table invoicing.invoice_lines (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  invoice_id       uuid not null references invoicing.invoices (id),
  line_no          int not null check (line_no > 0),
  product_id       uuid not null,
  description      text check (description is null or char_length(description) <= 300),
  qty              numeric(18,4) not null check (qty > 0),
  unit_price       numeric(18,4) not null check (unit_price >= 0),
  discount_pct     numeric(7,4) not null default 0 check (discount_pct between 0 and 100),
  discount         numeric(18,4) not null default 0 check (discount >= 0),
  base             numeric(18,4) not null default 0 check (base >= 0),
  iva_rate         text,
  iva              numeric(18,4) not null default 0 check (iva >= 0),
  inc_rate         text,
  inc              numeric(18,4) not null default 0 check (inc >= 0),
  other_taxes      numeric(18,4) not null default 0 check (other_taxes >= 0),
  total            numeric(18,4) not null default 0 check (total >= 0),
  free_sample      boolean not null default false,
  category_id      uuid,
  order_id         uuid,
  order_line_id    uuid,
  delivery_id      uuid,
  delivery_line_id uuid,
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  unique (invoice_id, line_no),
  check (order_line_id is null or order_id is not null),
  check (delivery_line_id is null or (delivery_id is not null and order_line_id is not null))
);
create index invoice_lines_order_line_idx on invoicing.invoice_lines (company_id, order_line_id) where order_line_id is not null;
create index invoice_lines_delivery_line_idx on invoicing.invoice_lines (company_id, delivery_line_id) where delivery_line_id is not null;
create index invoice_lines_delivery_idx on invoicing.invoice_lines (company_id, delivery_id) where delivery_id is not null;

-- The invoice's taxes per tax and rate (the engine's `taxes`), with the ledger's code the posting rule's `tax:<code>` dimension reads.
create table invoicing.invoice_taxes (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  invoice_id  uuid not null references invoicing.invoices (id) on delete cascade,
  family      text not null check (family in ('IVA', 'INC', 'OTHER')),
  code        text not null,
  ledger_code text not null,
  rate        numeric(9,4),
  base        numeric(18,4) not null check (base >= 0),
  amount      numeric(18,4) not null check (amount >= 0),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq)
);
create index invoice_taxes_invoice_idx on invoicing.invoice_taxes (invoice_id);

-- An automatic invoice (OD-2) that could not be issued: the draft stays, this row says why; one open row per invoice, resolved once issued.
create table invoicing.invoice_recommendations (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  invoice_id  uuid not null references invoicing.invoices (id) on delete cascade,
  status      text not null default 'open' check (status in ('open', 'resolved')),
  code        text not null check (char_length(code) <= 100),
  message     text not null check (char_length(message) <= 2000),
  details     jsonb not null default '[]'::jsonb,
  resolved_at timestamptz,
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  check ((status = 'resolved') = (resolved_at is not null))
);
create unique index invoice_recommendations_open_key on invoicing.invoice_recommendations (invoice_id) where status = 'open';

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (core's shared trigger, rule 7) and the touch trigger.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('invoicing', 'settings');
select kernel.enable_company_rls('invoicing', 'invoices');
select kernel.enable_company_rls('invoicing', 'invoice_lines');
select kernel.enable_company_rls('invoicing', 'invoice_taxes');
select kernel.enable_company_rls('invoicing', 'invoice_recommendations');
select kernel.enable_row_audit('invoicing', 'settings');
select kernel.enable_row_audit('invoicing', 'invoices');
select kernel.enable_row_audit('invoicing', 'invoice_lines');
select kernel.enable_row_audit('invoicing', 'invoice_taxes');
select kernel.enable_row_audit('invoicing', 'invoice_recommendations');
create trigger assign_seq before insert on invoicing.settings                for each row execute function core.assign_seq('invoicing.settings');
create trigger assign_seq before insert on invoicing.invoices                for each row execute function core.assign_seq('invoicing.invoice');
create trigger assign_seq before insert on invoicing.invoice_lines           for each row execute function core.assign_seq('invoicing.invoice_line');
create trigger assign_seq before insert on invoicing.invoice_taxes           for each row execute function core.assign_seq('invoicing.invoice_tax');
create trigger assign_seq before insert on invoicing.invoice_recommendations for each row execute function core.assign_seq('invoicing.invoice_recommendation');
create trigger touch_row before update on invoicing.settings                for each row execute function core.touch_row();
create trigger touch_row before update on invoicing.invoices                for each row execute function core.touch_row();
create trigger touch_row before update on invoicing.invoice_lines           for each row execute function core.touch_row();
create trigger touch_row before update on invoicing.invoice_taxes           for each row execute function core.touch_row();
create trigger touch_row before update on invoicing.invoice_recommendations for each row execute function core.touch_row();

-- The typed lifecycle (entity types spec §5): the invoice's state columns, the flags copied at insert (invoicing sets them itself: never
-- approval, always posts) and the record-access read policy; lines, taxes and recommendations inherit the invoice's read right.
select kernel.typed_columns('invoicing', 'invoices', 'documento', 'invoicing.invoice');
select kernel.typed_lines('invoicing', 'invoice_lines', 'invoicing.invoice', 'invoice_id');
select kernel.typed_lines('invoicing', 'invoice_taxes', 'invoicing.invoice', 'invoice_id');
select kernel.typed_lines('invoicing', 'invoice_recommendations', 'invoicing.invoice', 'invoice_id');

-- Grants: the handlers run as the caller. A Borrador invoice (never numbered) may be deleted by the lifecycle (D1), with its lines, taxes
-- and recommendations.
grant select, insert, update on invoicing.settings, invoicing.invoices, invoicing.invoice_lines, invoicing.invoice_taxes, invoicing.invoice_recommendations to authenticated;
grant delete on invoicing.invoices, invoicing.invoice_lines, invoicing.invoice_taxes, invoicing.invoice_recommendations to authenticated;
grant all on invoicing.settings, invoicing.invoices, invoicing.invoice_lines, invoicing.invoice_taxes, invoicing.invoice_recommendations to service_role;

-- Writes only through the process pipeline (rule 1): runProcess sets erp.audit_process_id for its transaction.
do $$
declare
  t text;
begin
  foreach t in array array['settings', 'invoices', 'invoice_lines', 'invoice_taxes', 'invoice_recommendations'] loop
    execute format($p$create policy via_process_insert on invoicing.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%%')$p$, t);
    execute format($p$create policy via_process_update on invoicing.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%%')$p$, t);
    execute format($p$create policy via_process_delete on invoicing.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%%')$p$, t);
  end loop;
end;
$$;

-- Eliminar (D1): only a Borrador (never numbered), whoever issues the statement.
create or replace function invoicing.invoice_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' or old.stage <> 'draft' or old.number is not null then
    raise exception 'erp:invalid_input:Solo se elimina una factura en Borrador (sin número): una factura emitida se anula con una nota crédito';
  end if;
  return old;
end;
$$;
create trigger delete_draft_only before delete on invoicing.invoices for each row execute function invoicing.invoice_delete_draft_only();

-- An issued invoice keeps what was issued: its number, CUFE, customer, dates, amounts and lines never change. What follows it moves: its
-- DIAN status (Task 17), what was paid and credited (Tasks 18, 23), its stage (issued ↔ paid, voided once its annulment is accepted), the
-- annulment note and the lifecycle's Anulado. The number is never reused (a voided invoice keeps it).
create or replace function invoicing.invoice_issued_frozen() returns trigger
language plpgsql
as $$
declare
  v_moving constant text[] := array['dian_status', 'paid_amount', 'credited_amount', 'stage', 'annulment_note_id', 'status', 'void_reason', 'updated_at', 'updated_by'];
begin
  if old.stage = 'draft' then
    if new.stage not in ('draft', 'issued') then
      raise exception 'erp:invalid_input:Una factura en Borrador solo se emite';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'erp:invalid_input:Una factura emitida no cambia: se corrige con una nota crédito o débito';
  end if;
  if new.stage = 'draft' or (old.stage = 'voided' and new.stage <> 'voided') then
    raise exception 'erp:invalid_input:Una factura emitida no vuelve a Borrador y una anulada no cambia';
  end if;
  return new;
end;
$$;
create trigger invoice_issued_frozen before update on invoicing.invoices for each row execute function invoicing.invoice_issued_frozen();

-- Lines and taxes are written while the invoice is a Borrador (its stage is still draft during «Emitir», which recomputes them), then never.
create or replace function invoicing.invoice_parts_locked() returns trigger
language plpgsql
as $$
declare
  v_invoice uuid := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
  v_stage text;
begin
  select stage into v_stage from invoicing.invoices where id = v_invoice;
  if v_stage is null or v_stage = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Las líneas de una factura emitida no cambian';
end;
$$;
create trigger invoice_lines_locked before insert or update or delete on invoicing.invoice_lines
  for each row execute function invoicing.invoice_parts_locked();
create trigger invoice_taxes_locked before insert or update or delete on invoicing.invoice_taxes
  for each row execute function invoicing.invoice_parts_locked();

-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones work
-- from the migration on.
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('invoicing.invoice', 'invoicing', 'documento', 'invoicing', 'invoices', 'invoicing.invoice_line')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',   'invoicing', 'invoices',      'party_id');
select kernel.register_reference('core.product', 'invoicing', 'invoice_lines', 'product_id');

-- ---------------------------------------------------------------------------------------------
-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and kernel.notify_custom_field_changed, 0008):
-- invoicing derives nothing from its files or its extra data.
-- ---------------------------------------------------------------------------------------------
create or replace function invoicing.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function invoicing.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function invoicing.attachments_changed(text, uuid, uuid) to service_role;

create or replace function invoicing.custom_field_changed(p_entity text, p_company uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function invoicing.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function invoicing.custom_field_changed(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- What the invoicing processes count: per pedido line (and entrega line), the quantity already on invoices that are not voided, Borradores
-- included (a draft holds what it bills until it is deleted), except one invoice. Definer: the count covers every invoice of the caller's
-- company, whoever may read it (a record rule hiding an invoice must not let the same units be billed twice). Only inside an invoicing
-- process run (erp.audit_process_id), only for the caller's active company.
-- ---------------------------------------------------------------------------------------------
create or replace function invoicing.invoiced_quantities(p_order_lines uuid[], p_except uuid)
returns table (order_line_id uuid, delivery_line_id uuid, qty numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'invoicing.%' then
    raise exception 'invoicing.invoiced_quantities is read only inside an invoicing process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select l.order_line_id, l.delivery_line_id, sum(l.qty)
    from invoicing.invoice_lines l join invoicing.invoices i on i.id = l.invoice_id
    where l.company_id = v_company and i.stage <> 'voided' and l.order_line_id = any (p_order_lines) and i.id is distinct from p_except
    group by l.order_line_id, l.delivery_line_id;
end;
$$;
revoke execute on function invoicing.invoiced_quantities(uuid[], uuid) from public, anon;
grant execute on function invoicing.invoiced_quantities(uuid[], uuid) to authenticated, service_role;

-- =============================================================================================
-- Published for sales (rule 3; read only, sales declares no dependency on invoicing, like crm.v_quote_offers for sales)
-- =============================================================================================
-- Whether an issued invoice (issued or paid, not voided) bills a line of entrega `p_delivery`: sales.delivery.void asks it under the entrega's
-- lock, which «Emitir» also takes (sales.lock_deliveries_for_invoice, 0093), so an entrega is never voided once invoiced, even before
-- sales' consumer of invoicing.invoice.issued has recorded invoiced_qty. Definer: whoever may read the invoice. Caller's active company only.
create or replace function invoicing.delivery_invoiced(p_delivery uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return exists (
    select 1 from invoicing.invoice_lines l join invoicing.invoices i on i.id = l.invoice_id
    where l.company_id = v_company and l.delivery_id = p_delivery and i.stage in ('issued', 'paid'));
end;
$$;
revoke execute on function invoicing.delivery_invoiced(uuid) from public, anon;
grant execute on function invoicing.delivery_invoiced(uuid) to authenticated, service_role;

-- What the issued invoices bill of each entrega line: sales recomputes delivery_lines.invoiced_qty from it (its consumer of
-- invoicing.invoice.issued, origin event). security_invoker: invoicing's RLS as the caller.
create or replace view invoicing.v_invoiced_delivery_lines with (security_invoker = true) as
select l.company_id, l.invoice_id, l.delivery_id, l.delivery_line_id, l.order_line_id, l.qty
from invoicing.invoice_lines l join invoicing.invoices i on i.id = l.invoice_id
where l.delivery_line_id is not null and i.stage in ('issued', 'paid');
grant select on invoicing.v_invoiced_delivery_lines to authenticated;
comment on view invoicing.v_invoiced_delivery_lines is
  'Published for sales (rule 3): the entrega lines issued invoices bill (sales.delivery_lines.invoiced_qty). security_invoker.';

-- The customer's exposure on invoices (sales.credit_exposure, 0093, a definer function): per pedido, the amount its issued invoices billed in
-- the company currency; per issued invoice still owed, what is open (total less paid and credited) in the company currency.
create or replace view invoicing.v_order_invoiced with (security_invoker = true) as
select l.company_id, i.party_id, l.order_id, sum(l.total * i.exchange_rate) as invoiced_company
from invoicing.invoice_lines l join invoicing.invoices i on i.id = l.invoice_id
where l.order_id is not null and i.stage in ('issued', 'paid')
group by l.company_id, i.party_id, l.order_id;
grant select on invoicing.v_order_invoiced to authenticated;
comment on view invoicing.v_order_invoiced is
  'Published for sales (rule 3): what issued invoices billed of each pedido, company currency (credit exposure). security_invoker.';

create or replace view invoicing.v_open_invoices with (security_invoker = true) as
select i.company_id, i.party_id, i.id as invoice_id, i.number,
       greatest(i.total - i.paid_amount - i.credited_amount, 0) * i.exchange_rate as open_company
from invoicing.invoices i
where i.stage = 'issued' and i.total - i.paid_amount - i.credited_amount > 0;
grant select on invoicing.v_open_invoices to authenticated;
comment on view invoicing.v_open_invoices is
  'Published for sales (rule 3): issued invoices still owed and what is open, company currency (credit exposure). security_invoker.';

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/invoicing/src/entities.ts and pasted here; the entities test fails when they drift.
-- =============================================================================================
create or replace view invoicing.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.settings', 'invoice_creation')) then "invoice_creation" else null end as "invoice_creation",
  case when (select kernel.field_visible('invoicing.settings', 'dian_environment')) then "dian_environment" else null end as "dian_environment",
  case when (select kernel.field_visible('invoicing.settings', 'default_cost_center_id')) then "default_cost_center_id" else null end as "default_cost_center_id",
  case when (select kernel.field_visible('invoicing.settings', 'credit_days')) then "credit_days" else null end as "credit_days",
  case when (select kernel.field_visible('invoicing.settings', 'extra')) then kernel.mask_extra('invoicing.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.settings;
grant select on invoicing.v_settings to authenticated;

create or replace view invoicing.v_invoices with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.invoice', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.invoice', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('invoicing.invoice', 'prefix')) then "prefix" else null end as "prefix",
  case when (select kernel.field_visible('invoicing.invoice', 'consecutive')) then "consecutive" else null end as "consecutive",
  case when (select kernel.field_visible('invoicing.invoice', 'cufe')) then "cufe" else null end as "cufe",
  case when (select kernel.field_visible('invoicing.invoice', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('invoicing.invoice', 'issue_date')) then "issue_date" else null end as "issue_date",
  case when (select kernel.field_visible('invoicing.invoice', 'issue_time')) then "issue_time" else null end as "issue_time",
  case when (select kernel.field_visible('invoicing.invoice', 'due_date')) then "due_date" else null end as "due_date",
  case when (select kernel.field_visible('invoicing.invoice', 'payment_form')) then "payment_form" else null end as "payment_form",
  case when (select kernel.field_visible('invoicing.invoice', 'payment_means')) then "payment_means" else null end as "payment_means",
  case when (select kernel.field_visible('invoicing.invoice', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('invoicing.invoice', 'dian_status')) then "dian_status" else null end as "dian_status",
  case when (select kernel.field_visible('invoicing.invoice', 'origin')) then "origin" else null end as "origin",
  case when (select kernel.field_visible('invoicing.invoice', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('invoicing.invoice', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('invoicing.invoice', 'subtotal')) then "subtotal" else null end as "subtotal",
  case when (select kernel.field_visible('invoicing.invoice', 'discount_total')) then "discount_total" else null end as "discount_total",
  case when (select kernel.field_visible('invoicing.invoice', 'tax_total')) then "tax_total" else null end as "tax_total",
  case when (select kernel.field_visible('invoicing.invoice', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('invoicing.invoice', 'total_company')) then "total_company" else null end as "total_company",
  case when (select kernel.field_visible('invoicing.invoice', 'paid_amount')) then "paid_amount" else null end as "paid_amount",
  case when (select kernel.field_visible('invoicing.invoice', 'credited_amount')) then "credited_amount" else null end as "credited_amount",
  case when (select kernel.field_visible('invoicing.invoice', 'resolution')) then "resolution" else null end as "resolution",
  case when (select kernel.field_visible('invoicing.invoice', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('invoicing.invoice', 'issued_at')) then "issued_at" else null end as "issued_at",
  case when (select kernel.field_visible('invoicing.invoice', 'annulment_note_id')) then "annulment_note_id" else null end as "annulment_note_id",
  case when (select kernel.field_visible('invoicing.invoice', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('invoicing.invoice', 'extra')) then kernel.mask_extra('invoicing.invoice', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.invoice', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('invoicing.invoice', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('invoicing.invoice', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('invoicing.invoice', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('invoicing.invoice', 'void_reason')) then "void_reason" else null end as "void_reason"
from invoicing.invoices;
grant select on invoicing.v_invoices to authenticated;

create or replace view invoicing.v_invoice_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.invoice_line', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('invoicing.invoice_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('invoicing.invoice_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('invoicing.invoice_line', 'unit_price')) then "unit_price" else null end as "unit_price",
  case when (select kernel.field_visible('invoicing.invoice_line', 'discount_pct')) then "discount_pct" else null end as "discount_pct",
  case when (select kernel.field_visible('invoicing.invoice_line', 'discount')) then "discount" else null end as "discount",
  case when (select kernel.field_visible('invoicing.invoice_line', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('invoicing.invoice_line', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('invoicing.invoice_line', 'iva')) then "iva" else null end as "iva",
  case when (select kernel.field_visible('invoicing.invoice_line', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('invoicing.invoice_line', 'inc')) then "inc" else null end as "inc",
  case when (select kernel.field_visible('invoicing.invoice_line', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('invoicing.invoice_line', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('invoicing.invoice_line', 'free_sample')) then "free_sample" else null end as "free_sample",
  case when (select kernel.field_visible('invoicing.invoice_line', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'order_line_id')) then "order_line_id" else null end as "order_line_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'delivery_id')) then "delivery_id" else null end as "delivery_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'delivery_line_id')) then "delivery_line_id" else null end as "delivery_line_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'extra')) then kernel.mask_extra('invoicing.invoice_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.invoice_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.invoice_lines;
grant select on invoicing.v_invoice_lines to authenticated;

create or replace view invoicing.v_invoice_taxes with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'family')) then "family" else null end as "family",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'ledger_code')) then "ledger_code" else null end as "ledger_code",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'rate')) then "rate" else null end as "rate",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'extra')) then kernel.mask_extra('invoicing.invoice_tax', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.invoice_tax', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.invoice_taxes;
grant select on invoicing.v_invoice_taxes to authenticated;

create or replace view invoicing.v_invoice_recommendations with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'message')) then "message" else null end as "message",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'details')) then "details" else null end as "details",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'resolved_at')) then "resolved_at" else null end as "resolved_at",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'extra')) then kernel.mask_extra('invoicing.invoice_recommendation', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.invoice_recommendation', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.invoice_recommendations;
grant select on invoicing.v_invoice_recommendations to authenticated;
