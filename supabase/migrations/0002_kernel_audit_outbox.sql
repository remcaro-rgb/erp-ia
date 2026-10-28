-- 0002_kernel_audit_outbox
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/audit.integration.test.ts.
-- Append-only audit log with row-change triggers (rule 16, design §5.9) and the event outbox
-- (design §5.5).

-- ---------------------------------------------------------------------------------------------
-- Audit log. Insert-only: no update / delete grants, plus a trigger that raises for everybody
-- (service role and superuser included). No foreign keys, so the log outlives the rows it describes.
-- Rows are read within the active company; process-level entries (writeAudit) are inserted by the
-- caller as itself, row-change entries by the security definer trigger below.
-- ---------------------------------------------------------------------------------------------
create table kernel.audit_log (
  id              uuid primary key default kernel.uuid_v7(),
  company_id      uuid,
  occurred_at     timestamptz not null default clock_timestamp(),
  actor_user_id   uuid,
  origin          text not null check (origin in ('ui', 'agent', 'scheduler', 'event', 'api', 'db')),
  process_id      text,
  entity          text not null,
  row_id          uuid,
  -- `denied`: a process run refused before its handler (not entitled, forbidden, step-up missing).
  action          text not null check (action in ('insert', 'update', 'delete', 'consult', 'denied')),
  input           jsonb,
  diff            jsonb,
  chain_id        uuid not null,
  conversation_id uuid,
  agent_run_id    text
);
create index audit_log_company_occurred_idx on kernel.audit_log (company_id, occurred_at desc);
create index audit_log_row_id_idx on kernel.audit_log (row_id);
create index audit_log_chain_id_idx on kernel.audit_log (chain_id);

-- Statement-level, so it also blocks a delete or truncate that would touch zero rows.
create or replace function kernel.audit_log_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_immutable before update or delete or truncate on kernel.audit_log
  for each statement execute function kernel.audit_log_immutable();

grant select, insert on kernel.audit_log to authenticated;
grant select, insert on kernel.audit_log to service_role;

select kernel.enable_company_rls('kernel', 'audit_log');
-- A caller may only record its own actions: the actor is the authenticated user.
create policy actor_is_caller on kernel.audit_log as restrictive for insert to authenticated
  with check (actor_user_id is not distinct from (select kernel.current_user_id()));

-- ---------------------------------------------------------------------------------------------
-- Row-change trigger. Records column-level diffs so direct database edits are captured. Origin,
-- process, chain, actor and conversation come from the transaction-local settings that
-- setAuditContext writes (`erp.audit_*`); without them the row is origin `db` with a fresh chain.
-- Security definer so it can insert whatever the caller's role may do on the audited table.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.audit_row_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  old_json jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_json jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  row_json jsonb := case when tg_op = 'DELETE' then old_json else new_json end;
  changes  jsonb;
begin
  select jsonb_object_agg(
           coalesce(o.key, n.key),
           jsonb_build_object('old', coalesce(o.value, 'null'::jsonb), 'new', coalesce(n.value, 'null'::jsonb))
         )
    into changes
  from jsonb_each(old_json) o
  full join jsonb_each(new_json) n on n.key = o.key
  where coalesce(o.key, n.key) not in ('updated_at', 'updated_by')
    and coalesce(o.value, 'null'::jsonb) is distinct from coalesce(n.value, 'null'::jsonb);

  -- An update that changed nothing worth recording writes no row.
  if tg_op = 'UPDATE' and changes is null then
    return new;
  end if;

  insert into kernel.audit_log
    (company_id, actor_user_id, origin, process_id, entity, row_id, action, diff, chain_id, conversation_id)
  values (
    -- A company's own id is its company id; every other table carries a company_id column (or none).
    nullif(
      case when tg_table_schema = 'kernel' and tg_table_name = 'companies' then row_json ->> 'id'
           else row_json ->> 'company_id' end,
      ''
    )::uuid,
    coalesce(nullif(current_setting('erp.audit_actor_user_id', true), '')::uuid, kernel.current_user_id()),
    coalesce(nullif(current_setting('erp.audit_origin', true), ''), 'db'),
    nullif(current_setting('erp.audit_process_id', true), ''),
    tg_table_schema || '.' || tg_table_name,
    nullif(row_json ->> 'id', '')::uuid,
    lower(tg_op),
    coalesce(changes, '{}'::jsonb),
    coalesce(nullif(current_setting('erp.audit_chain_id', true), '')::uuid, gen_random_uuid()),
    nullif(current_setting('erp.audit_conversation_id', true), '')::uuid
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function kernel.audit_row_change() from public;

-- Attaches the row-change trigger to <schema>.<tbl>; every business table calls this in its migration.
create or replace function kernel.enable_row_audit(schema_name text, tbl text) returns void
language plpgsql
as $$
begin
  execute format('drop trigger if exists audit_row_change on %I.%I', schema_name, tbl);
  execute format(
    'create trigger audit_row_change after insert or update or delete on %I.%I '
    'for each row execute function kernel.audit_row_change()',
    schema_name, tbl
  );
end;
$$;
revoke all on function kernel.enable_row_audit(text, text) from public;

select kernel.enable_row_audit('kernel', 'roles');
select kernel.enable_row_audit('kernel', 'memberships');
select kernel.enable_row_audit('kernel', 'companies');

-- ---------------------------------------------------------------------------------------------
-- Outbox (design §5.5). Written inside the process transaction; dispatched_at, claimed_at, attempts
-- and last_error are maintained only by the dispatcher, which runs as the service role. claimed_at is
-- set when a drain hands the row to a dispatch workflow; a claim older than 10 minutes is void.
-- ---------------------------------------------------------------------------------------------
create table kernel.outbox (
  id            uuid primary key default kernel.uuid_v7(),
  company_id    uuid not null,
  event         text not null,
  payload       jsonb not null,
  chain_id      uuid not null,
  created_at    timestamptz not null default now(),
  dispatched_at timestamptz,
  claimed_at    timestamptz,
  attempts      int not null default 0,
  last_error    text
);
create index outbox_undispatched_idx on kernel.outbox (created_at) where dispatched_at is null;
create index outbox_company_id_idx on kernel.outbox (company_id);

-- One row per (event, consuming module) that already ran, so a re-dispatch never repeats a consumer.
-- Service role only: written by the dispatch workflow, no company data to expose.
create table kernel.outbox_deliveries (
  outbox_id    uuid not null references kernel.outbox (id) on delete cascade,
  module_id    text not null,
  delivered_at timestamptz not null default now(),
  primary key (outbox_id, module_id)
);
alter table kernel.outbox_deliveries enable row level security;

create table kernel.outbox_dead_letter (
  id            uuid primary key default kernel.uuid_v7(),
  company_id    uuid not null,
  event         text not null,
  payload       jsonb not null,
  chain_id      uuid not null,
  created_at    timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts      int not null default 0,
  last_error    text,
  failed_at     timestamptz not null default now()
);
create index outbox_dead_letter_company_id_idx on kernel.outbox_dead_letter (company_id);

grant select, insert on kernel.outbox to authenticated;
grant select on kernel.outbox_dead_letter to authenticated;
grant all on kernel.outbox, kernel.outbox_dead_letter, kernel.outbox_deliveries to service_role;

select kernel.enable_company_rls('kernel', 'outbox');
select kernel.enable_company_rls('kernel', 'outbox_dead_letter');
