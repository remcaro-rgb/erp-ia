-- 0119_kernel_dry_run_denial_counters
-- Forward-only migration (rule 34), plan 2B Task 50.7 (owner 2026-11-06, design §22.28, rule 16 second exception). Covered by
-- packages/kernel/src/__tests__/run-process.integration.test.ts and packages/agent/src/__tests__/confirm.integration.test.ts.
-- A denial inside an assistant dry run (the preflight before a confirmation card) writes no audit row; it is counted here instead, once
-- per denial, per company, day, process and code. No role has a direct grant: the count is written only by the SECURITY DEFINER function
-- below, and read through the service connection (service_role). RLS is on and there is no policy, so no user session reads or writes it.

create table kernel.dry_run_denial_counters (
  company_id uuid   not null references kernel.companies (id) on delete cascade,
  day        date   not null,
  process_id text   not null,
  code       text   not null check (code in ('not_entitled', 'forbidden', 'step_up_required', 'record_forbidden')),
  count      bigint not null default 0 check (count >= 0),
  primary key (company_id, day, process_id, code)
);

alter table kernel.dry_run_denial_counters enable row level security;
grant select on kernel.dry_run_denial_counters to service_role;

-- Adds one to the counter of (company, today, process, code). A user session may count only its own active company (a session without a
-- user, the service connection, any company: it records a deactivated member's denial the way the audit does).
create or replace function kernel.count_dry_run_denial(p_company uuid, p_process_id text, p_code text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if kernel.current_user_id() is not null and p_company is distinct from kernel.current_company_id() then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into kernel.dry_run_denial_counters (company_id, day, process_id, code, count)
  values (p_company, (now() at time zone 'utc')::date, p_process_id, p_code, 1)
  on conflict (company_id, day, process_id, code) do update set count = kernel.dry_run_denial_counters.count + 1;
end;
$$;
revoke all on function kernel.count_dry_run_denial(uuid, text, text) from public, anon;
grant execute on function kernel.count_dry_run_denial(uuid, text, text) to authenticated, service_role;
