-- 0062_kernel_runnable_processes
-- Forward-only migration (rule 34). Covered by packages/kernel/src/process/__tests__/runnable.integration.test.ts.
-- The shell and every page ask which of a list of processes the caller may run (kernel.runnable_processes of the web app, 45 times
-- for one record page). The query called kernel.can_run_process once per process, and each call asked again who the caller is
-- (administrator, roles, company): 7 ms a question on the hosted project. This answers the whole list with the caller's identity
-- read once. Same rule as kernel.can_run_process (0021): an administrator runs everything; otherwise a role of the active company
-- holds the permission and no menu rule hides the process. `member` is the membership check the callers combine with it.

create or replace function kernel.runnable_processes(p_ids text[])
returns table (id text, allowed boolean, member boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin     boolean := kernel.is_company_admin();
  v_company   uuid := kernel.current_company_id();
  v_companies uuid[] := kernel.current_company_ids();
  v_roles     uuid[] := kernel.current_role_ids();
  v_member    boolean := coalesce(v_company = any (v_companies), false) and not kernel.membership_inactive();
begin
  return query
  select p.pid,
         v_admin or (
           exists (
             select 1 from kernel.process_permissions pp
             where pp.process_id = p.pid and pp.company_id = v_company and array[pp.company_id] <@ v_companies
               and pp.role_id = any (v_roles) and pp.allowed
           )
           and not kernel.menu_hides_process(p.pid)
         ),
         v_member
  from unnest(p_ids) as p(pid);
end;
$$;
revoke execute on function kernel.runnable_processes(text[]) from public, anon;
grant execute on function kernel.runnable_processes(text[]) to authenticated, service_role;
