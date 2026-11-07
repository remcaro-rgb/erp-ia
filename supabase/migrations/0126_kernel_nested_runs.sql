-- 0126_kernel_nested_runs
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/nested-run-config.integration.test.ts and
-- packages/kernel/src/__tests__/definer-guards.integration.test.ts.
-- Configurable nested runs (owner 2026-11-06, decisions items 1 and 2, plan 2B Task 32). ctx.runProcess runs another registered process in
-- the outer run's transaction; the company admin now configures, per pair (parent process → nested process):
--   * whether the parent's fresh TOTP (≤ 5 minutes, same user, consumed by this very run) covers a step-up nested process (default off);
--   * whether a failure of the nested run rolls everything back (default) or continues: the nested run is undone by a savepoint and the
--     failure goes to a queue (kernel.nested_run_failures) that admins and roles granted kernel.nested_failure.retry see and retry;
--   * the company's nesting depth (default 4, hard maximum 8).
-- No row means the default, so a company without configuration runs as before. The kernel names no module (rule 4): process ids are opaque.
-- Writes only through the definer writers below, each inside the run of its own process (rule 1) and for a company admin; users have no
-- write grant. The queue's raw input (kept only for the retry) is not readable by users (rule 14): the view omits it.

create table kernel.nested_run_settings (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null unique references kernel.companies (id),
  max_depth   int not null default 4 check (max_depth between 1 and 8),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq)
);

create table kernel.nested_run_pairs (
  id                  uuid primary key default kernel.uuid_v7(),
  seq                 bigint not null,
  company_id          uuid not null references kernel.companies (id),
  parent_process      text not null,
  nested_process      text not null,
  parent_totp_covers  boolean not null default false,
  on_failure          text not null default 'rollback' check (on_failure in ('rollback', 'continue')),
  extra               jsonb not null default '{}'::jsonb,
  extra_free          jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid default kernel.current_user_id(),
  updated_by          uuid,
  unique (company_id, seq),
  unique (company_id, parent_process, nested_process),
  check (parent_process <> nested_process)
);

create table kernel.nested_run_failures (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  parent_process  text not null,
  nested_process  text not null,
  input           jsonb not null,
  error_code      text not null,
  reason          text not null check (length(reason) <= 500),
  chain_id        uuid not null,
  actor_user_id   uuid not null,
  origin          text not null,
  status          text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  attempts        int not null default 0,
  retry_chain_id  uuid,
  resolved_by     uuid,
  resolved_at     timestamptz,
  dismissed_by    uuid,
  dismissed_at    timestamptz,
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq)
);
create index nested_run_failures_open_idx on kernel.nested_run_failures (company_id, status, created_at desc);

create trigger assign_seq before insert on kernel.nested_run_settings for each row execute function core.assign_seq('kernel.nested_run_setting');
create trigger assign_seq before insert on kernel.nested_run_pairs for each row execute function core.assign_seq('kernel.nested_run_pair');
create trigger assign_seq before insert on kernel.nested_run_failures for each row execute function core.assign_seq('kernel.nested_run_failure');
create trigger nested_run_settings_touch_updated before update on kernel.nested_run_settings for each row execute function kernel.touch_updated();
create trigger nested_run_pairs_touch_updated before update on kernel.nested_run_pairs for each row execute function kernel.touch_updated();
create trigger nested_run_failures_touch_updated before update on kernel.nested_run_failures for each row execute function kernel.touch_updated();

-- Grants: users read the settings and pairs (a company admin only, by policy) and the queue without its input (an admin or a role granted
-- the retry, by policy); nobody writes outside the definer writers. The row audit records every column, `input` included (decisions item 69).
revoke all on kernel.nested_run_settings, kernel.nested_run_pairs, kernel.nested_run_failures from authenticated, anon;
grant all on kernel.nested_run_settings, kernel.nested_run_pairs, kernel.nested_run_failures to service_role;
grant select on kernel.nested_run_settings, kernel.nested_run_pairs to authenticated;
grant select (id, seq, company_id, parent_process, nested_process, error_code, reason, chain_id, actor_user_id, origin, status, attempts,
              retry_chain_id, resolved_by, resolved_at, dismissed_by, dismissed_at, extra, extra_free, created_at, updated_at, created_by,
              updated_by)
  on kernel.nested_run_failures to authenticated;

select kernel.enable_company_rls('kernel', 'nested_run_settings');
select kernel.enable_company_rls('kernel', 'nested_run_pairs');
select kernel.enable_company_rls('kernel', 'nested_run_failures');
select kernel.enable_row_audit('kernel', 'nested_run_settings');
select kernel.enable_row_audit('kernel', 'nested_run_pairs');
select kernel.enable_row_audit('kernel', 'nested_run_failures');

create policy admin_only on kernel.nested_run_settings as restrictive for select to authenticated using (kernel.is_company_admin());
create policy admin_only on kernel.nested_run_pairs as restrictive for select to authenticated using (kernel.is_company_admin());
create policy queue_audience on kernel.nested_run_failures as restrictive for select to authenticated
  using (kernel.is_company_admin() or kernel.can_run_process('kernel.nested_failure.retry'));

create view kernel.v_nested_run_failures with (security_invoker = true) as
  select id, seq, company_id, parent_process, nested_process, error_code, reason, chain_id, actor_user_id, origin, status, attempts,
         retry_chain_id, resolved_by, resolved_at, dismissed_by, dismissed_at, created_at
  from kernel.nested_run_failures;
revoke all on kernel.v_nested_run_failures from anon;
grant select on kernel.v_nested_run_failures to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The policy of one nested call, for the caller's active company: whether the parent's TOTP covers the nested process, what a failure does
-- and the company's depth. Defaults (false, 'rollback', 4) when there is no row, or no active company the caller belongs to. Read-only.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.nested_run_policy(p_parent text, p_nested text) returns table (totp_covers boolean, on_failure text, max_depth int)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := kernel.current_company_id();
  v_member boolean := v_company is not null and coalesce(array[v_company] <@ kernel.current_company_ids(), false);
begin
  totp_covers := false;
  on_failure := 'rollback';
  max_depth := 4;
  if v_member then
    select p.parent_totp_covers, p.on_failure into totp_covers, on_failure
    from kernel.nested_run_pairs p
    where p.company_id = v_company and p.parent_process = p_parent and p.nested_process = p_nested;
    if not found then
      totp_covers := false;
      on_failure := 'rollback';
    end if;
    select coalesce((select s.max_depth from kernel.nested_run_settings s where s.company_id = v_company), 4) into max_depth;
  end if;
  return next;
end;
$$;
revoke execute on function kernel.nested_run_policy(text, text) from public, anon;
grant execute on function kernel.nested_run_policy(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The gate of the writers: a user session reaches them only inside the run of the process named (rule 1); `p_audience`, when set, is the
-- extra condition on the caller (a company admin, or a holder of the process). A session without a user (service role) is not refused.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.nested_run_writer(p_process text, p_admin_only boolean) returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') <> p_process then
    raise exception 'the nested-run configuration is written only inside a process run of %', p_process using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not coalesce(array[v_company] <@ kernel.current_company_ids(), false) then
    raise exception 'the nested-run configuration is written only inside a process run of % for the caller''s active company', p_process using errcode = 'insufficient_privilege';
  end if;
  if not kernel.is_company_admin() and (p_admin_only or not kernel.can_run_process(p_process)) then
    raise exception 'the nested-run configuration is written only inside a process run of % by a company admin or a role granted it', p_process using errcode = 'insufficient_privilege';
  end if;
  return v_company;
end;
$$;
revoke execute on function kernel.nested_run_writer(text, boolean) from public, anon, authenticated;
grant execute on function kernel.nested_run_writer(text, boolean) to service_role;

-- One pair: updated in place when it exists (its seq is kept), inserted otherwise (gap-free seq: no insert attempt that could conflict).
create or replace function kernel.nested_run_pair_set(p_parent text, p_nested text, p_totp boolean, p_on_failure text) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.nested_run_writer('kernel.admin.nested_run.pair.set', true);
  v_id uuid;
begin
  if p_parent is null or p_nested is null or p_totp is null or p_on_failure is null then
    raise exception 'a nested-run pair needs its parent, nested process, coverage and failure mode' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kernel.nested_run_pair:' || v_company || ':' || p_parent || ':' || p_nested, 0));
  update kernel.nested_run_pairs p
  set parent_totp_covers = p_totp, on_failure = p_on_failure, updated_by = kernel.current_user_id()
  where p.company_id = v_company and p.parent_process = p_parent and p.nested_process = p_nested
  returning p.id into v_id;
  if v_id is null then
    insert into kernel.nested_run_pairs (company_id, parent_process, nested_process, parent_totp_covers, on_failure)
    values (v_company, p_parent, p_nested, p_totp, p_on_failure)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function kernel.nested_run_pair_set(text, text, boolean, text) from public, anon;
grant execute on function kernel.nested_run_pair_set(text, text, boolean, text) to authenticated, service_role;

create or replace function kernel.nested_run_depth_set(p_depth int) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.nested_run_writer('kernel.admin.nested_run.depth.set', true);
  v_id uuid;
begin
  if p_depth is null or p_depth < 1 or p_depth > 8 then
    raise exception 'the nesting depth is between 1 and 8, got %', p_depth using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kernel.nested_run_setting:' || v_company, 0));
  update kernel.nested_run_settings s set max_depth = p_depth, updated_by = kernel.current_user_id()
  where s.company_id = v_company
  returning s.id into v_id;
  if v_id is null then
    insert into kernel.nested_run_settings (company_id, max_depth) values (v_company, p_depth) returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function kernel.nested_run_depth_set(int) from public, anon;
grant execute on function kernel.nested_run_depth_set(int) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- A queued failure, written by the parent's run right after its savepoint was rolled back: only for registered processes and a pair whose
-- failure mode is `continue`. First purges the company's resolved and dismissed rows older than 90 days (pending rows are never purged).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.nested_failure_record(p_parent text, p_nested text, p_input jsonb, p_code text, p_reason text, p_chain uuid, p_origin text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_id uuid;
begin
  if p_parent is null or coalesce(current_setting('erp.audit_process_id', true), '') <> p_parent then
    raise exception 'a nested-run failure is written only inside a process run of its parent %', coalesce(p_parent, '(none)') using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not coalesce(array[v_company] <@ kernel.current_company_ids(), false) then
    raise exception 'a nested-run failure is written only inside a process run for the caller''s active company' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from kernel.registered_processes rp where rp.process_id = p_parent)
     or not exists (select 1 from kernel.registered_processes rp where rp.process_id = p_nested) then
    raise exception 'a nested-run failure names registered processes only (% → %)', p_parent, p_nested using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from kernel.nested_run_pairs p
    where p.company_id = v_company and p.parent_process = p_parent and p.nested_process = p_nested and p.on_failure = 'continue'
  ) then
    raise exception 'a nested-run failure is queued only inside a process run of a pair set to continue (% → %)', p_parent, p_nested using errcode = 'insufficient_privilege';
  end if;

  delete from kernel.nested_run_failures f
  where f.company_id = v_company and f.status in ('resolved', 'dismissed')
    and coalesce(f.resolved_at, f.dismissed_at, f.updated_at) < now() - interval '90 days';

  insert into kernel.nested_run_failures (company_id, parent_process, nested_process, input, error_code, reason, chain_id, actor_user_id, origin)
  values (v_company, p_parent, p_nested, coalesce(p_input, '{}'::jsonb), p_code, left(coalesce(p_reason, ''), 500), p_chain, kernel.current_user_id(), p_origin)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function kernel.nested_failure_record(text, text, jsonb, text, text, uuid, text) from public, anon;
grant execute on function kernel.nested_failure_record(text, text, jsonb, text, text, uuid, text) to authenticated, service_role;

-- The pending row a retry replays, locked for the retry's transaction (none when it is not pending or not of the active company).
create or replace function kernel.nested_failure_take(p_id uuid)
returns table (parent_process text, nested_process text, input jsonb, chain_id uuid, actor_user_id uuid)
language plpgsql volatile security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := kernel.nested_run_writer('kernel.nested_failure.retry', false);
begin
  return query
    select f.parent_process, f.nested_process, f.input, f.chain_id, f.actor_user_id
    from kernel.nested_run_failures f
    where f.id = p_id and f.company_id = v_company and f.status = 'pending'
    for update;
end;
$$;
revoke execute on function kernel.nested_failure_take(uuid) from public, anon;
grant execute on function kernel.nested_failure_take(uuid) to authenticated, service_role;

-- Closes a pending row: `resolved` by a retry (one more attempt, the retry's chain), `dismissed` by a dismissal. True when a row was closed.
create or replace function kernel.nested_failure_close(p_id uuid, p_status text, p_retry_chain uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_user uuid := kernel.current_user_id();
begin
  if p_status = 'resolved' then
    v_company := kernel.nested_run_writer('kernel.nested_failure.retry', false);
    update kernel.nested_run_failures f
    set status = 'resolved', attempts = f.attempts + 1, retry_chain_id = p_retry_chain, resolved_by = v_user, resolved_at = now(), updated_by = v_user
    where f.id = p_id and f.company_id = v_company and f.status = 'pending';
  elsif p_status = 'dismissed' then
    v_company := kernel.nested_run_writer('kernel.nested_failure.dismiss', false);
    update kernel.nested_run_failures f
    set status = 'dismissed', dismissed_by = v_user, dismissed_at = now(), updated_by = v_user
    where f.id = p_id and f.company_id = v_company and f.status = 'pending';
  else
    -- Still a guarded call: an unknown status from a user session outside a run is refused as such first.
    perform kernel.nested_run_writer('kernel.nested_failure.retry', false);
    raise exception 'a nested-run failure closes as resolved or dismissed, got %', p_status using errcode = 'invalid_parameter_value';
  end if;
  return found;
end;
$$;
revoke execute on function kernel.nested_failure_close(uuid, text, uuid) from public, anon;
grant execute on function kernel.nested_failure_close(uuid, text, uuid) to authenticated, service_role;
