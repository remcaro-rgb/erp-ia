-- 0120_kernel_parked_events
-- Forward-only migration (rule 34), plan 2B Task 50.9 (owner 2026-11-06, decision item 9, design §5.12, Ruling R50-9). Covered by
-- packages/kernel/src/__tests__/parked-events.integration.test.ts (dismiss, replay, guards) and dispatch.integration.test.ts.
-- A module the company never bought stays visible: the dispatcher dead-letters the events it would consume with
-- last_error = 'not_entitled:<module id>'. Admin › Módulos lists them as «módulo no contratado» and offers Descartar (dismissed_at, the
-- row stays: nothing is deleted) and an automatic replay when the module is bought and enabled later.

-- `delivered_modules`: the modules that had already handled the event (kernel.outbox_deliveries rows, which cascade away with the outbox row)
-- when it was dead-lettered; a replay restores them so only the consumers that did not run run again, and the record that inline posting
-- already handled the event (the posting engine relies on it) is never lost.
alter table kernel.outbox_dead_letter
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid,
  add column if not exists delivered_modules text[] not null default '{}';

create index if not exists outbox_dead_letter_not_entitled_idx on kernel.outbox_dead_letter (company_id, last_error) where dismissed_at is null;

-- Marks the open `not_entitled` dead letters of the module as dismissed. Answers how many it marked. A user session only inside
-- kernel.admin.module.* and only for its active company; a session without a user (the service connection) for any company.
create or replace function kernel.parked_events_dismiss(p_company uuid, p_module text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if kernel.current_user_id() is not null then
    if coalesce(current_setting('erp.audit_process_id', true), '') not like 'kernel.admin.module.%' then
      raise exception 'parked events are dismissed only inside a module administration process' using errcode = 'insufficient_privilege';
    end if;
    if p_company is distinct from kernel.current_company_id() or not (array[p_company] <@ kernel.current_company_ids()) then
      raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
    end if;
  end if;
  with marked as (
    update kernel.outbox_dead_letter
    set dismissed_at = now(), dismissed_by = kernel.current_user_id()
    where company_id = p_company and last_error = 'not_entitled:' || p_module and dismissed_at is null
    returning 1
  )
  select count(*)::int into v_count from marked;
  return v_count;
end;
$$;
revoke all on function kernel.parked_events_dismiss(uuid, text) from public, anon;
grant execute on function kernel.parked_events_dismiss(uuid, text) to authenticated, service_role;

-- Sends the open `not_entitled` dead letters of the module back to the outbox, once (same id, chain and payload; attempts reset; the dead
-- letter row is removed in the same statement). Answers how many it replayed. Same callers as the dismissal.
create or replace function kernel.parked_events_replay(p_company uuid, p_module text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if kernel.current_user_id() is not null then
    if coalesce(current_setting('erp.audit_process_id', true), '') not like 'kernel.admin.module.%' then
      raise exception 'parked events are replayed only inside a module administration process' using errcode = 'insufficient_privilege';
    end if;
    if p_company is distinct from kernel.current_company_id() or not (array[p_company] <@ kernel.current_company_ids()) then
      raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
    end if;
  end if;
  with moved as (
    delete from kernel.outbox_dead_letter
    where company_id = p_company and last_error = 'not_entitled:' || p_module and dismissed_at is null
    returning id, company_id, event, payload, chain_id, created_at, delivered_modules
  ), replayed as (
    insert into kernel.outbox (id, company_id, event, payload, chain_id, created_at)
    select id, company_id, event, payload, chain_id, created_at from moved
    returning id
  ), restored as (
    insert into kernel.outbox_deliveries (outbox_id, module_id)
    select m.id, d from moved m cross join lateral unnest(m.delivered_modules) as d
    where exists (select 1 from replayed r where r.id = m.id)
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_count from replayed, lateral (select count(*) from restored) x;
  return v_count;
end;
$$;
revoke all on function kernel.parked_events_replay(uuid, text) from public, anon;
grant execute on function kernel.parked_events_replay(uuid, text) to authenticated, service_role;

-- The dismissal is an admin process that asks for no step-up (Task 50.9): it is not in the sensitive defaults. Same body as 0021 otherwise.
create or replace function kernel.sync_sensitive_defaults(p_company uuid default null) returns void
language sql security definer
set search_path = ''
as $$
  insert into kernel.sensitive_processes (company_id, process_id, mode)
  select c.id, rp.process_id, 'self_2fa'
  from kernel.companies c
  cross join kernel.registered_processes rp
  where rp.feature_id = 'kernel.admin'
    and rp.kind <> 'consult'
    and rp.process_id <> 'kernel.admin.module.parked_events.dismiss'
    and (p_company is null or c.id = p_company)
  on conflict (company_id, process_id) do nothing;
$$;
revoke execute on function kernel.sync_sensitive_defaults(uuid) from public, anon, authenticated;
grant execute on function kernel.sync_sensitive_defaults(uuid) to service_role;

-- Replays the open `not_entitled` dead letters whose module the company may now use (bought and switched on), whichever way it was bought
-- (an entitlement row, the admin process, a plan change) and also when the dispatcher read `not_purchased` just before the purchase. The
-- outbox drain calls it before claiming. Service connection only; `p_companies` limits it (null: every company). Answers how many it replayed.
create or replace function kernel.parked_events_sweep(p_companies uuid[] default null) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r record;
  v_total integer := 0;
begin
  for r in
    select distinct company_id, substr(last_error, length('not_entitled:') + 1) as module_id
    from kernel.outbox_dead_letter
    where dismissed_at is null and last_error like 'not\_entitled:%'
      and (p_companies is null or company_id = any(p_companies))
  loop
    if kernel.entitled(r.company_id, 'module:' || r.module_id) then
      v_total := v_total + kernel.parked_events_replay(r.company_id, r.module_id);
    end if;
  end loop;
  return v_total;
end;
$$;
revoke all on function kernel.parked_events_sweep(uuid[]) from public, anon, authenticated;
grant execute on function kernel.parked_events_sweep(uuid[]) to service_role;
