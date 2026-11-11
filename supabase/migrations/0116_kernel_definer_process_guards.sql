-- 0116_kernel_definer_process_guards
-- Forward-only migration (rule 34), Phase 2B.1 final review M-1 (defense in depth, rule 1). Covered by
-- packages/kernel/src/__tests__/definer-guards.integration.test.ts (refused for a user session outside a process run; allowed inside one;
-- a session without a user, the service role's, unchanged). Re-runnable (create or replace; the grants are kept).
--
-- These SECURITY DEFINER functions mutate exactly-once or legal state and were granted to `authenticated` with only the company check:
-- core.next_document_number (consumes a DIAN number), kernel.mark_event_handled and kernel.dismiss_events (mark an event handled, so it
-- never posts), kernel.lock_event_for (takes the outbox row lock) and the per-module record counters. Their sibling functions already
-- require a process run (core.register_document_sequence, core.document_technical_key, payments.allocated_amounts, …). Every caller in the
-- code runs inside a process (runProcess sets erp.audit_process_id for the transaction; a nested run sets the inner process's id; event
-- consumers run processes as the system user): the inline posting of invoicing, payments and costing; the accounting posting processes
-- (entry.post_from_event, posting.retry, posting failure record, reverse_source); the numbering of each module's documents. So a user
-- session outside a process is refused; a session without a user (the service role, migrations, the tests' superuser) passes as before.
-- core.next_document_number requires an invoicing process (as core.document_technical_key does). mark_event_handled and dismiss_events do
-- NOT require the running process to be p_module's: the inline posting of an invoicing (or payments, costing) process marks the POSTING
-- module's delivery, and the kernel cannot name that module (rule 4). Bodies are the latest definitions, unchanged below the guard.

-- core.next_document_number (body as in 0104_core_resolution_keys.sql, guard added)
create or replace function core.next_document_number(p_company uuid, p_type text, p_issued_at date) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_next    bigint;
  v_res     jsonb;
  v_number  bigint;
  v_prefix  text;
  v_key     text;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') not like 'invoicing.%' then
    raise exception 'a DIAN number is drawn only inside a process run of invoicing' using errcode = 'insufficient_privilege';
  end if;
  if p_type not in ('invoice', 'credit_note', 'debit_note') then
    raise exception 'document type % has no DIAN resolution', p_type using errcode = 'invalid_parameter_value';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_company::text || ':' || p_type));

  if p_type <> 'invoice' then
    select id, next_number, resolution, prefix into v_id, v_next, v_res, v_prefix
      from core.document_sequences
     where company_id = p_company and document_type = p_type
     order by (resolution is null or greatest(next_number, (resolution ->> 'from')::bigint) <= (resolution ->> 'to')::bigint) desc,
              seq
     limit 1
     for update;
    if v_id is null then
      return jsonb_build_object('status', 'no_sequence');
    end if;
    if v_res is null then
      update core.document_sequences set next_number = v_next + 1, updated_at = now() where id = v_id;
      return jsonb_build_object('status', 'ok', 'prefix', v_prefix, 'number', v_next);
    end if;
    v_number := greatest(v_next, (v_res ->> 'from')::bigint);
    if v_number > (v_res ->> 'to')::bigint then
      return jsonb_build_object('status', 'out_of_range', 'resolution', v_res);
    end if;
    update core.document_sequences set next_number = v_number + 1, updated_at = now() where id = v_id;
    if core.technical_key_readable() then
      select technical_key into v_key from core.document_resolution_keys
       where company_id = p_company and document_type = p_type and prefix = v_prefix and resolution_number = v_res ->> 'number';
      if v_key is not null then v_res := (v_res - 'technicalKeyEnding') || jsonb_build_object('technicalKey', v_key); end if;
    end if;
    return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number, 'resolution', v_res);
  end if;

  select id, next_number, resolution, prefix into v_id, v_next, v_res, v_prefix
    from core.document_sequences
   where company_id = p_company and document_type = p_type and resolution is not null
   order by (p_issued_at between (resolution ->> 'validFrom')::date and (resolution ->> 'validTo')::date) desc,
            (greatest(next_number, (resolution ->> 'from')::bigint) <= (resolution ->> 'to')::bigint) desc,
            seq
   limit 1
   for update;
  if v_id is null then
    return jsonb_build_object('status', 'no_resolution');
  end if;
  if p_issued_at > (v_res ->> 'validTo')::date then
    return jsonb_build_object('status', 'expired', 'resolution', v_res);
  end if;
  if p_issued_at < (v_res ->> 'validFrom')::date then
    return jsonb_build_object('status', 'not_yet_valid', 'resolution', v_res);
  end if;
  v_number := greatest(v_next, (v_res ->> 'from')::bigint);
  if v_number > (v_res ->> 'to')::bigint then
    return jsonb_build_object('status', 'out_of_range', 'resolution', v_res);
  end if;
  update core.document_sequences set next_number = v_number + 1, updated_at = now() where id = v_id;
  if core.technical_key_readable() then
    select technical_key into v_key from core.document_resolution_keys
     where company_id = p_company and document_type = p_type and prefix = v_prefix and resolution_number = v_res ->> 'number';
    if v_key is not null then v_res := (v_res - 'technicalKeyEnding') || jsonb_build_object('technicalKey', v_key); end if;
  end if;
  return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number, 'resolution', v_res);
end;
$$;

-- kernel.mark_event_handled (body as in 0078_kernel_inline_posting.sql, guard added)
create or replace function kernel.mark_event_handled(p_outbox uuid, p_module text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'an event is marked handled only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from kernel.outbox o
    where o.id = p_outbox and o.company_id = kernel.current_company_id() and array[o.company_id] <@ kernel.current_company_ids()
  ) then
    raise exception 'event % is not in the caller''s active company', p_outbox using errcode = 'insufficient_privilege';
  end if;
  insert into kernel.outbox_deliveries (outbox_id, module_id) values (p_outbox, p_module) on conflict do nothing;
end;
$$;

-- kernel.dismiss_events (body as in 0088_kernel_dismiss_events_lock.sql, guard added)
create or replace function kernel.dismiss_events(p_module text, p_event text, p_match jsonb) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_ids uuid[];
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'events are dismissed only inside a process run' using errcode = 'insufficient_privilege';
  end if;
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

-- kernel.lock_event_for (body as in 0088_kernel_dismiss_events_lock.sql, guard added)
create or replace function kernel.lock_event_for(p_event uuid, p_module text) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_found uuid;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'an event is locked only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  select o.id into v_found from kernel.outbox o
  where o.id = p_event and o.company_id = kernel.current_company_id() and array[o.company_id] <@ kernel.current_company_ids()
  for no key update of o;
  if v_found is null then
    return false;
  end if;
  return exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = p_event and d.module_id = p_module);
end;
$$;

-- inventory.next_movement_number (body as in 0066_inventory_core.sql, guard added)
create or replace function inventory.next_movement_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'a movement number is drawn only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into inventory.movement_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;

-- crm.next_number (body as in 0079_crm_core.sql, guard added)
create or replace function crm.next_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'a CRM number is drawn only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into crm.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;

-- sales.next_number (body as in 0084_sales_orders.sql, guard added)
create or replace function sales.next_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'a sales number is drawn only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into sales.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;

-- costing.next_document_number (body as in 0077_costing_landed.sql, guard added)
create or replace function costing.next_document_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'a costing number is drawn only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into costing.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;

-- payments.next_document_number (body as in 0109_payments_core.sql, guard added)
create or replace function payments.next_document_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- Final review M-1: a user session reaches this only inside a process run (rule 1); a session without a user passes as before.
  if kernel.current_user_id() is not null and coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'a receipt number is drawn only inside a process run' using errcode = 'insufficient_privilege';
  end if;
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

