-- 0024_kernel_role_claims
-- Forward-only migration (rule 34). Covered by packages/kernel/src/admin/__tests__/role-claims.integration.test.ts.
--
-- Final review I1 (2026-10-28): role revocation applies at once. Until now kernel.current_role_ids() returned the JWT's
-- role_ids claim verbatim, so a role the admin took away (kernel.admin.user_role.set) kept its process rights, field
-- visibility and admin bypass until the user's token was refreshed (up to JWT_EXP, one hour). It now returns the
-- claim's roles that the caller still holds in the active company (kernel.membership_roles ⋈ kernel.memberships). Same
-- signature, so every helper built on it inherits the check: is_company_admin, party_scope, can_run_process,
-- field_mode / field_visible, mask_extra and the recommendation policies. A role granted after the token was issued
-- still needs a refresh (the claim does not name it yet), which is harmless.
--
-- The kernel's system user (the nil uuid, events/consumers.ts) runs event consumers as the company's system admin role
-- without a membership. Its claims are minted only server-side, on the service connection; Auth never issues the nil
-- uuid, and a request through PostgREST (session user `authenticator`) cannot use it. Its claim is kept as it is.
-- A connection without claims (the service role) gets no roles, as before.
--
-- Cost: security definer + `set search_path` keeps the function out of the planner's inlining, so callers wrap it in
-- `(select …)` (one InitPlan per statement); the helpers above are themselves called through `(select …)` in policies
-- and views. The two recommendation policies and their view called it bare (per row): they are recreated below with the
-- InitPlan form, and mask_extra (called per row by the masked views) reads it once per call instead of once per key.

create or replace function kernel.current_role_ids() returns uuid[]
language sql stable security definer parallel safe
set search_path = ''
as $$
  select coalesce(
    array(
      select claimed.id
      from (select distinct jsonb_array_elements_text(kernel.jwt_claims() -> 'role_ids')::uuid as id) as claimed
      where (
          kernel.current_user_id() = '00000000-0000-0000-0000-000000000000'::uuid
          and session_user <> 'authenticator'
        )
        or exists (
          select 1
          from kernel.membership_roles mr
          join kernel.memberships m on m.id = mr.membership_id
          where m.user_id = kernel.current_user_id()
            and m.company_id = kernel.current_company_id()
            and mr.role_id = claimed.id
        )
      order by claimed.id
    ),
    '{}'::uuid[]
  );
$$;

-- Same body as 0003 with the caller's roles read once per call (the masked views call it per row).
create or replace function kernel.mask_extra(p_entity text, p_extra jsonb) returns jsonb
language plpgsql stable security definer parallel safe
set search_path = ''
as $$
declare
  v_roles uuid[];
begin
  if p_extra is null or p_extra = '{}'::jsonb then
    return p_extra;
  end if;
  if jsonb_typeof(p_extra) <> 'object' or not array[kernel.current_company_id()] <@ kernel.current_company_ids() then
    return '{}'::jsonb;
  end if;
  v_roles := kernel.current_role_ids();
  return coalesce(
    (
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(p_extra) as e
      where exists (
        select 1
        from kernel.custom_fields cf
        where cf.company_id = kernel.current_company_id()
          and cf.entity = p_entity
          and cf.key = e.key
          and cf.roles_view && v_roles
      )
    ),
    '{}'::jsonb
  );
end;
$$;

-- 0022's recommendation policies and view, with the caller's roles as an InitPlan instead of a per-row call.
drop policy audience on kernel.recommendations;
create policy audience on kernel.recommendations as restrictive for select to authenticated
  using (user_id = (select kernel.current_user_id()) or audience_role_id = any ((select kernel.current_role_ids())::uuid[]));

drop policy via_process_update on kernel.recommendations;
create policy via_process_update on kernel.recommendations as restrictive for update to authenticated
  using (
    coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.recommendation.decide'
    and status = 'new'
    and (user_id = (select kernel.current_user_id()) or audience_role_id = any ((select kernel.current_role_ids())::uuid[]))
  )
  with check (
    status in ('accepted', 'dismissed')
    and decided_by = (select kernel.current_user_id())
  );

create or replace view kernel.v_recommendations with (security_invoker = true) as
select id, company_id, seq, audience_role_id, user_id, agent_profile, title, body, evidence, suggested_actions, confidence,
       status, decided_at, decided_by, created_at, updated_at
from kernel.recommendations
where user_id = (select kernel.current_user_id()) or audience_role_id = any ((select kernel.current_role_ids())::uuid[]);
