-- 0017_support_tickets
-- Forward-only migration (rule 34). Covered by packages/modules/support/src/__tests__/ticket.integration.test.ts
-- (create, ownership row policy, replies, close, hooks) and views.test.ts (views match the entity definitions).
-- Support module (design §8): tickets with the context the client captured when they were filed, and the
-- conversation on each ticket. A reporter reads their own tickets; a support agent reads every ticket of
-- the company (row policies below), internal notes included.

create schema if not exists support;

grant usage on schema support to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Who is an agent. Roles carry no key, so "support agent" is a permission: whoever may close tickets.
-- (Replying is not the test: a reporter holds support.ticket.reply to follow up on their own ticket.)
-- ---------------------------------------------------------------------------------------------
create or replace function support.is_agent() returns boolean
language sql stable
set search_path = ''
as $$
  select kernel.can_run_process('support.ticket.close');
$$;
revoke execute on function support.is_agent() from public, anon;
grant execute on function support.is_agent() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Tickets. `seq` is the company's consecutive ticket number (rule 7), assigned by the shared record-number
-- trigger of the core module (core.assign_seq, one counter per company and entity). `context` is what the
-- client captured: { route, selection, lastAuditIds, consoleErrors }.
-- ---------------------------------------------------------------------------------------------
create table support.tickets (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  reporter_user_id uuid not null default kernel.current_user_id() references kernel.users (id),
  kind             text not null check (kind in ('bug', 'question', 'request')),
  title            text not null check (char_length(btrim(title)) between 1 and 200),
  body             text not null check (char_length(btrim(body)) between 1 and 10000),
  context          jsonb not null default '{}'::jsonb,
  status           text not null default 'open' check (status in ('open', 'answered', 'closed')),
  priority         text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq)
);
create index tickets_reporter_user_id_idx on support.tickets (reporter_user_id);
create index tickets_company_status_idx on support.tickets (company_id, status);

create table support.ticket_messages (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  ticket_id      uuid not null references support.tickets (id),
  author_user_id uuid not null default kernel.current_user_id() references kernel.users (id),
  body           text not null check (char_length(btrim(body)) between 1 and 10000),
  is_internal    boolean not null default false,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq)
);
create index ticket_messages_ticket_id_idx on support.ticket_messages (ticket_id, seq);

-- Company RLS (rule 12), row audit (rule 16), the record number and the touch trigger.
select kernel.enable_company_rls('support', 'tickets');
select kernel.enable_company_rls('support', 'ticket_messages');
select kernel.enable_row_audit('support', 'tickets');
select kernel.enable_row_audit('support', 'ticket_messages');

create trigger assign_seq before insert on support.tickets
  for each row execute function core.assign_seq('support.ticket');
create trigger assign_seq before insert on support.ticket_messages
  for each row execute function core.assign_seq('support.ticket_message');
create trigger touch_row before update on support.tickets
  for each row execute function core.touch_row();
create trigger touch_row before update on support.ticket_messages
  for each row execute function core.touch_row();

-- The conversation is append-only: messages are written, never changed or deleted.
grant select, insert, update on support.tickets to authenticated;
grant select, insert on support.ticket_messages to authenticated;
grant all on support.tickets, support.ticket_messages to service_role;

-- ---------------------------------------------------------------------------------------------
-- Ownership (restrictive, ANDed with company_isolation): a reporter reads and updates only their own tickets;
-- an agent, every ticket of the company. A message follows its ticket (the subquery runs under the ticket's
-- policy) and an internal note is for agents only. The masked views are security_invoker, so grids, exports
-- and the assistant get the same rows.
-- ---------------------------------------------------------------------------------------------
create policy ownership on support.tickets as restrictive for all to authenticated
  using (reporter_user_id = (select kernel.current_user_id()) or (select support.is_agent()))
  with check (reporter_user_id = (select kernel.current_user_id()) or (select support.is_agent()));

create policy ticket_access on support.ticket_messages as restrictive for all to authenticated
  using (
    exists (select 1 from support.tickets t where t.id = ticket_messages.ticket_id)
    and (not is_internal or (select support.is_agent()))
  )
  with check (
    exists (select 1 from support.tickets t where t.id = ticket_messages.ticket_id)
    and (not is_internal or (select support.is_agent()))
    and author_user_id = (select kernel.current_user_id())
  );

-- Writes only through the process pipeline (rule 1): runProcess sets erp.audit_process_id for the
-- transaction it runs, so a direct insert or update by a user (through the API, say) is refused: nobody
-- reopens a closed ticket, retitles it or writes a message under another author outside support.ticket.*.
create policy via_process_insert on support.tickets as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'support.ticket.%');
create policy via_process_update on support.tickets as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'support.ticket.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'support.ticket.%');
create policy via_process_insert on support.ticket_messages as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'support.ticket.%');
create policy via_process_update on support.ticket_messages as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'support.ticket.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'support.ticket.%');

-- ---------------------------------------------------------------------------------------------
-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and
-- kernel.notify_custom_field_changed, 0008, raise when the module has none). A ticket has no readiness
-- derived from its files or from required custom fields; the files hook only refuses changes on a closed ticket
-- and the custom field hook is a no-op.
-- ---------------------------------------------------------------------------------------------
create or replace function support.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  -- A closed ticket is frozen: a file cannot be added to it or removed from it. (A change of the required
  -- files of the entity, record null, concerns no ticket.)
  if p_entity = 'support.ticket' and p_record_id is not null
     and exists (select 1 from support.tickets t where t.id = p_record_id and t.company_id = p_company and t.status = 'closed') then
    raise exception 'ticket % is closed: its files can no longer change', p_record_id using errcode = '23514';
  end if;
end;
$$;
revoke execute on function support.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function support.attachments_changed(text, uuid, uuid) to service_role;

create or replace function support.custom_field_changed(p_entity text, p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  null;
end;
$$;
revoke execute on function support.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function support.custom_field_changed(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated at authoring time by maskedViewSql
-- (packages/kernel/src/security/masked-views.ts) from the entity definitions in
-- packages/modules/support/src/entities.ts and pasted here; views.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------
create or replace view support.v_tickets with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('support.ticket', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('support.ticket', 'reporter_user_id')) then "reporter_user_id" else null end as "reporter_user_id",
  case when (select kernel.field_visible('support.ticket', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('support.ticket', 'title')) then "title" else null end as "title",
  case when (select kernel.field_visible('support.ticket', 'body')) then "body" else null end as "body",
  case when (select kernel.field_visible('support.ticket', 'context')) then "context" else null end as "context",
  case when (select kernel.field_visible('support.ticket', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('support.ticket', 'priority')) then "priority" else null end as "priority",
  case when (select kernel.field_visible('support.ticket', 'extra')) then kernel.mask_extra('support.ticket', "extra") else null end as "extra",
  case when (select kernel.field_visible('support.ticket', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from support.tickets;
grant select on support.v_tickets to authenticated;

create or replace view support.v_ticket_messages with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('support.ticket_message', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('support.ticket_message', 'ticket_id')) then "ticket_id" else null end as "ticket_id",
  case when (select kernel.field_visible('support.ticket_message', 'author_user_id')) then "author_user_id" else null end as "author_user_id",
  case when (select kernel.field_visible('support.ticket_message', 'body')) then "body" else null end as "body",
  case when (select kernel.field_visible('support.ticket_message', 'is_internal')) then "is_internal" else null end as "is_internal",
  case when (select kernel.field_visible('support.ticket_message', 'extra')) then kernel.mask_extra('support.ticket_message', "extra") else null end as "extra",
  case when (select kernel.field_visible('support.ticket_message', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from support.ticket_messages;
grant select on support.v_ticket_messages to authenticated;

