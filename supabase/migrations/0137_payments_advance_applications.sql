-- 0137_payments_advance_applications
-- Forward-only migration (rule 34). Covered by packages/modules/payments/src/__tests__/advance.integration.test.ts and entities.test.ts (the
-- masked views match the entity definitions) and packages/modules/accounting/src/__tests__/open-items-allocations.integration.test.ts.
-- «Aplicar anticipo a factura» (plan 2B.2 Task 36; accounting design 2026-10-28, advances and receivables; main design §8.1 step 7, §22.27):
-- the advance a receipt leaves (payments.receipts.advance, Cr customer_advances) is applied to invoices by an APPLICATION: a documento that
-- posts (AP-n, numbered on save) over one customer, with lines (advance receipt, invoice, amount): many to many falls out of the lines.
-- It books one entry through the rule engine, Dr customer_advances / Cr receivable for its total (source payments.advance_application).
-- Rule 3: no foreign key leaves the schema (the customer is core's, the invoice invoicing's: named by id and number). Every table: uuid v7,
-- company, seq, extra / extra_free, audit columns, company RLS, row audit, writes only through the payments processes, rows frozen once
-- applied (an application is undone, never edited: payments.advance.undo voids it).
--   * payments.advance_applied_amounts(receipts): what the posted applications drew from each receipt's advance (R36-5).
--   * payments.allocated_amounts (0109, 0111, 0113): also adds the lines of the posted applications to each invoice's settled amount (R36-3b).
--   * payments.ledger_allocations (0112, 0114): also returns the applications' lines, summed per invoice, with the application id as
--     `receipt_id` (R36-3a); accounting.open_items_allocated reads it (migration 0138 widens its source test).

-- ---------------------------------------------------------------------------------------------
-- Applications of an advance (header) and what each draws (lines).
-- ---------------------------------------------------------------------------------------------
create table payments.advance_applications (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  number      text,
  date        date not null,
  party_id    uuid not null,
  currency    text not null default 'COP' check (currency = 'COP'),
  total       numeric(18,4) not null check (total > 0),
  applied_at  timestamptz,
  voided_at   timestamptz,
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  unique (company_id, number)
);
create index advance_applications_party_idx on payments.advance_applications (company_id, party_id);

create table payments.advance_application_lines (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  application_id uuid not null references payments.advance_applications (id),
  line_no        int not null check (line_no > 0),
  receipt_id     uuid not null references payments.receipts (id),
  receipt_number text,
  invoice_id     uuid not null,
  invoice_number text,
  amount         numeric(18,4) not null check (amount > 0),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (application_id, line_no),
  unique (application_id, receipt_id, invoice_id)
);
create index advance_application_lines_receipt_idx on payments.advance_application_lines (company_id, receipt_id);
create index advance_application_lines_invoice_idx on payments.advance_application_lines (company_id, invoice_id);

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (rule 7), the touch trigger and the typed lifecycle columns.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('payments', 'advance_applications');
select kernel.enable_company_rls('payments', 'advance_application_lines');
select kernel.enable_row_audit('payments', 'advance_applications');
select kernel.enable_row_audit('payments', 'advance_application_lines');
create trigger assign_seq before insert on payments.advance_applications      for each row execute function core.assign_seq('payments.advance_application');
create trigger assign_seq before insert on payments.advance_application_lines for each row execute function core.assign_seq('payments.advance_application_line');
create trigger touch_row before update on payments.advance_applications      for each row execute function core.touch_row();
create trigger touch_row before update on payments.advance_application_lines for each row execute function core.touch_row();
select kernel.typed_columns('payments', 'advance_applications', 'documento', 'payments.advance_application');
select kernel.typed_lines('payments', 'advance_application_lines', 'payments.advance_application', 'application_id');

-- Grants: the handlers run as the caller. A Borrador application (never numbered) would be deleted with its lines by the lifecycle (D1).
grant select, insert, update on payments.advance_applications, payments.advance_application_lines to authenticated;
grant delete on payments.advance_applications, payments.advance_application_lines to authenticated;
grant all on payments.advance_applications, payments.advance_application_lines to service_role;

-- Writes only through the process pipeline (rule 1): payments processes and the kernel's lifecycle processes of the payments entities.
do $$
declare
  t text;
begin
  foreach t in array array['advance_applications', 'advance_application_lines'] loop
    execute format($p$create policy via_process_insert on payments.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')$p$, t);
    execute format($p$create policy via_process_update on payments.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')$p$, t);
    execute format($p$create policy via_process_delete on payments.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'payments.%%')$p$, t);
  end loop;
end;
$$;

-- An applied application does not change what it drew: its lines are written only while it is a Borrador (payments.advance.apply writes them
-- before its Grabar); a Contabilizado or Anulado one is corrected by undoing it and applying again.
create or replace function payments.advance_application_lines_frozen() returns trigger
language plpgsql
as $$
declare
  v_application uuid := case when tg_op = 'DELETE' then old.application_id else new.application_id end;
  v_status text;
begin
  select status into v_status from payments.advance_applications where id = v_application;
  if v_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Lo que aplicó una aplicación de anticipo registrada no cambia: deshazla y aplica de nuevo';
end;
$$;
create trigger advance_application_lines_frozen before insert or update or delete on payments.advance_application_lines
  for each row execute function payments.advance_application_lines_frozen();

-- The money, the customer and the date of an applied application do not change either (whoever issues the statement); undoing it changes only
-- its state.
create or replace function payments.advance_applications_frozen() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'erp:invalid_input:Solo se elimina una aplicación de anticipo en Borrador';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and (new.total, new.party_id, new.date, new.currency) is distinct from (old.total, old.party_id, old.date, old.currency) then
    raise exception 'erp:invalid_input:Una aplicación de anticipo registrada no cambia: deshazla y aplica de nuevo';
  end if;
  return new;
end;
$$;
create trigger advance_applications_frozen before update or delete on payments.advance_applications for each row execute function payments.advance_applications_frozen();

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows syncModuleManifest also writes (an upsert there), and who uses a tercero (kernel."references", 0040).
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('payments.advance_application', 'payments', 'documento', 'payments', 'advance_applications', 'payments.advance_application_line')
on conflict (entity) do nothing;
select kernel.register_reference('core.party', 'payments', 'advance_applications', 'party_id');

-- ---------------------------------------------------------------------------------------------
-- What the posted applications drew from each receipt's advance (R36-5). Every application of the caller's active company whoever may read
-- it (a record rule must not hide an application from the balance a new one is checked against). Definer; payments processes only.
-- ---------------------------------------------------------------------------------------------
create or replace function payments.advance_applied_amounts(p_receipts uuid[])
returns table (receipt_id uuid, applied numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if v_process not like 'payments.%' then
    raise exception 'payments.advance_applied_amounts is called only inside a payments process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select l.receipt_id, sum(l.amount)::numeric
    from payments.advance_application_lines l join payments.advance_applications p on p.id = l.application_id
    where l.company_id = v_company and l.receipt_id = any (p_receipts) and p.status = 'posted'
    group by l.receipt_id;
end;
$$;
revoke execute on function payments.advance_applied_amounts(uuid[]) from public, anon;
grant execute on function payments.advance_applied_amounts(uuid[]) to authenticated, service_role;
comment on function payments.advance_applied_amounts(uuid[]) is
  'Published for payments'' own processes: what the posted applications drew from each receipt''s advance, every application of the active company. Payments processes only.';

-- ---------------------------------------------------------------------------------------------
-- What settled each invoice: the posted receipts' allocations and the posted applications' lines (R36-3b). Same guard as 0113 (payments or
-- invoicing process only), same signature.
-- ---------------------------------------------------------------------------------------------
create or replace function payments.allocated_amounts(p_invoices uuid[])
returns table (invoice_id uuid, allocated numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if v_process not like 'payments.%' and v_process not like 'invoicing.%' then
    raise exception 'payments.allocated_amounts is called only inside a payments or invoicing process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select s.invoice_id, sum(s.amount)::numeric
    from (
      select a.invoice_id, a.amount
      from payments.receipt_allocations a join payments.receipts r on r.id = a.receipt_id
      where a.company_id = v_company and a.invoice_id = any (p_invoices) and r.status = 'posted'
      union all
      select l.invoice_id, l.amount
      from payments.advance_application_lines l join payments.advance_applications p on p.id = l.application_id
      where l.company_id = v_company and l.invoice_id = any (p_invoices) and p.status = 'posted'
    ) s
    group by s.invoice_id;
end;
$$;
revoke execute on function payments.allocated_amounts(uuid[]) from public, anon;
grant execute on function payments.allocated_amounts(uuid[]) to authenticated, service_role;
comment on function payments.allocated_amounts(uuid[]) is
  'Published for invoicing (rule 3): what the posted receipts and the posted advance applications settled of each invoice, every one of the active company. Payments and invoicing processes only.';

-- ---------------------------------------------------------------------------------------------
-- Published by payments for accounting (rule 3): what every receipt and every application of the company applied to each invoice, whatever
-- its state (the ledger says whether it still counts at a date: a voided one's reversal cancels it). An application's lines are summed per
-- invoice and answered with the application's id as `receipt_id`: the entry's source (payments.advance_application) names it. As 0114
-- left it, executable only by its owner (accounting.open_items_allocated, a definer).
-- ---------------------------------------------------------------------------------------------
create or replace function payments.ledger_allocations(p_company uuid)
returns table (receipt_id uuid, invoice_id uuid, amount numeric)
language sql stable security definer
set search_path = ''
as $$
  select a.receipt_id, a.invoice_id, a.amount
  from payments.receipt_allocations a
  where a.company_id = p_company and array[p_company] <@ kernel.current_company_ids()
  union all
  select l.application_id, l.invoice_id, sum(l.amount)
  from payments.advance_application_lines l
  where l.company_id = p_company and array[p_company] <@ kernel.current_company_ids()
  group by l.application_id, l.invoice_id;
$$;
revoke execute on function payments.ledger_allocations(uuid) from public, anon, authenticated, service_role;
comment on function payments.ledger_allocations(uuid) is
  'Published for accounting (rule 3): receipt (or advance application) → invoice → amount of every allocation of a company the caller belongs to. Definer, executable only by its owner (accounting.open_items_allocated).';

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/payments/src/entities.ts and pasted here; entities.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------
create or replace view payments.v_advance_applications with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('payments.advance_application', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('payments.advance_application', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('payments.advance_application', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('payments.advance_application', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('payments.advance_application', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('payments.advance_application', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('payments.advance_application', 'applied_at')) then "applied_at" else null end as "applied_at",
  case when (select kernel.field_visible('payments.advance_application', 'voided_at')) then "voided_at" else null end as "voided_at",
  case when (select kernel.field_visible('payments.advance_application', 'extra')) then kernel.mask_extra('payments.advance_application', "extra") else null end as "extra",
  case when (select kernel.field_visible('payments.advance_application', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('payments.advance_application', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('payments.advance_application', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('payments.advance_application', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('payments.advance_application', 'void_reason')) then "void_reason" else null end as "void_reason"
from payments.advance_applications;
grant select on payments.v_advance_applications to authenticated;
create or replace view payments.v_advance_application_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('payments.advance_application_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('payments.advance_application_line', 'application_id')) then "application_id" else null end as "application_id",
  case when (select kernel.field_visible('payments.advance_application_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('payments.advance_application_line', 'receipt_id')) then "receipt_id" else null end as "receipt_id",
  case when (select kernel.field_visible('payments.advance_application_line', 'receipt_number')) then "receipt_number" else null end as "receipt_number",
  case when (select kernel.field_visible('payments.advance_application_line', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('payments.advance_application_line', 'invoice_number')) then "invoice_number" else null end as "invoice_number",
  case when (select kernel.field_visible('payments.advance_application_line', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('payments.advance_application_line', 'extra')) then kernel.mask_extra('payments.advance_application_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('payments.advance_application_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from payments.advance_application_lines;
grant select on payments.v_advance_application_lines to authenticated;