-- 0145_kernel_dead_letter_parked_module
-- Forward-only migration (rule 34), owner item 119 (e) (2026-11-09, whole-branch review 2B.2 F-1.5). Covered by
-- packages/kernel/src/__tests__/dispatch.integration.test.ts («keeps parked_module … item 119 e») and parked-events.integration.test.ts.
--
-- The module an event was parked for (the tenant never bought it, 0120) gets its own dead-letter column. Before, the park lived only in
-- last_error = 'not_entitled:<module>', and a later consumer's failure on the same event wrote its own message there instead: the row
-- dropped out of Admin › Módulos and the sweep never replayed it once the module was bought. The dispatcher now writes parked_module
-- whatever last_error says; the reader (kernel/src/admin/parked-events.ts), the dismissal, the replay and the sweep match on it.
-- RLS unchanged (company policy of 0002); the table keeps its UUID v7 id. The guards of the writers are those of 0120, unchanged.

alter table kernel.outbox_dead_letter add column if not exists parked_module text;

-- Backfill from the marks written before this migration.
update kernel.outbox_dead_letter
set parked_module = substr(last_error, length('not_entitled:') + 1)
where parked_module is null and last_error like 'not\_entitled:%';

create index if not exists outbox_dead_letter_parked_module_idx
  on kernel.outbox_dead_letter (company_id, parked_module) where dismissed_at is null and parked_module is not null;

-- Same as 0120, matching on parked_module.
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
    where company_id = p_company and parked_module = p_module and dismissed_at is null
    returning 1
  )
  select count(*)::int into v_count from marked;
  return v_count;
end;
$$;
revoke all on function kernel.parked_events_dismiss(uuid, text) from public, anon;
grant execute on function kernel.parked_events_dismiss(uuid, text) to authenticated, service_role;

-- Same as 0120, matching on parked_module.
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
    where company_id = p_company and parked_module = p_module and dismissed_at is null
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

-- Same as 0120, reading the module from parked_module.
create or replace function kernel.parked_events_sweep(p_companies uuid[] default null) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r record;
  v_total integer := 0;
begin
  for r in
    select distinct company_id, parked_module as module_id
    from kernel.outbox_dead_letter
    where dismissed_at is null and parked_module is not null
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
