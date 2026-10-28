-- 0021_kernel_admin
-- Forward-only migration (rule 34). Covered by packages/kernel/src/admin/__tests__/admin.integration.test.ts and the
-- admin suites of core (packages/modules/core/src/__tests__/admin.integration.test.ts) and support.
-- Administration (design §6, §5.12–§5.18, rules 13–15): what the kernel.admin.* processes need.
--   * Roles carry a description; users a mobile (country code + number, rule 11) and an optional photo.
--   * The registry reaches SQL: kernel.registered_processes and kernel.entity_fields are written by syncModuleManifest,
--     so the seeds know every process (with its kind) and every confidential field.
--   * The admin-written kernel tables accept writes from users only inside their admin process (runProcess sets
--     erp.audit_process_id), on top of the company-admin policies of 0001/0003/0004/0005/0007/0009: a company admin
--     can no longer change the permission matrix with a bare statement, only through an audited process.
--   * Seeds: kernel.seed_role_defaults (baseline grants + confidential fields masked), kernel.sync_sensitive_defaults
--     (every admin process needs the step-up), kernel.seed_company_defaults (a new company's defaults).
--   * Read views for the admin pages and the active company's entitlement answers they need.

-- ---------------------------------------------------------------------------------------------
-- Roles and users
-- ---------------------------------------------------------------------------------------------
alter table kernel.roles add column description text not null default '';

-- The user's mobile (rule 11: country code + number, validated by kernel.admin.user.create with validatePhone) and
-- an optional photo: a small data URL (PNG, JPEG or WebP) the avatar shows.
alter table kernel.users
  add column mobile_cc text check (mobile_cc is null or mobile_cc ~ '^\d{1,3}$'),
  add column mobile    text check (mobile is null or mobile ~ '^\d{6,14}$'),
  add column photo     text check (photo is null or (photo ~ '^data:image/(png|jpeg|webp);base64,' and length(photo) <= 400000));

-- ---------------------------------------------------------------------------------------------
-- The registry in SQL. Global (not per tenant), written by syncModuleManifest as the service role when a module's
-- manifest is registered at boot; everybody reads it.
-- ---------------------------------------------------------------------------------------------
create table kernel.registered_processes (
  process_id text primary key,
  module_id  text not null,
  feature_id text,
  kind       text not null check (kind in ('create', 'update', 'delete', 'consult')),
  -- The process always asks for the step-up (`sensitivity: "step-up"` in its definition).
  step_up    boolean not null default false,
  updated_at timestamptz not null default now()
);
create index registered_processes_module_id_idx on kernel.registered_processes (module_id);

create table kernel.entity_fields (
  entity      text not null,
  field       text not null,
  module_id   text not null,
  sensitivity text not null check (sensitivity in ('normal', 'confidential')),
  updated_at  timestamptz not null default now(),
  primary key (entity, field)
);
create index entity_fields_module_id_idx on kernel.entity_fields (module_id);

grant select on kernel.registered_processes, kernel.entity_fields to authenticated;
grant all on kernel.registered_processes, kernel.entity_fields to service_role;
alter table kernel.registered_processes enable row level security;
alter table kernel.entity_fields enable row level security;
create policy registered_processes_readable on kernel.registered_processes for select to authenticated using (true);
create policy entity_fields_readable on kernel.entity_fields for select to authenticated using (true);

-- ---------------------------------------------------------------------------------------------
-- Writes only through the admin processes (rule 1). Restrictive, so they are ANDed with company_isolation and the
-- company-admin policies already in place: inside the process a member who is not the admin is still refused.
-- ---------------------------------------------------------------------------------------------
create policy via_process_insert on kernel.roles as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.role.%');
create policy via_process_update on kernel.roles as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.role.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.role.%');
create policy via_process_delete on kernel.roles as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.role.%');

create policy via_process_insert on kernel.memberships as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.user.%');
create policy via_process_update on kernel.memberships as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.user.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.user.%');
create policy via_process_delete on kernel.memberships as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.user.%');

create policy via_process_insert on kernel.membership_roles as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set'));
create policy via_process_update on kernel.membership_roles as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set'))
  with check (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set'));
create policy via_process_delete on kernel.membership_roles as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user_role.set'));

-- The permission matrix, the field visibility and the sensitive list: written by permission.set,
-- field_permission.set, sensitive_process.set, and seeded by role.create and module.enable.
create policy via_process_insert on kernel.process_permissions as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');
create policy via_process_update on kernel.process_permissions as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');
create policy via_process_delete on kernel.process_permissions as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');

create policy via_process_insert on kernel.field_permissions as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');
create policy via_process_update on kernel.field_permissions as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');
create policy via_process_delete on kernel.field_permissions as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');

create policy via_process_insert on kernel.sensitive_processes as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');
create policy via_process_update on kernel.sensitive_processes as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');
create policy via_process_delete on kernel.sensitive_processes as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%');

create policy via_process_insert on kernel.required_attachments as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.required\_file.%');
create policy via_process_update on kernel.required_attachments as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.required\_file.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.required\_file.%');
create policy via_process_delete on kernel.required_attachments as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.required\_file.%');

create policy via_process_insert on kernel.verifiers as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.verifier.set');
create policy via_process_update on kernel.verifiers as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.verifier.set')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.verifier.set');
create policy via_process_delete on kernel.verifiers as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.verifier.set');

create policy via_process_insert on kernel.company_modules as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.module.%');
create policy via_process_update on kernel.company_modules as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.module.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.module.%');
create policy via_process_delete on kernel.company_modules as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.module.%');

-- The company's names and time zone: its admin changes them through kernel.admin.company.update. The tax id, country
-- and currency stay with the service role (they decide the country pack and the books).
grant update (legal_name, trade_name, timezone) on kernel.companies to authenticated;
create policy admin_update on kernel.companies for update to authenticated
  using (
    id = (select kernel.current_company_id())
    and array[id] <@ (select kernel.current_company_ids())
    and (select kernel.is_company_admin())
    and coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.admin.company.update'
  )
  with check (
    id = (select kernel.current_company_id())
    and (select kernel.is_company_admin())
    and coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.admin.company.update'
  );

-- ---------------------------------------------------------------------------------------------
-- Who may run a seed: the service role (no user claims: the seed scripts, syncModuleManifest, the company creation),
-- or the company's admin inside an admin process of that company. Raises otherwise.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.assert_admin_write(p_company uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if coalesce(kernel.jwt_claims() ->> 'role', '') in ('', 'service_role') then
    return;
  end if;
  if not (
    kernel.is_company_admin()
    and kernel.current_company_id() = p_company
    and coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.admin.%'
  ) then
    raise exception 'only the company admin, inside an admin process, may change the defaults of company %', p_company
      using errcode = '42501';
  end if;
end;
$$;
revoke execute on function kernel.assert_admin_write(uuid) from public, anon;
grant execute on function kernel.assert_admin_write(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- A role's defaults (rule 13, carry-over of Task 15). The system admin role gets every registered process. Any other
-- role gets the baseline every user needs and every confidential field masked (rule 14: a new role sees no
-- confidential datum until the admin decides otherwise):
--   kernel.help.search, kernel.data.query        the assistant's help and data questions
--   kernel.saved_view.*, kernel.user_prefs.*      saved views, theme, tabs
--   kernel.attachment.list, kernel.verify.status  the Archivos tab and the Verificar badge
--   kernel.export.run                             exporting what the grid shows
--   every consult process of the modules the company has enabled (`core.party.consult`, `support.ticket.consult`…)
-- Idempotent (existing rows, also an admin's own choices, are kept).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.seed_role_defaults(p_company uuid, p_role uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform kernel.assert_admin_write(p_company);
  select r.is_system and r.name = 'admin' into v_admin from kernel.roles r where r.id = p_role and r.company_id = p_company;
  if v_admin is null then
    raise exception 'role % is not a role of company %', p_role, p_company using errcode = '22023';
  end if;

  if v_admin then
    insert into kernel.process_permissions (company_id, role_id, process_id)
    select p_company, p_role, rp.process_id from kernel.registered_processes rp
    on conflict (company_id, role_id, process_id) do nothing;
    return;
  end if;

  insert into kernel.process_permissions (company_id, role_id, process_id)
  select p_company, p_role, rp.process_id
  from kernel.registered_processes rp
  where rp.process_id in ('kernel.help.search', 'kernel.data.query', 'kernel.attachment.list', 'kernel.verify.status', 'kernel.export.run')
     or rp.process_id like 'kernel.saved\_view.%'
     or rp.process_id like 'kernel.user\_prefs.%'
     or (rp.kind = 'consult' and rp.module_id <> 'kernel' and kernel.entitled(p_company, 'module:' || rp.module_id))
  on conflict (company_id, role_id, process_id) do nothing;

  insert into kernel.field_permissions (company_id, role_id, entity, field, mode)
  select p_company, p_role, ef.entity, ef.field, 'masked'
  from kernel.entity_fields ef
  where ef.sensitivity = 'confidential'
  on conflict (company_id, role_id, entity, field) do nothing;
end;
$$;
revoke execute on function kernel.seed_role_defaults(uuid, uuid) from public, anon;
grant execute on function kernel.seed_role_defaults(uuid, uuid) to authenticated, service_role;

-- Every admin process (feature kernel.admin: kernel.admin.*, kernel.required_file.*, kernel.verifier.set) needs the
-- step-up in every company, or in `p_company` only (rule 15: admin processes are sensitive by default). Their
-- definitions ask for it anyway; the rows make the admin's list of sensitive processes say so. Service role only.
create or replace function kernel.sync_sensitive_defaults(p_company uuid default null) returns void
language sql security definer
set search_path = ''
as $$
  insert into kernel.sensitive_processes (company_id, process_id, mode)
  select c.id, rp.process_id, 'self_2fa'
  from kernel.companies c
  cross join kernel.registered_processes rp
  where rp.feature_id = 'kernel.admin'
    and (p_company is null or c.id = p_company)
  on conflict (company_id, process_id) do nothing;
$$;
revoke execute on function kernel.sync_sensitive_defaults(uuid) from public, anon, authenticated;
grant execute on function kernel.sync_sensitive_defaults(uuid) to service_role;

-- A new company's defaults: the country's required files, every role's defaults and the sensitive admin processes.
-- Called by company creation and by the seed (Task 22) after the manifests are synced. Service role only; idempotent.
create or replace function kernel.seed_company_defaults(p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role uuid;
begin
  perform kernel.seed_required_attachments(p_company);
  for v_role in select r.id from kernel.roles r where r.company_id = p_company order by r.created_at, r.id loop
    perform kernel.seed_role_defaults(p_company, v_role);
  end loop;
  perform kernel.sync_sensitive_defaults(p_company);
end;
$$;
revoke execute on function kernel.seed_company_defaults(uuid) from public, anon, authenticated;
grant execute on function kernel.seed_company_defaults(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Users created by the admin (kernel.admin.user.create). kernel.users has no write grant for users (0001): this
-- function records the invited Auth user, only inside that process and for the company admin. An existing profile
-- keeps its name; a missing mobile or photo is filled in.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.admin_register_user(
  p_id uuid, p_email text, p_full_name text, p_mobile_cc text, p_mobile text, p_photo text
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not (kernel.is_company_admin() and coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.admin.user.create') then
    raise exception 'only the company admin, inside kernel.admin.user.create, may register a user' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_id and lower(u.email) = lower(p_email)) then
    raise exception 'no Auth user % with e-mail %', p_id, p_email using errcode = '22023';
  end if;
  insert into kernel.users (id, email, full_name, mobile_cc, mobile, photo)
  values (p_id, lower(p_email), p_full_name, p_mobile_cc, p_mobile, p_photo)
  on conflict (id) do update set
    mobile_cc = coalesce(kernel.users.mobile_cc, excluded.mobile_cc),
    mobile    = coalesce(kernel.users.mobile, excluded.mobile),
    photo     = coalesce(kernel.users.photo, excluded.photo);
end;
$$;
revoke execute on function kernel.admin_register_user(uuid, text, text, text, text, text) from public, anon;
grant execute on function kernel.admin_register_user(uuid, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- What the active company bought, for its admin: the entitlement resolver is service-only (0005) because it takes any
-- company id; these answer for the caller's active company only.
-- ---------------------------------------------------------------------------------------------
-- The tenant bought the module (a plan, add-on, trial or license row), whatever the company switched on or off.
create or replace function kernel.module_purchased(p_module text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select kernel.entitlement_decision(c.tenant_id, c.id, array['module:' || p_module])
     from kernel.companies c
     where c.id = kernel.current_company_id() and array[c.id] <@ kernel.current_company_ids()),
    false);
$$;
revoke execute on function kernel.module_purchased(text) from public, anon;
grant execute on function kernel.module_purchased(text) to authenticated, service_role;

-- The active company's limit for a `limit:x` key (null when none).
create or replace function kernel.company_limit(p_key text) returns numeric
language sql stable security definer
set search_path = ''
as $$
  select kernel.entitlement_limit(c.id, p_key)
  from kernel.companies c
  where p_key like 'limit:%' and c.id = kernel.current_company_id() and array[c.id] <@ kernel.current_company_ids();
$$;
revoke execute on function kernel.company_limit(text) from public, anon;
grant execute on function kernel.company_limit(text) to authenticated, service_role;

-- Whether a member of the active company has a verified TOTP factor: for the company admin only (the users page's
-- 2FA column); null for anyone else or a user outside the company.
create or replace function kernel.member_mfa_enrolled(p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when kernel.is_company_admin() and exists (
      select 1 from kernel.memberships m where m.user_id = p_user and m.company_id = kernel.current_company_id()
    )
    then exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified')
  end;
$$;
revoke execute on function kernel.member_mfa_enrolled(uuid) from public, anon;
grant execute on function kernel.member_mfa_enrolled(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Read views of the admin pages (rule 14: apps/web reads views). Company RLS applies to the reader; the member list
-- (e-mails, mobiles) is the admin's only.
-- ---------------------------------------------------------------------------------------------
create or replace view kernel.v_companies with (security_invoker = true) as
select id, tenant_id, legal_name, trade_name, tax_id, country_code, currency_code, timezone
from kernel.companies
where id = (select kernel.current_company_id());
grant select on kernel.v_companies to authenticated;

create or replace view kernel.v_roles with (security_invoker = true) as
select id, company_id, name, description, is_system, party_scope, created_at
from kernel.roles;
grant select on kernel.v_roles to authenticated;

create or replace view kernel.v_memberships with (security_invoker = true) as
select m.id, m.user_id, m.company_id, u.email, u.full_name, u.mobile_cc, u.mobile, u.photo, m.created_at,
       coalesce((select array_agg(mr.role_id order by mr.role_id) from kernel.membership_roles mr where mr.membership_id = m.id), '{}'::uuid[]) as role_ids,
       kernel.member_mfa_enrolled(m.user_id) as mfa_enrolled
from kernel.memberships m
join kernel.users u on u.id = m.user_id
where (select kernel.is_company_admin());
grant select on kernel.v_memberships to authenticated;

create or replace view kernel.v_process_permissions with (security_invoker = true) as
select company_id, role_id, process_id, allowed
from kernel.process_permissions;
grant select on kernel.v_process_permissions to authenticated;

create or replace view kernel.v_field_permissions with (security_invoker = true) as
select company_id, role_id, entity, field, mode
from kernel.field_permissions;
grant select on kernel.v_field_permissions to authenticated;

create or replace view kernel.v_sensitive_processes with (security_invoker = true) as
select company_id, process_id, mode
from kernel.sensitive_processes;
grant select on kernel.v_sensitive_processes to authenticated;

create or replace view kernel.v_verifiers with (security_invoker = true) as
select company_id, kind, provider, config, updated_at
from kernel.verifiers;
grant select on kernel.v_verifiers to authenticated;

create or replace view kernel.v_company_modules with (security_invoker = true) as
select company_id, module_id, enabled, enabled_at
from kernel.company_modules;
grant select on kernel.v_company_modules to authenticated;
