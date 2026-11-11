-- 0088_kernel_dismiss_events_lock
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/posting.integration.test.ts (dismissal vs posting)
-- and packages/modules/sales/src/__tests__/delivery.integration.test.ts.
-- Plan 2B Task 14 (review): a source voided while its own posting event is still on its way. kernel.dismiss_events (0078) marks the
-- undelivered events of a source as handled by the posting module so they never post; it now takes the outbox rows FOR NO KEY UPDATE (in
-- id order) before marking them. NO KEY: two such locks conflict with each other (the post and the dismissal serialize), but not with the
-- KEY SHARE lock the foreign key of kernel.outbox_deliveries takes when the dispatcher marks a delivery. The posting module's asynchronous
-- post (accounting.entry.post_from_event) takes the same row the same way (kernel.lock_event_for, below) and re-checks the mark inside its
-- own transaction, so a dismissal and a post of one event serialize: either the post commits first (its entry exists
-- and the source's reversal finds it) or the dismissal does (the post then finds the mark and writes nothing).

create or replace function kernel.dismiss_events(p_module text, p_event text, p_match jsonb) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_ids uuid[];
begin
  select coalesce(array_agg(id order by id), '{}') into v_ids from (
    select o.id from kernel.outbox o
    where o.company_id = kernel.current_company_id() and array[o.company_id] <@ kernel.current_company_ids()
      and o.event = p_event and o.payload @> p_match
    order by o.id
    for no key update of o
  ) locked;
  with marked as (
    insert into kernel.outbox_deliveries (outbox_id, module_id)
    select id, p_module from unnest(v_ids) as t(id)
    where not exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = t.id and d.module_id = p_module)
    returning 1
  )
  select count(*)::int into v_count from marked;
  return v_count;
end;
$$;
revoke execute on function kernel.dismiss_events(text, text, jsonb) from public, anon;
grant execute on function kernel.dismiss_events(text, text, jsonb) to authenticated, service_role;

-- The other side of that serialization: the posting module's post of one event (accounting.entry.post_from_event, accounting.posting.retry)
-- takes the event's outbox row FOR NO KEY UPDATE through this function (authenticated users may not lock kernel.outbox themselves) and learns
-- whether `p_module` already holds a delivery mark for it (a dismissal, or a delivery that already ran). Answers false when the event is
-- not one of the caller's active company. Nothing is written.
create or replace function kernel.lock_event_for(p_event uuid, p_module text) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_found uuid;
begin
  select o.id into v_found from kernel.outbox o
  where o.id = p_event and o.company_id = kernel.current_company_id() and array[o.company_id] <@ kernel.current_company_ids()
  for no key update of o;
  if v_found is null then
    return false;
  end if;
  return exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = p_event and d.module_id = p_module);
end;
$$;
revoke execute on function kernel.lock_event_for(uuid, text) from public, anon;
grant execute on function kernel.lock_event_for(uuid, text) to authenticated, service_role;
comment on function kernel.lock_event_for(uuid, text) is
  'Locks one outbox row of the active company FOR NO KEY UPDATE and answers whether the module already marked it handled (posting vs dismissal, Task 14).';
