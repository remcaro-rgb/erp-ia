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
