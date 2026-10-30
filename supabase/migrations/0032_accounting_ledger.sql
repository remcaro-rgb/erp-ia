-- 0032_accounting_ledger
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/ledger-schema.integration.test.ts
-- (counter, line checks, frozen lines, totals, idempotency index, append-only close checks) and views.test.ts.
-- The ledger (accounting design §4.6–4.10, §4.14, §5.1): comprobantes and their lines, posting rules and failures, entry
-- templates, the period close checks and the counter of events acknowledged before the ledger starts.
-- The plan numbered this migration 0026; the accounting migrations are 0031 and 0032 (see 0031).

-- ---------------------------------------------------------------------------------------------
-- Reglas contables (§4.8): per-company copies of the default rules modules ship, editable under step-up.
-- ---------------------------------------------------------------------------------------------
create table accounting.posting_rules (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  event       text not null,
  name        text not null,
  description text,
  module      text,
  journal_id  uuid not null references accounting.journals (id),
  template    jsonb not null,
  priority    int not null default 100,
  is_default  boolean not null default false,
  is_modified boolean not null default false,
  is_active   boolean not null default true,
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq)
);
create index posting_rules_event_idx on accounting.posting_rules (company_id, event) where is_active;
select accounting.setup_table('posting_rules', 'accounting.posting_rule');

-- ---------------------------------------------------------------------------------------------
-- Comprobantes (§4.6). `number` is assigned at post from the journal's own counter; drafts carry none.
-- ---------------------------------------------------------------------------------------------
create table accounting.entries (
  id                 uuid primary key default kernel.uuid_v7(),
  seq                bigint not null,
  company_id         uuid not null references kernel.companies (id),
  journal_id         uuid not null references accounting.journals (id),
  number             text,
  date               date not null,
  period_id          uuid references accounting.periods (id),
  status             text not null default 'draft' check (status in ('draft', 'pending', 'posted', 'reversed', 'voided')),
  origin             text not null default 'manual' check (origin in ('manual', 'auto', 'import', 'template')),
  reverse_on         date,
  submitted_by       uuid,
  submitted_at       timestamptz,
  description        text,
  currency           text not null default 'COP',
  exchange_rate      numeric(18, 6) not null default 1 check (exchange_rate > 0),
  total_debit        numeric(18, 4) not null default 0,
  total_credit       numeric(18, 4) not null default 0,
  source_event_id    uuid,
  posting_rule_id    uuid references accounting.posting_rules (id),
  source_entity      text,
  source_record_id   uuid,
  chain_id           uuid,
  business_unit_id   uuid references accounting.business_units (id),
  reversal_of_id     uuid references accounting.entries (id),
  reversed_by_id     uuid references accounting.entries (id),
  is_opening         boolean not null default false,
  is_closing         boolean not null default false,
  is_auto_reversal   boolean not null default false,
  posted_at          timestamptz,
  posted_by          uuid,
  extra              jsonb not null default '{}'::jsonb,
  extra_free         jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default kernel.current_user_id(),
  updated_by         uuid,
  unique (company_id, seq),
  -- A comprobante that left draft is balanced (§5.5).
  check (status in ('draft', 'pending', 'voided') or total_debit = total_credit)
);
-- One entry per (event, rule): redelivery and retry answer the first entry (§5.1 idempotency).
create unique index entries_event_rule_key on accounting.entries (company_id, source_event_id, posting_rule_id) where source_event_id is not null;
create unique index entries_journal_number_key on accounting.entries (company_id, journal_id, number) where number is not null;
create index entries_date_idx on accounting.entries (company_id, date);
create index entries_status_idx on accounting.entries (company_id, status);
create index entries_source_idx on accounting.entries (company_id, source_entity, source_record_id) where source_record_id is not null;
create index entries_period_idx on accounting.entries (company_id, period_id);
select accounting.setup_table('entries', 'accounting.entry');

-- ---------------------------------------------------------------------------------------------
-- Movimientos (§4.7). Exactly one side is non-zero; lines change only while the entry is a draft.
-- ---------------------------------------------------------------------------------------------
create table accounting.entry_lines (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  entry_id          uuid not null references accounting.entries (id),
  line_no           int not null check (line_no > 0),
  account_id        uuid not null references accounting.accounts (id),
  party_id          uuid,
  cost_center_id    uuid references accounting.cost_centers (id),
  open_auxiliary_id uuid references accounting.open_auxiliaries (id),
  item_id           uuid references accounting.items (id),
  business_unit_id  uuid references accounting.business_units (id),
  description       text,
  debit             numeric(18, 4) not null default 0 check (debit >= 0),
  credit            numeric(18, 4) not null default 0 check (credit >= 0),
  debit_doc         numeric(18, 4) not null default 0,
  credit_doc        numeric(18, 4) not null default 0,
  tax_code          text,
  tax_rate          numeric(9, 4),
  tax_base          numeric(18, 4),
  reference         text,
  due_date          date,
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (entry_id, line_no),
  check ((debit = 0) <> (credit = 0))
);
create index entry_lines_entry_idx on accounting.entry_lines (entry_id);
create index entry_lines_account_idx on accounting.entry_lines (company_id, account_id);
create index entry_lines_party_idx on accounting.entry_lines (company_id, party_id) where party_id is not null;
create index entry_lines_cost_center_idx on accounting.entry_lines (company_id, cost_center_id) where cost_center_id is not null;
create index entry_lines_open_auxiliary_idx on accounting.entry_lines (company_id, open_auxiliary_id) where open_auxiliary_id is not null;
create index entry_lines_item_idx on accounting.entry_lines (company_id, item_id) where item_id is not null;
create index entry_lines_business_unit_idx on accounting.entry_lines (company_id, business_unit_id) where business_unit_id is not null;
select accounting.setup_table('entry_lines', 'accounting.entry_line');
grant delete on accounting.entry_lines to authenticated;

-- Lines of an entry that is not a draft cannot be inserted, changed or deleted (§4.7): posted entries are corrected by reversal.
create or replace function accounting.entry_lines_frozen() returns trigger
language plpgsql
as $$
declare
  v_entry uuid := case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
  v_status text;
begin
  select status into v_status from accounting.entries where id = v_entry;
  if v_status is distinct from 'draft' then
    raise exception 'erp:invalid_input:Las líneas de un comprobante solo se pueden cambiar mientras es un borrador';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger entry_lines_frozen before insert or update or delete on accounting.entry_lines
  for each row execute function accounting.entry_lines_frozen();

-- total_debit / total_credit follow the lines of a draft (§4.6).
create or replace function accounting.entries_totals() returns trigger
language plpgsql
as $$
declare
  v_entry uuid := case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
begin
  update accounting.entries e
     set total_debit  = coalesce((select sum(l.debit) from accounting.entry_lines l where l.entry_id = v_entry), 0),
         total_credit = coalesce((select sum(l.credit) from accounting.entry_lines l where l.entry_id = v_entry), 0)
   where e.id = v_entry;
  return null;
end;
$$;
create trigger entries_totals after insert or update or delete on accounting.entry_lines
  for each row execute function accounting.entries_totals();

-- The journal's own gap-free consecutivo (§4.3): the row lock queues concurrent posts and a rolled-back post returns its number.
create or replace function accounting.next_entry_number(p_journal uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_code    text;
  v_number  bigint;
begin
  select company_id, code, next_number into v_company, v_code, v_number
  from accounting.journals where id = p_journal for update;
  if not found then
    raise exception 'journal % not found', p_journal using errcode = 'no_data_found';
  end if;
  if kernel.current_user_id() is not null
     and not (v_company = kernel.current_company_id() and array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'journal % is not in the caller''s active company', p_journal using errcode = 'insufficient_privilege';
  end if;
  update accounting.journals set next_number = v_number + 1 where id = p_journal;
  return v_code || '-' || v_number;
end;
$$;
revoke execute on function accounting.next_entry_number(uuid) from public, anon;
grant execute on function accounting.next_entry_number(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Pendientes de contabilizar (§4.9).
-- ---------------------------------------------------------------------------------------------
create table accounting.posting_failures (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  event_id        uuid not null,
  event           text not null,
  event_date      date,
  posting_rule_id uuid references accounting.posting_rules (id),
  payload         jsonb,
  error_code      text not null check (error_code in (
    'unbalanced', 'missing_account_mapping', 'closed_period', 'inactive_account', 'missing_party', 'missing_cost_center',
    'missing_open_auxiliary', 'missing_item', 'missing_business_unit', 'inactive_dimension', 'invalid_template', 'no_journal')),
  error_detail    text,
  status          text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  resolved_entry_id uuid references accounting.entries (id),
  attempts        int not null default 1,
  last_attempt_at timestamptz default now(),
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq)
);
create index posting_failures_status_idx on accounting.posting_failures (company_id, status);
create index posting_failures_event_idx on accounting.posting_failures (company_id, event_id);
select accounting.setup_table('posting_failures', 'accounting.posting_failure');

-- ---------------------------------------------------------------------------------------------
-- Plantillas de comprobante (§4.10).
-- ---------------------------------------------------------------------------------------------
create table accounting.entry_templates (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  name             text not null,
  journal_id       uuid not null references accounting.journals (id),
  description      text,
  business_unit_id uuid references accounting.business_units (id),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq)
);
select accounting.setup_table('entry_templates', 'accounting.entry_template');

create table accounting.entry_template_lines (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  template_id       uuid not null references accounting.entry_templates (id),
  line_no           int not null check (line_no > 0),
  account_id        uuid not null references accounting.accounts (id),
  party_id          uuid,
  cost_center_id    uuid references accounting.cost_centers (id),
  open_auxiliary_id uuid references accounting.open_auxiliaries (id),
  item_id           uuid references accounting.items (id),
  business_unit_id  uuid references accounting.business_units (id),
  side              text not null check (side in ('debit', 'credit')),
  amount            numeric(18, 4) check (amount is null or amount >= 0),
  description       text,
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (template_id, line_no)
);
select accounting.setup_table('entry_template_lines', 'accounting.entry_template_line');
grant delete on accounting.entry_template_lines to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Verificaciones de cierre (§4.14): append-only like the audit. The column is named "check" as the design says; it is a
-- reserved word, so every statement that names it quotes it.
-- ---------------------------------------------------------------------------------------------
create table accounting.period_close_checks (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  period_id  uuid not null references accounting.periods (id),
  "check"    text not null check ("check" in (
    'drafts', 'pending_failures', 'pending_approvals', 'undispatched_events', 'control_receivable', 'control_payable',
    'control_inventory', 'suspense_zero', 'rounding_within_tolerance', 'contra_nature_balances')),
  value      jsonb,
  passed     boolean not null,
  note       text,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq)
);
create index period_close_checks_period_idx on accounting.period_close_checks (company_id, period_id);
select accounting.setup_table('period_close_checks', 'accounting.period_close_check');
revoke update on accounting.period_close_checks from authenticated;

create or replace function accounting.period_close_checks_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'period_close_checks is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger period_close_checks_immutable before update or delete on accounting.period_close_checks
  for each row execute function accounting.period_close_checks_immutable();
create trigger period_close_checks_no_truncate before truncate on accounting.period_close_checks
  for each statement execute function accounting.period_close_checks_immutable();

-- ---------------------------------------------------------------------------------------------
-- Eventos anteriores al inicio del libro (§5.1): events acknowledged without posting because they predate ledger_starts_on.
-- ---------------------------------------------------------------------------------------------
create table accounting.skipped_events (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  outbox_id  uuid not null,
  event      text not null,
  event_date date,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, outbox_id)
);
select accounting.setup_table('skipped_events', 'accounting.skipped_event');

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/accounting/src/entities.ts; views.test.ts
-- fails when they drift.
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_entries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry', 'journal_id')) then "journal_id" else null end as "journal_id",
  case when (select kernel.field_visible('accounting.entry', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('accounting.entry', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('accounting.entry', 'period_id')) then "period_id" else null end as "period_id",
  case when (select kernel.field_visible('accounting.entry', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.entry', 'origin')) then "origin" else null end as "origin",
  case when (select kernel.field_visible('accounting.entry', 'reverse_on')) then "reverse_on" else null end as "reverse_on",
  case when (select kernel.field_visible('accounting.entry', 'submitted_by')) then "submitted_by" else null end as "submitted_by",
  case when (select kernel.field_visible('accounting.entry', 'submitted_at')) then "submitted_at" else null end as "submitted_at",
  case when (select kernel.field_visible('accounting.entry', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('accounting.entry', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('accounting.entry', 'total_debit')) then "total_debit" else null end as "total_debit",
  case when (select kernel.field_visible('accounting.entry', 'total_credit')) then "total_credit" else null end as "total_credit",
  case when (select kernel.field_visible('accounting.entry', 'source_event_id')) then "source_event_id" else null end as "source_event_id",
  case when (select kernel.field_visible('accounting.entry', 'posting_rule_id')) then "posting_rule_id" else null end as "posting_rule_id",
  case when (select kernel.field_visible('accounting.entry', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('accounting.entry', 'source_record_id')) then "source_record_id" else null end as "source_record_id",
  case when (select kernel.field_visible('accounting.entry', 'chain_id')) then "chain_id" else null end as "chain_id",
  case when (select kernel.field_visible('accounting.entry', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry', 'reversal_of_id')) then "reversal_of_id" else null end as "reversal_of_id",
  case when (select kernel.field_visible('accounting.entry', 'reversed_by_id')) then "reversed_by_id" else null end as "reversed_by_id",
  case when (select kernel.field_visible('accounting.entry', 'is_opening')) then "is_opening" else null end as "is_opening",
  case when (select kernel.field_visible('accounting.entry', 'is_closing')) then "is_closing" else null end as "is_closing",
  case when (select kernel.field_visible('accounting.entry', 'is_auto_reversal')) then "is_auto_reversal" else null end as "is_auto_reversal",
  case when (select kernel.field_visible('accounting.entry', 'posted_at')) then "posted_at" else null end as "posted_at",
  case when (select kernel.field_visible('accounting.entry', 'posted_by')) then "posted_by" else null end as "posted_by",
  case when (select kernel.field_visible('accounting.entry', 'extra')) then kernel.mask_extra('accounting.entry', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.entries;
grant select on accounting.v_entries to authenticated;

create or replace view accounting.v_entry_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry_line', 'entry_id')) then "entry_id" else null end as "entry_id",
  case when (select kernel.field_visible('accounting.entry_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('accounting.entry_line', 'account_id')) then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.entry_line', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('accounting.entry_line', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('accounting.entry_line', 'open_auxiliary_id')) then "open_auxiliary_id" else null end as "open_auxiliary_id",
  case when (select kernel.field_visible('accounting.entry_line', 'item_id')) then "item_id" else null end as "item_id",
  case when (select kernel.field_visible('accounting.entry_line', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry_line', 'debit')) then "debit" else null end as "debit",
  case when (select kernel.field_visible('accounting.entry_line', 'credit')) then "credit" else null end as "credit",
  case when (select kernel.field_visible('accounting.entry_line', 'debit_doc')) then "debit_doc" else null end as "debit_doc",
  case when (select kernel.field_visible('accounting.entry_line', 'credit_doc')) then "credit_doc" else null end as "credit_doc",
  case when (select kernel.field_visible('accounting.entry_line', 'tax_code')) then "tax_code" else null end as "tax_code",
  case when (select kernel.field_visible('accounting.entry_line', 'tax_rate')) then "tax_rate" else null end as "tax_rate",
  case when (select kernel.field_visible('accounting.entry_line', 'tax_base')) then "tax_base" else null end as "tax_base",
  case when (select kernel.field_visible('accounting.entry_line', 'reference')) then "reference" else null end as "reference",
  case when (select kernel.field_visible('accounting.entry_line', 'due_date')) then "due_date" else null end as "due_date",
  case when (select kernel.field_visible('accounting.entry_line', 'extra')) then kernel.mask_extra('accounting.entry_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.entry_lines;
grant select on accounting.v_entry_lines to authenticated;

create or replace view accounting.v_posting_rules with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.posting_rule', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.posting_rule', 'event')) then "event" else null end as "event",
  case when (select kernel.field_visible('accounting.posting_rule', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.posting_rule', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.posting_rule', 'module')) then "module" else null end as "module",
  case when (select kernel.field_visible('accounting.posting_rule', 'journal_id')) then "journal_id" else null end as "journal_id",
  case when (select kernel.field_visible('accounting.posting_rule', 'template')) then "template" else null end as "template",
  case when (select kernel.field_visible('accounting.posting_rule', 'priority')) then "priority" else null end as "priority",
  case when (select kernel.field_visible('accounting.posting_rule', 'is_default')) then "is_default" else null end as "is_default",
  case when (select kernel.field_visible('accounting.posting_rule', 'is_modified')) then "is_modified" else null end as "is_modified",
  case when (select kernel.field_visible('accounting.posting_rule', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.posting_rule', 'extra')) then kernel.mask_extra('accounting.posting_rule', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.posting_rule', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.posting_rules;
grant select on accounting.v_posting_rules to authenticated;

create or replace view accounting.v_posting_failures with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.posting_failure', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.posting_failure', 'event_id')) then "event_id" else null end as "event_id",
  case when (select kernel.field_visible('accounting.posting_failure', 'event')) then "event" else null end as "event",
  case when (select kernel.field_visible('accounting.posting_failure', 'event_date')) then "event_date" else null end as "event_date",
  case when (select kernel.field_visible('accounting.posting_failure', 'posting_rule_id')) then "posting_rule_id" else null end as "posting_rule_id",
  case when (select kernel.field_visible('accounting.posting_failure', 'payload')) then "payload" else null end as "payload",
  case when (select kernel.field_visible('accounting.posting_failure', 'error_code')) then "error_code" else null end as "error_code",
  case when (select kernel.field_visible('accounting.posting_failure', 'error_detail')) then "error_detail" else null end as "error_detail",
  case when (select kernel.field_visible('accounting.posting_failure', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.posting_failure', 'resolved_entry_id')) then "resolved_entry_id" else null end as "resolved_entry_id",
  case when (select kernel.field_visible('accounting.posting_failure', 'attempts')) then "attempts" else null end as "attempts",
  case when (select kernel.field_visible('accounting.posting_failure', 'last_attempt_at')) then "last_attempt_at" else null end as "last_attempt_at",
  case when (select kernel.field_visible('accounting.posting_failure', 'extra')) then kernel.mask_extra('accounting.posting_failure', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.posting_failure', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.posting_failures;
grant select on accounting.v_posting_failures to authenticated;

create or replace view accounting.v_entry_templates with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry_template', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry_template', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.entry_template', 'journal_id')) then "journal_id" else null end as "journal_id",
  case when (select kernel.field_visible('accounting.entry_template', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry_template', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry_template', 'extra')) then kernel.mask_extra('accounting.entry_template', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry_template', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.entry_templates;
grant select on accounting.v_entry_templates to authenticated;

create or replace view accounting.v_entry_template_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry_template_line', 'template_id')) then "template_id" else null end as "template_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('accounting.entry_template_line', 'account_id')) then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'open_auxiliary_id')) then "open_auxiliary_id" else null end as "open_auxiliary_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'item_id')) then "item_id" else null end as "item_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry_template_line', 'side')) then "side" else null end as "side",
  case when (select kernel.field_visible('accounting.entry_template_line', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('accounting.entry_template_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry_template_line', 'extra')) then kernel.mask_extra('accounting.entry_template_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry_template_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.entry_template_lines;
grant select on accounting.v_entry_template_lines to authenticated;

create or replace view accounting.v_period_close_checks with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.period_close_check', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.period_close_check', 'period_id')) then "period_id" else null end as "period_id",
  case when (select kernel.field_visible('accounting.period_close_check', 'check')) then "check" else null end as "check",
  case when (select kernel.field_visible('accounting.period_close_check', 'value')) then "value" else null end as "value",
  case when (select kernel.field_visible('accounting.period_close_check', 'passed')) then "passed" else null end as "passed",
  case when (select kernel.field_visible('accounting.period_close_check', 'note')) then "note" else null end as "note",
  case when (select kernel.field_visible('accounting.period_close_check', 'extra')) then kernel.mask_extra('accounting.period_close_check', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.period_close_check', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.period_close_checks;
grant select on accounting.v_period_close_checks to authenticated;
