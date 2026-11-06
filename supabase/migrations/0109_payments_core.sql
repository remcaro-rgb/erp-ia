-- 0109_payments_core
-- Forward-only migration (rule 34). Covered by packages/modules/payments/src/__tests__/receipt.integration.test.ts and entities.test.ts (the
-- masked views match the entity definitions).
-- The payments module (design §8, §8.1 step 7, plan 2B Task 21): medios de pago and cajas (maestros), recibos de caja (a documento that
-- posts, numbered RC-n on save) and what each applies to an invoice (lines). Rule 3: no foreign key leaves the schema (the customer is core's,
-- the invoice invoicing's: named by id and number, checked by the processes through the published views). Every table: uuid v7, company,
-- seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the payments processes (restrictive policies on
-- erp.audit_process_id). Published for invoicing (Task 23): payments.v_invoice_allocations (what each receipt settled of an invoice) and
-- payments.allocated_amounts (what the posted receipts settled of some invoices, whoever may read them).

create schema if not exists payments;
grant usage on schema payments to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Medios de pago. `code` is the dimension of the receipt's cash line (payment_method:<code>); `means_code` the DIAN payment means.
-- ---------------------------------------------------------------------------------------------
create table payments.methods (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  code        text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  kind        text not null check (kind in ('cash', 'transfer', 'card', 'check', 'other')),
  means_code  text check (means_code is null or char_length(means_code) between 1 and 5),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq)
);

-- Cajas.
create table payments.cash_boxes (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  code        text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 300),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq)
);

-- ---------------------------------------------------------------------------------------------
-- Recibos de caja. Money (rule 8): in the company currency (a foreign-currency collection comes later), with the rate snapshot (1).
-- amount = the money received (Dr cash / bank); applied = what it settles of invoices (Cr receivable); withholding_total = the withholdings
-- the customer practised (Dr withholdings suffered); advance = what is left (Cr customer_advances): amount = applied − withholdings + advance.
-- ---------------------------------------------------------------------------------------------
create table payments.receipts (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  number            text,
  date              date not null,
  party_id          uuid not null,
  method_id         uuid not null references payments.methods (id),
  method_code       text not null,
  cash_box_id       uuid references payments.cash_boxes (id),
  reference         text check (reference is null or char_length(reference) <= 100),
  currency          text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate     numeric(18,6) not null default 1 check (exchange_rate > 0),
  amount            numeric(18,4) not null check (amount >= 0),
  applied           numeric(18,4) not null default 0 check (applied >= 0),
  withholding_total numeric(18,4) not null default 0 check (withholding_total >= 0 and withholding_total <= applied),
  advance           numeric(18,4) not null default 0 check (advance >= 0),
  notes             text check (notes is null or char_length(notes) <= 2000),
  applied_at        timestamptz,
  voided_at         timestamptz,
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check (amount = applied - withholding_total + advance),
  check (amount > 0 or applied > 0)
);
create index receipts_party_idx on payments.receipts (company_id, party_id);
create index receipts_company_date_idx on payments.receipts (company_id, date);

-- What a receipt applies to one invoice: amount = cash_amount + withholding_total; withholdings the certificate's lines.
create table payments.receipt_allocations (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  receipt_id        uuid not null references payments.receipts (id),
  line_no           int not null check (line_no > 0),
  invoice_id        uuid not null,
  invoice_number    text,
  amount            numeric(18,4) not null check (amount > 0),
  cash_amount       numeric(18,4) not null check (cash_amount >= 0),
  withholding_total numeric(18,4) not null default 0 check (withholding_total >= 0),
  withholdings      jsonb not null default '[]'::jsonb check (jsonb_typeof(withholdings) = 'array'),
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (receipt_id, line_no),
  unique (receipt_id, invoice_id),
  check (amount = cash_amount + withholding_total)
);
create index receipt_allocations_invoice_idx on payments.receipt_allocations (company_id, invoice_id);

-- The record number (D9): a company counter per prefix, written only by payments.next_document_number inside the action that numbers the
-- document (a system counter, an exception to rule 7 like costing.document_numbers: no id / seq / audit of its own).
create table payments.document_numbers (
  company_id uuid not null references kernel.companies (id),
  prefix     text not null check (prefix ~ '^[A-Z]{1,5}-$'),
  next       bigint not null default 1 check (next > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);
select kernel.enable_company_rls('payments', 'document_numbers');
grant select on payments.document_numbers to authenticated;
grant all on payments.document_numbers to service_role;

create or replace function payments.next_document_number(p_company uuid, p_prefix text) returns text
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
  insert into payments.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;
revoke execute on function payments.next_document_number(uuid, text) from public, anon;
grant execute on function payments.next_document_number(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (rule 7), the touch trigger and the typed lifecycle columns.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('payments', 'methods');
select kernel.enable_company_rls('payments', 'cash_boxes');
select kernel.enable_company_rls('payments', 'receipts');
select kernel.enable_company_rls('payments', 'receipt_allocations');
select kernel.enable_row_audit('payments', 'methods');
select kernel.enable_row_audit('payments', 'cash_boxes');
select kernel.enable_row_audit('payments', 'receipts');
select kernel.enable_row_audit('payments', 'receipt_allocations');
create trigger assign_seq before insert on payments.methods             for each row execute function core.assign_seq('payments.method');
create trigger assign_seq before insert on payments.cash_boxes          for each row execute function core.assign_seq('payments.cash_box');
create trigger assign_seq before insert on payments.receipts            for each row execute function core.assign_seq('payments.receipt');
create trigger assign_seq before insert on payments.receipt_allocations for each row execute function core.assign_seq('payments.receipt_allocation');
create trigger touch_row before update on payments.methods             for each row execute function core.touch_row();
create trigger touch_row before update on payments.cash_boxes          for each row execute function core.touch_row();
create trigger touch_row before update on payments.receipts            for each row execute function core.touch_row();
create trigger touch_row before update on payments.receipt_allocations for each row execute function core.touch_row();
select kernel.typed_columns('payments', 'methods', 'maestro', 'payments.method');
select kernel.typed_columns('payments', 'cash_boxes', 'maestro', 'payments.cash_box');
select kernel.typed_columns('payments', 'receipts', 'documento', 'payments.receipt');
select kernel.typed_lines('payments', 'receipt_allocations', 'payments.receipt', 'receipt_id');

-- Codes are unique among the records not deleted, whatever their case.
create unique index methods_company_code_key on payments.methods (company_id, lower(code)) where deleted_at is null;
create unique index cash_boxes_company_code_key on payments.cash_boxes (company_id, lower(code)) where deleted_at is null;

-- Grants: the handlers run as the caller. A Borrador receipt (never numbered) would be deleted with its lines by the lifecycle (D1).
grant select, insert, update on payments.methods, payments.cash_boxes, payments.receipts, payments.receipt_allocations to authenticated;
grant delete on payments.receipts, payments.receipt_allocations to authenticated;
grant all on payments.methods, payments.cash_boxes, payments.receipts, payments.receipt_allocations to service_role;

-- Writes only through the process pipeline (rule 1): payments processes and the kernel's lifecycle processes of the payments entities.
do $$
declare
  t text;
begin
  foreach t in array array['methods', 'cash_boxes', 'receipts', 'receipt_allocations'] loop
    execute format($p$create policy via_process_insert on payments.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')$p$, t);
    execute format($p$create policy via_process_update on payments.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')$p$, t);
  end loop;
  foreach t in array array['receipts', 'receipt_allocations'] loop
    execute format($p$create policy via_process_delete on payments.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')$p$, t);
  end loop;
end;
$$;

-- A received receipt does not change what it applied: its allocations are written only while it is a Borrador (payments.payment.receive
-- writes them before its Grabar); a Contabilizado or Anulado one is corrected by Anular and a new receipt.
create or replace function payments.receipt_allocations_frozen() returns trigger
language plpgsql
as $$
declare
  v_receipt uuid := case when tg_op = 'DELETE' then old.receipt_id else new.receipt_id end;
  v_status text;
begin
  select status into v_status from payments.receipts where id = v_receipt;
  if v_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Lo aplicado por un recibo de caja registrado no cambia: anúlalo y registra otro';
end;
$$;
create trigger receipt_allocations_frozen before insert or update or delete on payments.receipt_allocations
  for each row execute function payments.receipt_allocations_frozen();

-- The money of a received receipt does not change either (whoever issues the statement); Anular changes only its state.
create or replace function payments.receipts_frozen() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'erp:invalid_input:Solo se elimina un recibo de caja en Borrador';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and (new.amount, new.applied, new.withholding_total, new.advance, new.party_id, new.method_id, new.date, new.currency)
       is distinct from (old.amount, old.applied, old.withholding_total, old.advance, old.party_id, old.method_id, old.date, old.currency) then
    raise exception 'erp:invalid_input:Un recibo de caja registrado no cambia: anúlalo y registra otro';
  end if;
  return new;
end;
$$;
create trigger receipts_frozen before update or delete on payments.receipts for each row execute function payments.receipts_frozen();

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones
-- work from the migration on.
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('payments.method',   'payments', 'maestro',   'payments', 'methods',    null),
  ('payments.cash_box', 'payments', 'maestro',   'payments', 'cash_boxes', null),
  ('payments.receipt',  'payments', 'documento', 'payments', 'receipts',   'payments.receipt_allocation')
on conflict (entity) do nothing;

-- Who uses a medio de pago, a caja or a tercero (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no.
select kernel.register_reference('payments.method',   'payments', 'receipts', 'method_id');
select kernel.register_reference('payments.cash_box', 'payments', 'receipts', 'cash_box_id');
select kernel.register_reference('core.party',        'payments', 'receipts', 'party_id');

-- ---------------------------------------------------------------------------------------------
-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and kernel.notify_custom_field_changed, 0008).
-- Payments records derive no readiness from their files or their extra data: both are no-ops.
-- ---------------------------------------------------------------------------------------------
create or replace function payments.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function payments.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function payments.attachments_changed(text, uuid, uuid) to service_role;

create or replace function payments.custom_field_changed(p_entity text, p_company uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function payments.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function payments.custom_field_changed(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Published for invoicing (rule 3, Task 23) and read by the receipt itself.
-- ---------------------------------------------------------------------------------------------
-- What each receipt applied to an invoice, with the receipt's state (only a posted receipt settles the invoice; a voided one gave it back).
-- Unmasked, security_invoker: payments' RLS and record rules as the caller.
create or replace view payments.v_invoice_allocations with (security_invoker = true) as
select a.id, a.company_id, a.invoice_id, a.invoice_number, a.receipt_id, r.number as receipt_number, r.date, r.party_id, r.status as receipt_status,
       a.line_no, a.amount, a.cash_amount, a.withholding_total, a.withholdings
from payments.receipt_allocations a join payments.receipts r on r.id = a.receipt_id;
grant select on payments.v_invoice_allocations to authenticated;
comment on view payments.v_invoice_allocations is
  'Published for invoicing (rule 3): what each receipt applied to an invoice (cash and withholdings) and the receipt''s state. Unmasked, security_invoker.';

-- What the posted receipts settled of each invoice, every receipt of the caller's active company whoever may read it (a record rule must not
-- hide a receipt from the balance a new allocation is checked against). Definer; only the caller's active company.
create or replace function payments.allocated_amounts(p_invoices uuid[])
returns table (invoice_id uuid, allocated numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.invoice_id, sum(a.amount)::numeric
    from payments.receipt_allocations a join payments.receipts r on r.id = a.receipt_id
    where a.company_id = v_company and a.invoice_id = any (p_invoices) and r.status = 'posted'
    group by a.invoice_id;
end;
$$;
revoke execute on function payments.allocated_amounts(uuid[]) from public, anon;
grant execute on function payments.allocated_amounts(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/payments/src/entities.ts and pasted here; entities.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------

create or replace view payments.v_methods with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('payments.method', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('payments.method', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('payments.method', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('payments.method', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('payments.method', 'means_code')) then "means_code" else null end as "means_code",
  case when (select kernel.field_visible('payments.method', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('payments.method', 'extra')) then kernel.mask_extra('payments.method', "extra") else null end as "extra",
  case when (select kernel.field_visible('payments.method', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('payments.method', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('payments.method', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from payments.methods;
grant select on payments.v_methods to authenticated;

create or replace view payments.v_cash_boxes with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('payments.cash_box', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('payments.cash_box', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('payments.cash_box', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('payments.cash_box', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('payments.cash_box', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('payments.cash_box', 'extra')) then kernel.mask_extra('payments.cash_box', "extra") else null end as "extra",
  case when (select kernel.field_visible('payments.cash_box', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('payments.cash_box', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('payments.cash_box', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from payments.cash_boxes;
grant select on payments.v_cash_boxes to authenticated;

create or replace view payments.v_receipts with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('payments.receipt', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('payments.receipt', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('payments.receipt', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('payments.receipt', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('payments.receipt', 'method_id')) then "method_id" else null end as "method_id",
  case when (select kernel.field_visible('payments.receipt', 'method_code')) then "method_code" else null end as "method_code",
  case when (select kernel.field_visible('payments.receipt', 'cash_box_id')) then "cash_box_id" else null end as "cash_box_id",
  case when (select kernel.field_visible('payments.receipt', 'reference')) then "reference" else null end as "reference",
  case when (select kernel.field_visible('payments.receipt', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('payments.receipt', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('payments.receipt', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('payments.receipt', 'applied')) then "applied" else null end as "applied",
  case when (select kernel.field_visible('payments.receipt', 'withholding_total')) then "withholding_total" else null end as "withholding_total",
  case when (select kernel.field_visible('payments.receipt', 'advance')) then "advance" else null end as "advance",
  case when (select kernel.field_visible('payments.receipt', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('payments.receipt', 'applied_at')) then "applied_at" else null end as "applied_at",
  case when (select kernel.field_visible('payments.receipt', 'voided_at')) then "voided_at" else null end as "voided_at",
  case when (select kernel.field_visible('payments.receipt', 'extra')) then kernel.mask_extra('payments.receipt', "extra") else null end as "extra",
  case when (select kernel.field_visible('payments.receipt', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('payments.receipt', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('payments.receipt', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('payments.receipt', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('payments.receipt', 'void_reason')) then "void_reason" else null end as "void_reason"
from payments.receipts;
grant select on payments.v_receipts to authenticated;

create or replace view payments.v_receipt_allocations with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('payments.receipt_allocation', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('payments.receipt_allocation', 'receipt_id')) then "receipt_id" else null end as "receipt_id",
  case when (select kernel.field_visible('payments.receipt_allocation', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('payments.receipt_allocation', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('payments.receipt_allocation', 'invoice_number')) then "invoice_number" else null end as "invoice_number",
  case when (select kernel.field_visible('payments.receipt_allocation', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('payments.receipt_allocation', 'cash_amount')) then "cash_amount" else null end as "cash_amount",
  case when (select kernel.field_visible('payments.receipt_allocation', 'withholding_total')) then "withholding_total" else null end as "withholding_total",
  case when (select kernel.field_visible('payments.receipt_allocation', 'withholdings')) then "withholdings" else null end as "withholdings",
  case when (select kernel.field_visible('payments.receipt_allocation', 'extra')) then kernel.mask_extra('payments.receipt_allocation', "extra") else null end as "extra",
  case when (select kernel.field_visible('payments.receipt_allocation', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from payments.receipt_allocations;
grant select on payments.v_receipt_allocations to authenticated;
