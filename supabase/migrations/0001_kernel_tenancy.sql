-- 0001_kernel_tenancy
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/rls.integration.test.ts.
-- Tenant and identity (design §5.1), JWT claim helpers, RLS policy helper (rule 12) and the
-- custom access token hook.

create schema if not exists kernel;

grant usage on schema kernel to authenticated, service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------------------------------
-- UUID v7 (RFC 9562): 48-bit unix millisecond timestamp, version 7, variant 10, random rest.
-- The random part, the variant bits (10) and the version nibble come from a gen_random_uuid() v4
-- value: its first 6 bytes are overwritten with the timestamp and bits 52 and 53 are set so the
-- version nibble 0100 (4) becomes 0111 (7).
-- Default for every id column in this and later migrations (rule 7).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.uuid_v7() returns uuid
language sql volatile parallel safe
as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

-- ---------------------------------------------------------------------------------------------
-- JWT claim helpers. Read `request.jwt.claims` (set by PostgREST and by withClaims in tests), the
-- same setting auth.uid() reads. Missing or empty claims yield null / empty array.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.jwt_claims() returns jsonb
language sql stable parallel safe
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create or replace function kernel.current_user_id() returns uuid
language sql stable parallel safe
as $$
  select nullif(kernel.jwt_claims() ->> 'sub', '')::uuid;
$$;

create or replace function kernel.current_tenant_id() returns uuid
language sql stable parallel safe
as $$
  select nullif(kernel.jwt_claims() ->> 'tenant_id', '')::uuid;
$$;

create or replace function kernel.current_company_ids() returns uuid[]
language sql stable parallel safe
as $$
  select coalesce(
    array(select jsonb_array_elements_text(kernel.jwt_claims() -> 'company_ids')::uuid),
    '{}'::uuid[]
  );
$$;

create or replace function kernel.current_company_id() returns uuid
language sql stable parallel safe
as $$
  select nullif(kernel.jwt_claims() ->> 'active_company_id', '')::uuid;
$$;

create or replace function kernel.current_role_ids() returns uuid[]
language sql stable parallel safe
as $$
  select coalesce(
    array(select jsonb_array_elements_text(kernel.jwt_claims() -> 'role_ids')::uuid),
    '{}'::uuid[]
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table kernel.tenants (
  id         uuid primary key default kernel.uuid_v7(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table kernel.companies (
  id            uuid primary key default kernel.uuid_v7(),
  tenant_id     uuid not null references kernel.tenants (id),
  legal_name    text not null,
  trade_name    text,
  tax_id        text,
  country_code  char(2) not null default 'CO',
  currency_code char(3) not null default 'COP',
  timezone      text not null default 'America/Bogota',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid
);
create index companies_tenant_id_idx on kernel.companies (tenant_id);

create table kernel.users (
  id         uuid primary key references auth.users (id),
  email      text not null,
  full_name  text,
  locale     text not null default 'es-419',
  created_at timestamptz not null default now()
);

create table kernel.roles (
  id         uuid primary key default kernel.uuid_v7(),
  company_id uuid not null references kernel.companies (id),
  name       text not null,
  is_system  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid
);
create index roles_company_id_idx on kernel.roles (company_id);

create table kernel.memberships (
  id         uuid primary key default kernel.uuid_v7(),
  user_id    uuid not null references kernel.users (id),
  company_id uuid not null references kernel.companies (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (user_id, company_id)
);
create index memberships_company_id_idx on kernel.memberships (company_id);

create table kernel.membership_roles (
  membership_id uuid not null references kernel.memberships (id),
  role_id       uuid not null references kernel.roles (id),
  primary key (membership_id, role_id)
);
create index membership_roles_role_id_idx on kernel.membership_roles (role_id);

-- ---------------------------------------------------------------------------------------------
-- RLS policy helper: enables RLS on <schema>.<tbl> and creates policy company_isolation for
-- select / insert / update / delete. A row is visible and writable only when its company_id is the
-- active company AND the caller is a member of it (company_ids claim), so a forged or stale
-- active_company_id cannot reach a company the user does not belong to.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.enable_company_rls(schema_name text, tbl text) returns void
language plpgsql
as $$
begin
  execute format('alter table %I.%I enable row level security', schema_name, tbl);
  execute format('drop policy if exists company_isolation on %I.%I', schema_name, tbl);
  execute format(
    'create policy company_isolation on %I.%I for all to authenticated '
    'using (company_id = (select kernel.current_company_id()) '
    '       and array[company_id] <@ (select kernel.current_company_ids())) '
    'with check (company_id = (select kernel.current_company_id()) '
    '            and array[company_id] <@ (select kernel.current_company_ids()))',
    schema_name, tbl
  );
end;
$$;
revoke all on function kernel.enable_company_rls(text, text) from public;

-- ---------------------------------------------------------------------------------------------
-- Admin check and audit-column trigger
-- ---------------------------------------------------------------------------------------------
-- True when the caller's role_ids claim holds the system `admin` role of the active company (and
-- the caller belongs to that company). Security definer so policies on kernel.roles can call it
-- without recursing into their own policy.
create or replace function kernel.is_company_admin() returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from kernel.roles r
    where r.id = any (kernel.current_role_ids())
      and r.company_id = kernel.current_company_id()
      and array[r.company_id] <@ kernel.current_company_ids()
      and r.is_system
      and r.name = 'admin'
  );
$$;

-- Keeps updated_at / updated_by current on every update.
create or replace function kernel.touch_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := kernel.current_user_id();
  return new;
end;
$$;

create trigger companies_touch_updated before update on kernel.companies
  for each row execute function kernel.touch_updated();
create trigger roles_touch_updated before update on kernel.roles
  for each row execute function kernel.touch_updated();
create trigger memberships_touch_updated before update on kernel.memberships
  for each row execute function kernel.touch_updated();

-- ---------------------------------------------------------------------------------------------
-- Grants (RLS does the filtering) and policies
-- ---------------------------------------------------------------------------------------------
grant select on kernel.tenants, kernel.companies, kernel.users to authenticated;
grant select, insert, update, delete on kernel.roles, kernel.memberships, kernel.membership_roles to authenticated;
grant all
  on kernel.tenants, kernel.companies, kernel.users, kernel.roles, kernel.memberships, kernel.membership_roles
  to service_role;

-- Company-scoped tables: any member of the active company reads; only its admin writes (a member
-- must not be able to grant themselves the admin role). The restrictive policies are ANDed with
-- company_isolation.
select kernel.enable_company_rls('kernel', 'roles');
select kernel.enable_company_rls('kernel', 'memberships');

create policy admin_insert on kernel.roles as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.roles as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.roles as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));

create policy admin_insert on kernel.memberships as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.memberships as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.memberships as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));

-- membership_roles has no company_id: it follows its membership, and a role may only be assigned
-- from the same company. The subqueries are themselves filtered by the roles / memberships policies.
alter table kernel.membership_roles enable row level security;
create policy company_isolation on kernel.membership_roles for all to authenticated
  using (
    exists (select 1 from kernel.memberships m where m.id = membership_id)
  )
  with check (
    exists (select 1 from kernel.memberships m where m.id = membership_id)
    and exists (select 1 from kernel.roles r where r.id = role_id)
  );
create policy admin_insert on kernel.membership_roles as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.membership_roles as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.membership_roles as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));

-- Tenant, company and user records are readable within the caller's claims; changes go through
-- processes running with the service role (no write policy for authenticated).
alter table kernel.tenants enable row level security;
create policy tenant_isolation on kernel.tenants for select to authenticated
  using (id = (select kernel.current_tenant_id()));

alter table kernel.companies enable row level security;
create policy company_membership on kernel.companies for select to authenticated
  using (
    tenant_id = (select kernel.current_tenant_id())
    and array[id] <@ (select kernel.current_company_ids())
  );

alter table kernel.users enable row level security;
create policy user_visibility on kernel.users for select to authenticated
  using (
    id = (select kernel.current_user_id())
    or exists (select 1 from kernel.memberships m where m.user_id = kernel.users.id)
  );

-- ---------------------------------------------------------------------------------------------
-- Custom access token hook. Adds tenant_id, company_ids, active_company_id, role_ids and locale to
-- event->'claims'. Security definer so it reads the tables regardless of RLS; only
-- supabase_auth_admin may execute it.
-- active_company_id: app_metadata.active_company_id when the user is a member of it, else the
-- user's first membership. company_ids are the companies of that company's tenant; role_ids are
-- the user's roles in the active company.
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
  extra      jsonb;
begin
  select u.locale into user_locale from kernel.users u where u.id = uid;

  -- Active company: the requested one if the user is a member, else the first membership.
  select m.company_id into active_id
  from kernel.memberships m
  where m.user_id = uid
  order by (m.company_id = wanted) desc, m.created_at, m.id
  limit 1;

  if active_id is not null then
    select c.tenant_id into tenant from kernel.companies c where c.id = active_id;

    select coalesce(array_agg(m.company_id order by m.created_at, m.id), '{}'::uuid[]) into company_list
    from kernel.memberships m
    join kernel.companies c on c.id = m.company_id
    where m.user_id = uid and c.tenant_id = tenant;

    select coalesce(array_agg(distinct mr.role_id), '{}'::uuid[]) into role_list
    from kernel.memberships m
    join kernel.membership_roles mr on mr.membership_id = m.id
    where m.user_id = uid and m.company_id = active_id;
  else
    company_list := '{}'::uuid[];
    role_list := '{}'::uuid[];
  end if;

  extra := jsonb_build_object(
    'company_ids', to_jsonb(company_list),
    'role_ids', to_jsonb(role_list),
    'locale', coalesce(user_locale, 'es-419')
  );
  if active_id is not null then
    extra := extra || jsonb_build_object('tenant_id', tenant, 'active_company_id', active_id);
  end if;

  return jsonb_set(event, '{claims}', coalesce(event -> 'claims', '{}'::jsonb) || extra);
end;
$$;

revoke execute on function kernel.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant execute on function kernel.custom_access_token_hook(jsonb) to supabase_auth_admin;
