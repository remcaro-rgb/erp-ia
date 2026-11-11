-- Plan 2B Task 33 (owner decisions item 5, 2026-11-06): the posting mode of a company. `inline_strict` (the default) posts a contabiliza
-- documento in its own action and rolls the action back when the ledger refuses it (entity types §5.2, D8); `asynchronous` lets the action
-- commit and the accounting consumer post its event later, a refusal going to the retry queue (accounting.posting_failures).
-- Covered by posting-mode.integration.test.ts and definer-guards.integration.test.ts. Forward-only.

-- R33-1: a column of the per-company settings row (company RLS, uuid v7, gap-free seq and row audit already apply). Before accounting is
-- configured there is no row and the mode is inline_strict.
alter table accounting.settings
  add column if not exists posting_mode text not null default 'inline_strict';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_posting_mode_check' and conrelid = 'accounting.settings'::regclass) then
    alter table accounting.settings add constraint settings_posting_mode_check check (posting_mode in ('inline_strict', 'asynchronous'));
  end if;
end $$;

-- R33-5: only the registered process changes the mode (rule 1): a user session outside it is refused; a session without a user (service) passes.
create or replace function accounting.guard_posting_mode() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.posting_mode is distinct from old.posting_mode
     and kernel.current_user_id() is not null
     and coalesce(current_setting('erp.audit_process_id', true), '') <> 'accounting.posting_mode.set' then
    raise exception 'posting_mode changes only through accounting.posting_mode.set' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists guard_posting_mode on accounting.settings;
create trigger guard_posting_mode before update on accounting.settings for each row execute function accounting.guard_posting_mode();

-- R33-8: what awaits the ledger, per source document, for the active company of a member. `queued`: an outbox event that an active posting
-- rule is for, not yet delivered to accounting nor dispatched; `dead`: such an event dead-lettered before accounting handled it;
-- `failed`: a pending posting failure (its id). The source is the rule's
-- `source.id` path on the payload (a reversal rule's `reverseOf.sourceId`: the document it reverses), cast only when it is a uuid. It reveals no
-- ledger data, only that a posting is pending, so it needs no accounting permission. It clears by itself: the consumer's delivery row, or a
-- resolved or dismissed failure.
create or replace function accounting.source_of(p_payload jsonb, p_path text) returns text
language sql immutable set search_path = '' as $$
  -- The uuid a rule's path names on a payload, or null (a path that is not a plain member chain, or a value that is not a uuid).
  select case when p_path ~ '^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$' then (
    select v from (select jsonb_path_query_first(p_payload, p_path::jsonpath) #>> '{}' as v) x
    where v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) end;
$$;
revoke all on function accounting.source_of(jsonb, text) from public, anon;

create or replace function accounting.pending_postings(p_source uuid default null)
returns table (source_id uuid, event text, state text, since timestamptz, failure_id uuid)
language sql stable security definer set search_path = '' as $$
  with company as (
    select kernel.current_company_id() as id
    where kernel.current_company_id() is not null and array[kernel.current_company_id()] <@ kernel.current_company_ids()
  ),
  paths as (
    select distinct r.company_id, r.event, coalesce(r.template #>> '{source,id}', r.template #>> '{reverseOf,sourceId}') as path
    from accounting.posting_rules r join company c on c.id = r.company_id
    where r.is_active
  ),
  queued as (
    select distinct on (o.id, s.source)
           s.source::uuid as source_id, o.event, 'queued'::text as state, o.created_at as since, null::uuid as failure_id
    from kernel.outbox o
    join company c on c.id = o.company_id
    join paths p on p.company_id = o.company_id and p.event = o.event
    cross join lateral (select accounting.source_of(o.payload, p.path) as source) s
    where o.dispatched_at is null
      and s.source is not null
      and not exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = o.id and d.module_id = 'accounting')
  ),
  -- Fix round 1 (review I1): an event the dispatcher dead-lettered before accounting handled it (a consumer of another module refused it
  -- first, or accounting's own refused deterministically) is still a document outside the ledger: state `dead`, until Admin › Módulos
  -- replays it (the row goes back to the outbox) or it is removed.
  dead as (
    select distinct on (o.id, s.source)
           s.source::uuid as source_id, o.event, 'dead'::text as state, o.failed_at as since, null::uuid as failure_id
    from kernel.outbox_dead_letter o
    join company c on c.id = o.company_id
    join paths p on p.company_id = o.company_id and p.event = o.event
    cross join lateral (select accounting.source_of(o.payload, p.path) as source) s
    where s.source is not null
      and not ('accounting' = any (o.delivered_modules))
  ),
  failed as (
    select f.id as failure_id, f.event, f.created_at as since,
           coalesce(
             accounting.source_of(f.payload, coalesce(r.template #>> '{source,id}', r.template #>> '{reverseOf,sourceId}')),
             (select accounting.source_of(f.payload, p.path) from paths p where p.event = f.event and accounting.source_of(f.payload, p.path) is not null limit 1)
           ) as source
    from accounting.posting_failures f
    join company c on c.id = f.company_id
    left join accounting.posting_rules r on r.id = f.posting_rule_id
    where f.status = 'pending'
  )
  select q.source_id, q.event, q.state, q.since, q.failure_id from queued q where p_source is null or q.source_id = p_source
  union all
  select d.source_id, d.event, d.state, d.since, d.failure_id from dead d where p_source is null or d.source_id = p_source
  union all
  select f.source::uuid, f.event, 'failed'::text, f.since, f.failure_id from failed f where f.source is not null and (p_source is null or f.source::uuid = p_source);
$$;
revoke all on function accounting.pending_postings(uuid) from public, anon;
grant execute on function accounting.pending_postings(uuid) to authenticated, service_role;
