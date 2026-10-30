-- 0028_kernel_mfa_exempt
-- Forward-only migration (rule 34). Covered by packages/kernel/src/users/__tests__/mfa.integration.test.ts and
-- packages/kernel/src/users/__tests__/users.integration.test.ts.
--
-- Two-step verification opt-out (design §22.19, plan 2026-10-29-phase-1c-mfa-opt-out, Task 1): a user may turn off the
-- second step of their own sign-in (kernel.user.mfa.disable, step-up) unless they hold the system admin role without an
-- exemption; the admin may remove a member's factor and exempt a member from the admin role's requirement
-- (kernel.admin.user.mfa.set, step-up). The factors live in the identity provider and are removed through the AuthAdmin
-- adapter inside the process handlers; the database keeps only the exemption.
--   * kernel.memberships.mfa_exempt: per membership, so an exemption in company A says nothing about company B. Written
--     only inside kernel.admin.user.mfa.set: 0021's write policies on kernel.memberships already admit every
--     `kernel.admin.user.%` process (the company admin only), so they need no change; the row trigger (0002) audits the
--     flag before and after.
--   * The access token hook: 0027's body with the exemption honoured in `requires_mfa` (the system admin role requires
--     the second step unless the membership in the active company is exempt). Same signature and grants.
--   * kernel.v_memberships (the admin's view) and kernel.v_users (the `kernel.user` entity, under the caller's field
--     visibility) gain mfa_exempt, appended after 0027's columns (same leading columns, same predicates).
--   * The existing system admin roles are granted the new admin process (0025's helper), as 0027 did for
--     kernel.admin.user.update; a new company's admin role gets it from kernel.seed_role_defaults (every registered
--     process). kernel.user.mfa.disable is self-service (`permission: "none"`): no role needs a grant.

alter table kernel.memberships add column mfa_exempt boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- The access token hook: 0027's body; `requires_mfa` leaves out an exempt membership. Same signature and grants.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  uid        uuid := nullif(event ->> 'user_id', '')::uuid;
  wanted     uuid := nullif(event -> 'claims' -> 'app_metadata' ->> 'active_company_id', '')::uuid;
  active_id  uuid;
  tenant     uuid;
  user_locale text;
  company_list uuid[];
  role_list  uuid[];
  needs_mfa  boolean := false;
  has_mfa    boolean := false;
  former_id  uuid;
  extra      jsonb;
begin
  select u.locale into user_locale from kernel.users u where u.id = uid;

  -- What 0001's rule chose: the requested company if the user is a member, else the first membership.
  select m.company_id into former_id
  from kernel.memberships m
  where m.user_id = uid
  order by (m.company_id = wanted) desc, m.created_at, m.id
  limit 1;

  -- Active company: the requested one if that membership is active, else the first active membership; with none
  -- active, the requested or the first one (its runs and sign-in are refused as inactive).
  select m.company_id into active_id
  from kernel.memberships m
  where m.user_id = uid
  order by (m.company_id = wanted and m.is_active) desc, m.is_active desc, (m.company_id = wanted) desc, m.created_at, m.id
  limit 1;

  if active_id is not null then
    select c.tenant_id into tenant from kernel.companies c where c.id = active_id;

    select coalesce(array_agg(m.company_id order by m.created_at, m.id), '{}'::uuid[]) into company_list
    from kernel.memberships m
    join kernel.companies c on c.id = m.company_id
    where m.user_id = uid and c.tenant_id = tenant and m.is_active;

    select coalesce(array_agg(distinct mr.role_id), '{}'::uuid[]) into role_list
    from kernel.memberships m
    join kernel.membership_roles mr on mr.membership_id = m.id
    where m.user_id = uid and m.company_id = active_id;

    -- Roles that require two-step verification (phase 1: the system `admin` role), unless the admin exempted this
    -- membership (design §22.19). The web proxy reads this claim, so the check needs no query per request.
    select exists (
      select 1
      from kernel.memberships m
      join kernel.membership_roles mr on mr.membership_id = m.id
      join kernel.roles r on r.id = mr.role_id
      where m.user_id = uid and m.company_id = active_id and r.is_system and r.name = 'admin' and not m.mfa_exempt
    ) into needs_mfa;
  else
    company_list := '{}'::uuid[];
    role_list := '{}'::uuid[];
  end if;

  -- A verified TOTP factor, from the auth schema (not from the client-held user object), so the proxy can
  -- demand the second step of a user who enrolled one, whatever their role.
  select exists (
    select 1 from auth.mfa_factors f where f.user_id = uid and f.factor_type = 'totp' and f.status = 'verified'
  ) into has_mfa;

  extra := jsonb_build_object(
    'company_ids', to_jsonb(company_list),
    'role_ids', to_jsonb(role_list),
    'locale', coalesce(user_locale, 'es-419'),
    'requires_mfa', needs_mfa,
    'mfa_enrolled', has_mfa
  );
  if active_id is not null then
    extra := extra || jsonb_build_object('tenant_id', tenant, 'active_company_id', active_id);
  end if;
  -- The new rule differs from 0001's only by passing over an inactive membership.
  if former_id is distinct from active_id then
    extra := extra || jsonb_build_object('inactive_company_id', former_id);
  end if;

  return jsonb_set(event, '{claims}', (coalesce(event -> 'claims', '{}'::jsonb) - 'inactive_company_id') || extra);
end;
$$;
revoke execute on function kernel.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant execute on function kernel.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------------------------
-- Read views: 0027's kernel.v_users and kernel.v_memberships with the exemption appended (same leading columns, same
-- predicates).
-- ---------------------------------------------------------------------------------------------
create or replace view kernel.v_users with (security_barrier = true) as
select u.id,
       case when (select kernel.field_visible('kernel.user', 'full_name')) then u.full_name end as full_name,
       case when (select kernel.field_visible('kernel.user', 'email')) then u.email end as email,
       case when (select kernel.field_visible('kernel.user', 'locale')) then u.locale end as locale,
       case when own.only and (select kernel.field_visible('kernel.user', 'mobile')) then u.mobile end as mobile,
       u.created_at,
       case when (select kernel.field_visible('kernel.user', 'is_active')) then here.is_active end as is_active,
       case when (select kernel.field_visible('kernel.user', 'mfa_exempt')) then here.mfa_exempt end as mfa_exempt
from kernel.users u
-- Same predicate as kernel.user_of_caller_tenant (0021), inline: every membership of the user is in the caller's tenant.
cross join lateral (
  select not exists (
    select 1 from kernel.memberships o join kernel.companies c on c.id = o.company_id
    where o.user_id = u.id and c.tenant_id is distinct from (select kernel.current_tenant_id())
  ) as only
) own
-- The user's membership in the caller's active company (the caller's own membership must be active, below).
join lateral (
  select m.is_active, m.mfa_exempt from kernel.memberships m
  where m.user_id = u.id
    and m.company_id = (select kernel.current_company_id())
    and array[m.company_id] <@ (select kernel.current_company_ids())
) here on true
where exists (
    select 1 from kernel.memberships me
    where me.user_id = (select kernel.current_user_id())
      and me.company_id = (select kernel.current_company_id())
      and me.is_active
  );

create or replace view kernel.v_memberships with (security_barrier = true) as
select m.id, m.user_id, m.company_id, u.email, u.full_name,
       case when own.only then u.mobile_cc end as mobile_cc,
       case when own.only then u.mobile end as mobile,
       case when own.only then u.photo end as photo,
       m.created_at,
       coalesce((select array_agg(mr.role_id order by mr.role_id) from kernel.membership_roles mr where mr.membership_id = m.id), '{}'::uuid[]) as role_ids,
       kernel.member_mfa_enrolled(m.user_id) as mfa_enrolled,
       m.is_active,
       u.locale,
       m.mfa_exempt
from kernel.memberships m
join kernel.users u on u.id = m.user_id
-- Same predicate as kernel.user_of_caller_tenant, inline (owner's rights): every membership in the caller's tenant.
cross join lateral (
  select not exists (
    select 1 from kernel.memberships o join kernel.companies c on c.id = o.company_id
    where o.user_id = m.user_id and c.tenant_id is distinct from (select kernel.current_tenant_id())
  ) as only
) own
where m.company_id = (select kernel.current_company_id())
  and array[m.company_id] <@ (select kernel.current_company_ids())
  and (select kernel.is_company_admin());

-- ---------------------------------------------------------------------------------------------
-- The new admin process for the system admin roles that already exist (0025's helper; idempotent).
-- ---------------------------------------------------------------------------------------------
select kernel.grant_process_to_system_admins('kernel.admin.user.mfa.set');
