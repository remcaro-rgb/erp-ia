-- 0004_kernel_process_security
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/run-process.integration.test.ts.
-- What runProcess checks before and records around a handler (design §5.4, §6, rules 13 and 15):
-- per-role process permissions, the company's sensitive processes, step-up verifications and the
-- stored results of idempotent runs.

-- ---------------------------------------------------------------------------------------------
-- Process permissions: a role may run a process of its company when a row allows it.
-- ---------------------------------------------------------------------------------------------
create table kernel.process_permissions (
  id         uuid primary key default kernel.uuid_v7(),
  company_id uuid not null references kernel.companies (id),
  role_id    uuid not null references kernel.roles (id) on delete cascade,
  process_id text not null,
  allowed    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, role_id, process_id)
);
create index process_permissions_role_id_idx on kernel.process_permissions (role_id);

create trigger process_permissions_touch_updated before update on kernel.process_permissions
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.process_permissions to authenticated;
grant all on kernel.process_permissions to service_role;

-- Everybody in the active company reads the matrix; only its admin writes it, and only for roles of
-- that company (the restrictive policies are ANDed with company_isolation).
select kernel.enable_company_rls('kernel', 'process_permissions');
create policy admin_insert on kernel.process_permissions as restrictive for insert to authenticated
  with check (
    (select kernel.is_company_admin())
    and exists (select 1 from kernel.roles r where r.id = role_id and r.company_id = process_permissions.company_id)
  );
create policy admin_update on kernel.process_permissions as restrictive for update to authenticated
  using ((select kernel.is_company_admin()))
  with check (
    (select kernel.is_company_admin())
    and exists (select 1 from kernel.roles r where r.id = role_id and r.company_id = process_permissions.company_id)
  );
create policy admin_delete on kernel.process_permissions as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));

select kernel.enable_row_audit('kernel', 'process_permissions');

-- ---------------------------------------------------------------------------------------------
-- Sensitive processes: the admin's list of processes that need a step-up in this company.
-- ---------------------------------------------------------------------------------------------
create table kernel.sensitive_processes (
  company_id uuid not null references kernel.companies (id),
  process_id text not null,
  mode       text not null check (mode in ('self_2fa', 'supervisor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  primary key (company_id, process_id)
);

create trigger sensitive_processes_touch_updated before update on kernel.sensitive_processes
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.sensitive_processes to authenticated;
grant all on kernel.sensitive_processes to service_role;

select kernel.enable_company_rls('kernel', 'sensitive_processes');
create policy admin_insert on kernel.sensitive_processes as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.sensitive_processes as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.sensitive_processes as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));

select kernel.enable_row_audit('kernel', 'sensitive_processes');

-- ---------------------------------------------------------------------------------------------
-- Step-up verifications: one row per successful TOTP check. runProcess accepts a token only for
-- the user who verified, in the company it was verified for, within 5 minutes, once
-- (consumed_at is set in the process transaction).
-- A user reads only their own rows. The user may record a verification for themselves (verified_at
-- always defaults to now()) and may only mark an unconsumed row of their own as consumed; nothing
-- else is writable outside the service role.
-- ---------------------------------------------------------------------------------------------
create table kernel.step_up_verifications (
  id          uuid primary key default kernel.uuid_v7(),
  user_id     uuid not null references kernel.users (id),
  company_id  uuid not null references kernel.companies (id),
  verified_at timestamptz not null default now(),
  token       text not null unique,
  consumed_at timestamptz
);
create index step_up_verifications_user_id_idx on kernel.step_up_verifications (user_id);
create index step_up_verifications_company_id_idx on kernel.step_up_verifications (company_id);

grant select on kernel.step_up_verifications to authenticated;
grant insert (user_id, company_id, token) on kernel.step_up_verifications to authenticated;
grant update (consumed_at) on kernel.step_up_verifications to authenticated;
grant all on kernel.step_up_verifications to service_role;

alter table kernel.step_up_verifications enable row level security;
create policy own_rows on kernel.step_up_verifications for select to authenticated
  using (user_id = (select kernel.current_user_id()));
create policy own_insert on kernel.step_up_verifications for insert to authenticated
  with check (
    user_id = (select kernel.current_user_id())
    and company_id = (select kernel.current_company_id())
    and array[company_id] <@ (select kernel.current_company_ids())
  );
create policy own_consume on kernel.step_up_verifications for update to authenticated
  using (user_id = (select kernel.current_user_id()) and consumed_at is null)
  with check (user_id = (select kernel.current_user_id()) and consumed_at is not null);

-- ---------------------------------------------------------------------------------------------
-- Idempotency: the stored result of a process run per (company, process, key). Written in the
-- process transaction, so a key exists if and only if its run committed.
-- ---------------------------------------------------------------------------------------------
create table kernel.process_idempotency (
  company_id uuid not null references kernel.companies (id),
  process_id text not null,
  key        text not null,
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (company_id, process_id, key)
);

grant select, insert on kernel.process_idempotency to authenticated;
grant all on kernel.process_idempotency to service_role;

select kernel.enable_company_rls('kernel', 'process_idempotency');

-- ---------------------------------------------------------------------------------------------
-- Permission check. True when any of the caller's roles (claim role_ids) has an allowing row for the
-- process in the active company the caller belongs to. Security definer so the check does not
-- depend on the caller's grants on the matrix.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.can_run_process(process_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from kernel.process_permissions pp
    where pp.process_id = can_run_process.process_id
      and pp.company_id = kernel.current_company_id()
      and array[pp.company_id] <@ kernel.current_company_ids()
      and pp.role_id = any (kernel.current_role_ids())
      and pp.allowed
  );
$$;

revoke execute on function kernel.can_run_process(text) from public;
grant execute on function kernel.can_run_process(text) to authenticated, service_role;
