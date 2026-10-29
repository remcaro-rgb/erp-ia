-- 0027_kernel_user_update
-- Forward-only migration (rule 34). Covered by packages/kernel/src/admin/__tests__/user-update.integration.test.ts and
-- apps/web/src/lib/auth/__tests__/login.integration.test.ts.
--
-- Editable users (design §22.16, Task 7 of phase 1b): the admin edits a member's name, mobile, photo, locale, roles and
-- active state through kernel.admin.user.update (step-up). Deactivating removes access without deleting history:
-- kernel.memberships.is_active (0025) goes false, the roles and the audit stay.
--   * The writes of the process. kernel.memberships already accepts `kernel.admin.user.%` (0021); kernel.membership_roles
--     names its processes one by one and now also accepts kernel.admin.user.update (the roles go through the same helper
--     as kernel.admin.user_role.set). kernel.users has no write grant for users (0021): kernel.admin_update_user changes
--     a profile, only inside that process, for the company admin, and only for a member of the active company who
--     belongs to the caller's organization alone.
--   * Who is inactive. kernel.membership_inactive() answers whether the caller's membership in the active company is
--     deactivated: runProcess refuses such a caller at its gate (forbidden, also for self-service processes and for an
--     admin's old claims), the sign-in refuses the session and the shell signs it out. The kernel's system user has no
--     membership and is never inactive.
--   * The company keeps an active admin. A membership holding the system admin role is not deactivated when no other
--     active member of the company holds it (whoever writes); the refusal follows the SQL_INVALID_INPUT convention of
--     runProcess, so the admin reads it as the reason. Deactivations of one company are serialized so two admins
--     deactivating each other at once cannot both pass.
--   * kernel.v_users gains is_active (the member's state in the caller's active company) and kernel.v_memberships the
--     member's locale, for the user's page and the `kernel.user` entity. The audit log is indexed by actor for the
--     page's "última actividad".
--   * The existing system admin roles are granted the new process (0025's helper), as kernel.audit.entry was; a new
--     company's admin role gets it from kernel.seed_role_defaults (every registered process).
--   * Deactivation is per company (review of Task 7). The access token hook (0001) prefers an active membership for the
--     active company and lists only active memberships in company_ids, so a person deactivated in company B keeps
--     working in A (and the company switcher never offers B). kernel.active_company_ids() answers the same from the
--     database for a token issued before the change. Only a person with no active membership left is locked out.
--   * Removing the system admin role (kernel.admin.user_role.set / kernel.admin.user.update) takes the same company lock
--     as the deactivation trigger through kernel.lock_active_admins(), so the two cannot together leave the company
--     without an active admin.

-- ---------------------------------------------------------------------------------------------
-- kernel.membership_roles: the roles of a member, also written by kernel.admin.user.update.
-- ---------------------------------------------------------------------------------------------
alter policy via_process_insert on kernel.membership_roles
  with check (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set', 'kernel.admin.user.update'));
alter policy via_process_update on kernel.membership_roles
  using (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set', 'kernel.admin.user.update'))
  with check (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set', 'kernel.admin.user.update'));
alter policy via_process_delete on kernel.membership_roles
  using (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set', 'kernel.admin.user.update'));

-- ---------------------------------------------------------------------------------------------
-- A member's profile, changed by the admin (kernel.admin.user.update). A null argument keeps the column; the photo is
-- replaced (or removed with null) only when p_set_photo. The column checks of 0021 still apply.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.admin_update_user(
  p_id uuid, p_full_name text, p_mobile_cc text, p_mobile text, p_set_photo boolean, p_photo text, p_locale text
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not (kernel.is_company_admin() and coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.admin.user.update') then
    raise exception 'only the company admin, inside kernel.admin.user.update, may change a user' using errcode = '42501';
  end if;
  if not exists (
    select 1 from kernel.memberships m
    where m.user_id = p_id and m.company_id = kernel.current_company_id() and array[m.company_id] <@ kernel.current_company_ids()
  ) then
    raise exception 'user % is not a member of the active company', p_id using errcode = '22023';
  end if;
  -- A profile shared with another organization (data from before the one-tenant rule) is not this one's to change.
  if exists (
    select 1 from kernel.memberships m join kernel.companies c on c.id = m.company_id
    where m.user_id = p_id and c.tenant_id is distinct from kernel.current_tenant_id()
  ) then
    raise exception 'user % belongs to another organization', p_id using errcode = '42501';
  end if;
  update kernel.users set
    full_name = coalesce(p_full_name, full_name),
    mobile_cc = coalesce(p_mobile_cc, mobile_cc),
    mobile    = coalesce(p_mobile, mobile),
    photo     = case when p_set_photo then p_photo else photo end,
    locale    = coalesce(p_locale, locale)
  where id = p_id;
end;
$$;
revoke execute on function kernel.admin_update_user(uuid, text, text, text, boolean, text, text) from public, anon;
grant execute on function kernel.admin_update_user(uuid, text, text, text, boolean, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Whether the caller's membership in the active company is deactivated (false without one: the service connection,
-- the kernel's system user, a non-member, who are answered by the other checks).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.membership_inactive() returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from kernel.memberships m
    where m.user_id = kernel.current_user_id()
      and m.company_id = kernel.current_company_id()
      and not m.is_active
  );
$$;
revoke execute on function kernel.membership_inactive() from public, anon;
grant execute on function kernel.membership_inactive() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The caller's companies where their membership is active: the companies of the caller's claims (same tenant) that a
-- token issued before a deactivation may still name. The company switcher offers only these.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.active_company_ids() returns uuid[]
language sql stable security definer parallel safe
set search_path = ''
as $$
  select coalesce(
    array(
      select m.company_id from kernel.memberships m
      where m.user_id = kernel.current_user_id()
        and m.is_active
        and m.company_id = any (kernel.current_company_ids())
      order by m.company_id
    ),
    '{}'::uuid[]
  );
$$;
revoke execute on function kernel.active_company_ids() from public, anon;
grant execute on function kernel.active_company_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The active memberships that hold the system admin role of the active company, read under the company lock the
-- deactivation trigger takes (below): an admin process about to remove the admin role from someone calls it first and
-- refuses when nobody would be left. For the company admin inside a user admin process only.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.lock_active_admins() returns uuid[]
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_admins uuid[];
begin
  if not (kernel.is_company_admin() and coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.user%') then
    raise exception 'only the company admin, inside a user admin process, may lock the company''s admins' using errcode = '42501';
  end if;
  perform 1 from kernel.companies c where c.id = kernel.current_company_id() for no key update;
  -- A statement after the lock: it sees what a deactivation that held the lock before committed.
  select coalesce(array_agg(distinct m.id order by m.id), '{}'::uuid[]) into v_admins
  from kernel.memberships m
  join kernel.membership_roles mr on mr.membership_id = m.id
  join kernel.roles r on r.id = mr.role_id
  where m.company_id = kernel.current_company_id() and m.is_active
    and r.company_id = m.company_id and r.is_system and r.name = 'admin';
  return v_admins;
end;
$$;
revoke execute on function kernel.lock_active_admins() from public, anon;
grant execute on function kernel.lock_active_admins() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The access token hook: 0001's body with the membership state. The active company is the requested one when that
-- membership is active, else the first active membership, else (nobody active: the sign-in refuses) the requested or
-- first one; company_ids are the active memberships of that company's tenant. Same signature and grants.
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
  extra      jsonb;
begin
  select u.locale into user_locale from kernel.users u where u.id = uid;

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

    -- Roles that require two-step verification (phase 1: the system `admin` role). The web proxy reads this
    -- claim, so the check needs no query per request.
    select exists (
      select 1
      from kernel.memberships m
      join kernel.membership_roles mr on mr.membership_id = m.id
      join kernel.roles r on r.id = mr.role_id
      where m.user_id = uid and m.company_id = active_id and r.is_system and r.name = 'admin'
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

  return jsonb_set(event, '{claims}', coalesce(event -> 'claims', '{}'::jsonb) || extra);
end;
$$;
revoke execute on function kernel.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant execute on function kernel.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------------------------
-- The company keeps at least one active admin.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.keep_an_active_admin() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not (old.is_active and not new.is_active) then
    return new;
  end if;
  -- One deactivation per company at a time: a concurrent one waits here and then sees this one's result.
  perform 1 from kernel.companies c where c.id = new.company_id for no key update;
  if exists (
      select 1 from kernel.membership_roles mr join kernel.roles r on r.id = mr.role_id
      where mr.membership_id = new.id and r.is_system and r.name = 'admin'
    )
    and not exists (
      select 1
      from kernel.memberships m
      join kernel.membership_roles mr on mr.membership_id = m.id
      join kernel.roles r on r.id = mr.role_id
      where m.company_id = new.company_id and m.id <> new.id and m.is_active
        and r.company_id = new.company_id and r.is_system and r.name = 'admin'
    )
  then
    raise exception 'erp:invalid_input:La empresa necesita al menos un administrador activo';
  end if;
  return new;
end;
$$;
revoke execute on function kernel.keep_an_active_admin() from public, anon, authenticated;

create trigger memberships_keep_an_active_admin before update of is_active on kernel.memberships
  for each row execute function kernel.keep_an_active_admin();

-- ---------------------------------------------------------------------------------------------
-- Read views: 0026's kernel.v_users with the member's state appended (same leading columns, same predicates), and
-- 0025's kernel.v_memberships with the member's locale appended.
-- ---------------------------------------------------------------------------------------------
create or replace view kernel.v_users with (security_barrier = true) as
select u.id,
       case when (select kernel.field_visible('kernel.user', 'full_name')) then u.full_name end as full_name,
       case when (select kernel.field_visible('kernel.user', 'email')) then u.email end as email,
       case when (select kernel.field_visible('kernel.user', 'locale')) then u.locale end as locale,
       case when own.only and (select kernel.field_visible('kernel.user', 'mobile')) then u.mobile end as mobile,
       u.created_at,
       case when (select kernel.field_visible('kernel.user', 'is_active')) then here.is_active end as is_active
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
  select m.is_active from kernel.memberships m
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
       u.locale
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

-- The user page's last activity: the newest entry of an actor in the company.
create index if not exists audit_log_company_actor_idx on kernel.audit_log (company_id, actor_user_id, occurred_at desc);

-- ---------------------------------------------------------------------------------------------
-- The new process for the system admin roles that already exist (0025's helper; idempotent).
-- ---------------------------------------------------------------------------------------------
select kernel.grant_process_to_system_admins('kernel.admin.user.update');
