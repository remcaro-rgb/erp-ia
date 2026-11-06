-- 0078_kernel_inline_posting
-- Forward-only migration (rule 34). Covered by packages/kernel/src/posting/__tests__/inline.test.ts (the calls) and
-- packages/modules/accounting/src/__tests__/inline-posting.integration.test.ts, packages/modules/costing/src/__tests__/landed-cost.integration.test.ts.
-- Inline strict posting (entity types spec §5.2 / D8, Task 9 ruling): a documento that posts puts its entry in the ledger in the
-- action's own transaction, so the event it emitted must not be composed again by the asynchronous posting consumer. The delivery
-- table (one row per event and consuming module that already ran) is the record of that: the dispatcher skips a delivered pair, and the
-- engine checks it first. The table is service-role only, so the action marks its event through these two definer functions, which
-- touch only the caller's active company.

create or replace function kernel.mark_event_handled(p_outbox uuid, p_module text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from kernel.outbox o
    where o.id = p_outbox and o.company_id = kernel.current_company_id() and array[o.company_id] <@ kernel.current_company_ids()
  ) then
    raise exception 'event % is not in the caller''s active company', p_outbox using errcode = 'insufficient_privilege';
  end if;
  insert into kernel.outbox_deliveries (outbox_id, module_id) values (p_outbox, p_module) on conflict do nothing;
end;
$$;
revoke execute on function kernel.mark_event_handled(uuid, text) from public, anon;
grant execute on function kernel.mark_event_handled(uuid, text) to authenticated, service_role;

-- Marks as handled the company's events `p_event` whose payload contains `p_match` and that `p_module` has not run yet (a document that
-- is voided before its parked event reached the ledger: the event must never post afterwards). Answers how many it marked.
create or replace function kernel.dismiss_events(p_module text, p_event text, p_match jsonb) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with marked as (
    insert into kernel.outbox_deliveries (outbox_id, module_id)
    select o.id, p_module from kernel.outbox o
    where o.company_id = kernel.current_company_id() and array[o.company_id] <@ kernel.current_company_ids()
      and o.event = p_event and o.payload @> p_match
      and not exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = o.id and d.module_id = p_module)
    returning 1
  )
  select count(*)::int into v_count from marked;
  return v_count;
end;
$$;
revoke execute on function kernel.dismiss_events(text, text, jsonb) from public, anon;
grant execute on function kernel.dismiss_events(text, text, jsonb) to authenticated, service_role;
