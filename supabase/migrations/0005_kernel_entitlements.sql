-- 0005_kernel_entitlements
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/entitlements.integration.test.ts.
-- What a tenant bought, as opposed to what a role may do (design §5.12): plans, the tenant's
-- entitlement rows, the modules each company switched on, the feature -> process map, and the
-- resolver `kernel.entitled` that runProcess, the registry and navigation read.

-- ---------------------------------------------------------------------------------------------
-- Plans: a named bundle of entitlement keys and limits. Billing (plan 3) copies a plan's keys into
-- tenant_entitlements; nothing reads plans at run time.
-- ---------------------------------------------------------------------------------------------
create table kernel.plans (
  id            text primary key,
  name          text not null,
  included_keys text[] not null default '{}',
  limits        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

grant select on kernel.plans to authenticated;
grant all on kernel.plans to service_role;
alter table kernel.plans enable row level security;
create policy plans_readable on kernel.plans for select to authenticated using (true);

insert into kernel.plans (id, name, included_keys, limits)
values ('starter', 'Starter', array['module:core', 'module:support'], '{"ai_tokens_month": 2000000}'::jsonb);

-- ---------------------------------------------------------------------------------------------
-- Tenant entitlements. Keys are hierarchical: module:x, feature:x.y, process:x.y.z, limit:x.
-- `company_id is null` applies to every company of the tenant. Validity dates are inclusive.
-- Users read their own tenant's rows; billing sync writes them as the service role.
-- ---------------------------------------------------------------------------------------------
create table kernel.tenant_entitlements (
  id          uuid primary key default kernel.uuid_v7(),
  tenant_id   uuid not null references kernel.tenants (id),
  company_id  uuid references kernel.companies (id),
  key         text not null check (key ~ '^(module|feature|process|limit):[a-z][a-z0-9_.]*$'),
  enabled     boolean not null default true,
  limit_value numeric,
  valid_from  date not null default current_date,
  valid_to    date,
  source      text not null check (source in ('plan', 'addon', 'trial', 'manual', 'license')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  check (valid_to is null or valid_to >= valid_from)
);
create index tenant_entitlements_tenant_key_idx on kernel.tenant_entitlements (tenant_id, key);
create index tenant_entitlements_company_id_idx on kernel.tenant_entitlements (company_id);

create trigger tenant_entitlements_touch_updated before update on kernel.tenant_entitlements
  for each row execute function kernel.touch_updated();

grant select on kernel.tenant_entitlements to authenticated;
grant all on kernel.tenant_entitlements to service_role;
alter table kernel.tenant_entitlements enable row level security;
create policy tenant_isolation on kernel.tenant_entitlements for select to authenticated
  using (tenant_id = (select kernel.current_tenant_id()));

select kernel.enable_row_audit('kernel', 'tenant_entitlements');

-- ---------------------------------------------------------------------------------------------
-- Company modules: which modules the company switched on. A module the plan includes but the
-- company disabled stays unavailable; its data and events are kept (design §5.12).
-- ---------------------------------------------------------------------------------------------
create table kernel.company_modules (
  company_id uuid not null references kernel.companies (id),
  module_id  text not null,
  enabled    boolean not null default true,
  enabled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  primary key (company_id, module_id)
);

create trigger company_modules_touch_updated before update on kernel.company_modules
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.company_modules to authenticated;
grant all on kernel.company_modules to service_role;

select kernel.enable_company_rls('kernel', 'company_modules');
create policy admin_insert on kernel.company_modules as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.company_modules as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.company_modules as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));

select kernel.enable_row_audit('kernel', 'company_modules');

-- ---------------------------------------------------------------------------------------------
-- Module features: the manifests' feature -> process / entity map, so SQL can resolve
-- process:x.y.z -> feature:x.y -> module:x. Global (not per tenant); written by
-- syncModuleManifest as the service role.
-- ---------------------------------------------------------------------------------------------
create table kernel.module_features (
  module_id   text not null,
  feature_id  text not null,
  process_ids text[] not null default '{}',
  entity_ids  text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (module_id, feature_id)
);

grant select on kernel.module_features to authenticated;
grant all on kernel.module_features to service_role;
alter table kernel.module_features enable row level security;
create policy module_features_readable on kernel.module_features for select to authenticated using (true);

-- ---------------------------------------------------------------------------------------------
-- Resolver.
-- entitlement_decision: among the active rows for any of `p_keys` that apply to the company (its own
-- or tenant-wide), the company's own rows win over tenant-wide ones; the answer is whether any
-- winning row is enabled, or null when no active row exists at all.
-- entitled: the most specific level with an active row decides: process -> the feature(s) that list
-- it -> module for a process key, feature -> module for a feature key, the key itself for module and
-- limit keys. A module the company disabled in company_modules is never entitled.
-- These functions are security definer and callable by the service role only: they take any company id, so
-- exposing them to users would let one tenant probe another's plan.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.entitlement_decision(p_tenant uuid, p_company uuid, p_keys text[]) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  with active as (
    select te.company_id is not null as company_specific, te.enabled
    from kernel.tenant_entitlements te
    where te.tenant_id = p_tenant
      and te.key = any (p_keys)
      and (te.company_id is null or te.company_id = p_company)
      and te.valid_from <= current_date
      and (te.valid_to is null or te.valid_to >= current_date)
  )
  select bool_or(enabled)
  from active
  where company_specific = (select bool_or(company_specific) from active);
$$;

create or replace function kernel.entitled(company_id uuid, key text) returns boolean
language plpgsql stable security definer parallel safe
set search_path = ''
as $$
declare
  v_tenant   uuid;
  v_kind     text := split_part(entitled.key, ':', 1);
  v_name     text := substr(entitled.key, position(':' in entitled.key) + 1);
  v_module   text := split_part(substr(entitled.key, position(':' in entitled.key) + 1), '.', 1);
  v_features text[];
  v_decision boolean;
begin
  if position(':' in entitled.key) = 0 or v_kind not in ('module', 'feature', 'process', 'limit') then
    return false;
  end if;
  select c.tenant_id into v_tenant from kernel.companies c where c.id = entitled.company_id;
  if v_tenant is null then
    return false;
  end if;

  if v_kind <> 'limit' and exists (
    select 1 from kernel.company_modules cm
    where cm.company_id = entitled.company_id and cm.module_id = v_module and not cm.enabled
  ) then
    return false;
  end if;

  v_decision := kernel.entitlement_decision(v_tenant, entitled.company_id, array[entitled.key]);
  if v_decision is null and v_kind = 'process' then
    select array_agg('feature:' || mf.feature_id) into v_features
    from kernel.module_features mf
    where mf.module_id = v_module and v_name = any (mf.process_ids);
    v_decision := kernel.entitlement_decision(v_tenant, entitled.company_id, v_features);
  end if;
  if v_decision is null and v_kind in ('process', 'feature') then
    v_decision := kernel.entitlement_decision(v_tenant, entitled.company_id, array['module:' || v_module]);
  end if;
  return coalesce(v_decision, false);
end;
$$;

-- entitlement_limit: the limit of a `limit:x` key under the same specificity rule as entitled: the
-- company's own active rows win over tenant-wide ones (so a company row with enabled = false masks
-- a tenant-wide enabled one); among the winning rows the enabled one with the latest valid_from.
-- Null when there is none or its limit_value is null.
create or replace function kernel.entitlement_limit(company_id uuid, key text) returns numeric
language sql stable security definer parallel safe
set search_path = ''
as $$
  with active as (
    select te.company_id is not null as company_specific, te.enabled, te.limit_value, te.valid_from, te.created_at
    from kernel.tenant_entitlements te
    join kernel.companies c on c.tenant_id = te.tenant_id
    where c.id = entitlement_limit.company_id
      and te.key = entitlement_limit.key
      and (te.company_id is null or te.company_id = c.id)
      and te.valid_from <= current_date
      and (te.valid_to is null or te.valid_to >= current_date)
  )
  select a.limit_value
  from active a
  where a.company_specific = (select bool_or(company_specific) from active) and a.enabled
  order by a.valid_from desc, a.created_at desc
  limit 1;
$$;

revoke execute on function kernel.entitlement_decision(uuid, uuid, text[]) from public, anon, authenticated;
revoke execute on function kernel.entitled(uuid, text) from public, anon, authenticated;
revoke execute on function kernel.entitlement_limit(uuid, text) from public, anon, authenticated;
grant execute on function kernel.entitled(uuid, text) to service_role;
grant execute on function kernel.entitlement_limit(uuid, text) to service_role;
