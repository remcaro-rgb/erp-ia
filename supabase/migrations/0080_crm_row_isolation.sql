-- 0080_crm_row_isolation
-- Forward-only migration (rule 34). Covered by packages/modules/crm/src/__tests__/opportunity.integration.test.ts and lead.integration.test.ts.
-- Review of Task 11 (0079): row isolation (design §6) must follow the oportunidad everywhere it can be read.
--  * crm.opportunity_lines: a line is visible exactly when its oportunidad is, so a salesperson cannot read the lines (products, prices)
--    of a neighbour's deal. The subquery runs under the caller's own policies, the parent's owner_scope included.
--  * crm.leads: a prospecto has an owner like an oportunidad and exposes the id of the one it became, so it follows the same rule: its
--    owner, everyone for an unowned one, and whoever may run crm.opportunity.reassign (a company admin always may) see it.
--  * crm.is_company_member: crm.opportunity.reassign validates the new owner through this definer helper instead of reading
--    kernel.memberships under the caller's RLS.

create policy owner_scope on crm.opportunity_lines as restrictive for select to authenticated
  using (exists (select 1 from crm.opportunities o where o.id = opportunity_id));

create policy owner_scope on crm.leads as restrictive for select to authenticated
  using (owner_id is null or owner_id = (select kernel.current_user_id()) or (select kernel.can_run_process('crm.opportunity.reassign')));

create or replace function crm.is_company_member(p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from kernel.memberships m
    where m.user_id = p_user
      and m.company_id = kernel.current_company_id()
      and array[m.company_id] <@ kernel.current_company_ids()
  );
$$;
revoke execute on function crm.is_company_member(uuid) from public, anon;
grant execute on function crm.is_company_member(uuid) to authenticated, service_role;
