-- 0031_accounting_masters
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/masters-schema.integration.test.ts
-- (triggers, uniqueness, account security) and views.test.ts (views match the entity definitions).
-- Accounting masters (accounting design §4.1–4.5, §4.11, §4.13, §4.15): the chart of accounts, role mappings, security by
-- account, fuentes (journals), fiscal years and periods, the four analytic dimensions, settings and exógena concept mappings.
-- The plan numbered this migration 0025; 0025–0030 were taken by phase 1c, so the accounting migrations are 0031 and 0032.

create schema if not exists accounting;

grant usage on schema accounting to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- accounting.setup_table: core.setup_table for schema accounting. Record numbers (`seq`, rule 7) come from the same
-- gap-free counter as core (core.next_seq through core.assign_seq), keyed by the entity id.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.setup_table(tbl text, entity text) returns void
language plpgsql
as $$
begin
  perform kernel.enable_company_rls('accounting', tbl);
  perform kernel.enable_row_audit('accounting', tbl);
  execute format('create trigger assign_seq before insert on accounting.%I for each row execute function core.assign_seq(%L)', tbl, entity);
  execute format('create trigger touch_row before update on accounting.%I for each row execute function core.touch_row()', tbl);
  execute format('grant select, insert, update on accounting.%I to authenticated', tbl);
  execute format('grant all on accounting.%I to service_role', tbl);
end;
$$;
revoke all on function accounting.setup_table(text, text) from public;

-- ---------------------------------------------------------------------------------------------
-- Chart of accounts (§4.1). Digits only, unique per company; parent and level follow from the code.
-- ---------------------------------------------------------------------------------------------
create table accounting.accounts (
  id                      uuid primary key default kernel.uuid_v7(),
  seq                     bigint not null,
  company_id              uuid not null references kernel.companies (id),
  code                    text not null check (code ~ '^[0-9]+$'),
  name                    text not null,
  parent_id               uuid references accounting.accounts (id),
  level                   text not null check (level in ('class', 'group', 'account', 'subaccount', 'auxiliary')),
  nature                  text not null check (nature in ('debit', 'credit')),
  allows_movement         boolean not null default false,
  requires_party          boolean not null default false,
  requires_cost_center    boolean not null default false,
  requires_open_auxiliary boolean not null default false,
  requires_item           boolean not null default false,
  requires_business_unit  boolean not null default false,
  statement_section       text,
  is_opening_result       boolean not null default false,
  is_active               boolean not null default true,
  access                  text not null default 'open' check (access in ('open', 'restricted')),
  extra                   jsonb not null default '{}'::jsonb,
  extra_free              jsonb not null default '[]'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid default kernel.current_user_id(),
  updated_by              uuid,
  unique (company_id, seq),
  unique (company_id, code)
);
create index accounts_parent_id_idx on accounting.accounts (company_id, parent_id);
create index accounts_restricted_idx on accounting.accounts (company_id) where access = 'restricted';
select accounting.setup_table('accounts', 'accounting.account');

-- Before insert or when the code changes: the parent is the longest existing account whose code is a proper prefix of this
-- one, the level follows the length (1 clase, 2 grupo, 3–4 cuenta, 5–6 subcuenta, 7 or more auxiliar).
create or replace function accounting.accounts_set_parent_level() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.level := case
    when length(new.code) <= 1 then 'class'
    when length(new.code) = 2 then 'group'
    when length(new.code) <= 4 then 'account'
    when length(new.code) <= 6 then 'subaccount'
    else 'auxiliary'
  end;
  select p.id into new.parent_id
  from accounting.accounts p
  where p.company_id = new.company_id and length(p.code) < length(new.code) and new.code like p.code || '%'
  order by length(p.code) desc
  limit 1;
  return new;
end;
$$;
create trigger accounts_set_parent_level before insert or update of code on accounting.accounts
  for each row execute function accounting.accounts_set_parent_level();

-- ---------------------------------------------------------------------------------------------
-- Role mappings (§4.2): the account a role (and optional dimension) resolves to. Rows are replaced by account_role_mapping.update.
-- ---------------------------------------------------------------------------------------------
create table accounting.account_role_mappings (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  role       text not null,
  dimension  text,
  account_id uuid not null references accounting.accounts (id),
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq)
);
create unique index account_role_mappings_key on accounting.account_role_mappings (company_id, role, coalesce(dimension, ''));
create index account_role_mappings_account_idx on accounting.account_role_mappings (account_id);
select accounting.setup_table('account_role_mappings', 'accounting.account_role_mapping');
grant delete on accounting.account_role_mappings to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Security by account (§4.15): who may see and who may post to a restricted account. A grant that posts also views.
-- ---------------------------------------------------------------------------------------------
create table accounting.account_permissions (
  id           uuid primary key default kernel.uuid_v7(),
  seq          bigint not null,
  company_id   uuid not null references kernel.companies (id),
  account_id   uuid not null references accounting.accounts (id),
  subject_kind text not null check (subject_kind in ('role', 'user')),
  subject_id   uuid not null,
  can_view     boolean not null default true,
  can_post     boolean not null default false,
  is_active    boolean not null default true,
  extra        jsonb not null default '{}'::jsonb,
  extra_free   jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default kernel.current_user_id(),
  updated_by   uuid,
  unique (company_id, seq),
  unique (company_id, account_id, subject_kind, subject_id),
  check (can_view or not can_post)
);
create index account_permissions_subject_idx on accounting.account_permissions (company_id, subject_kind, subject_id);
select accounting.setup_table('account_permissions', 'accounting.account_permission');
grant delete on accounting.account_permissions to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Fuentes (journals, §4.3). `next_number` is the journal's own gap-free consecutivo, advanced by next_entry_number (0032).
-- ---------------------------------------------------------------------------------------------
create table accounting.journals (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  code           text not null,
  name           text not null,
  kind           text not null check (kind in ('general', 'sales', 'purchases', 'receipts', 'payments', 'opening', 'closing')),
  next_number    bigint not null default 1,
  manual_entries boolean not null default true,
  is_active      boolean not null default true,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (company_id, code)
);
select accounting.setup_table('journals', 'accounting.journal');

-- ---------------------------------------------------------------------------------------------
-- Fiscal years and periods (§4.4).
-- ---------------------------------------------------------------------------------------------
create table accounting.fiscal_years (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  year       int not null,
  starts_on  date not null,
  ends_on    date not null,
  status     text not null default 'open' check (status in ('open', 'closed')),
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, year),
  check (ends_on >= starts_on)
);
select accounting.setup_table('fiscal_years', 'accounting.fiscal_year');

create table accounting.periods (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  fiscal_year_id uuid not null references accounting.fiscal_years (id),
  number         int not null check (number between 1 and 12),
  starts_on      date not null,
  ends_on        date not null,
  status         text not null default 'open' check (status in ('open', 'closed')),
  closed_at      timestamptz,
  closed_by      uuid,
  reopened_count int not null default 0,
  reopened_for   date,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (company_id, fiscal_year_id, number),
  check (ends_on >= starts_on)
);
create index periods_dates_idx on accounting.periods (company_id, starts_on, ends_on);
select accounting.setup_table('periods', 'accounting.period');

-- ---------------------------------------------------------------------------------------------
-- The four analytic dimensions (§4.5): one shape, four tables.
-- ---------------------------------------------------------------------------------------------
create table accounting.cost_centers (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  code       text not null,
  name       text not null,
  parent_id  uuid references accounting.cost_centers (id),
  kind       text not null default 'leaf' check (kind in ('group', 'leaf')),
  is_active  boolean not null default true,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, code)
);
create index cost_centers_parent_id_idx on accounting.cost_centers (company_id, parent_id);
select accounting.setup_table('cost_centers', 'accounting.cost_center');

create table accounting.open_auxiliaries (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  code       text not null,
  name       text not null,
  parent_id  uuid references accounting.open_auxiliaries (id),
  kind       text not null default 'leaf' check (kind in ('group', 'leaf')),
  is_active  boolean not null default true,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, code)
);
create index open_auxiliaries_parent_id_idx on accounting.open_auxiliaries (company_id, parent_id);
select accounting.setup_table('open_auxiliaries', 'accounting.open_auxiliary');

create table accounting.items (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  code       text not null,
  name       text not null,
  parent_id  uuid references accounting.items (id),
  kind       text not null default 'leaf' check (kind in ('group', 'leaf')),
  is_active  boolean not null default true,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, code)
);
create index items_parent_id_idx on accounting.items (company_id, parent_id);
select accounting.setup_table('items', 'accounting.item');

create table accounting.business_units (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  code       text not null,
  name       text not null,
  parent_id  uuid references accounting.business_units (id),
  kind       text not null default 'leaf' check (kind in ('group', 'leaf')),
  is_active  boolean not null default true,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, code)
);
create index business_units_parent_id_idx on accounting.business_units (company_id, parent_id);
select accounting.setup_table('business_units', 'accounting.business_unit');

-- ---------------------------------------------------------------------------------------------
-- Configuración contable (§4.11): one row per company.
-- ---------------------------------------------------------------------------------------------
create table accounting.settings (
  id                           uuid primary key default kernel.uuid_v7(),
  seq                          bigint not null,
  company_id                   uuid not null references kernel.companies (id),
  ledger_starts_on             date,
  rounding_tolerance           numeric(18, 4) not null default 1.0000 check (rounding_tolerance >= 0),
  manual_journal_id            uuid references accounting.journals (id),
  require_attachment_on_manual boolean not null default false,
  niif_group                   text not null default '2' check (niif_group in ('1', '2', '3')),
  require_approval_on_manual   boolean not null default false,
  use_open_auxiliaries         boolean not null default false,
  use_items                    boolean not null default false,
  use_business_units           boolean not null default false,
  extra                        jsonb not null default '{}'::jsonb,
  extra_free                   jsonb not null default '[]'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  created_by                   uuid default kernel.current_user_id(),
  updated_by                   uuid,
  unique (company_id, seq),
  unique (company_id)
);
select accounting.setup_table('settings', 'accounting.settings');

-- ---------------------------------------------------------------------------------------------
-- Conceptos de exógena (§4.13): one account belongs to one concept per format.
-- ---------------------------------------------------------------------------------------------
create table accounting.fiscal_concept_mappings (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  format     text not null,
  concept    text not null,
  account_id uuid not null references accounting.accounts (id),
  is_active  boolean not null default true,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, format, account_id)
);
create index fiscal_concept_mappings_concept_idx on accounting.fiscal_concept_mappings (company_id, format, concept);
select accounting.setup_table('fiscal_concept_mappings', 'accounting.fiscal_concept_mapping');
grant delete on accounting.fiscal_concept_mappings to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Account security functions (§4.15, §5.13). Security definer: they read the grants whatever the caller may select.
-- Resolution: the nearest ancestor-or-self account that is `restricted` decides (an account whose own value is `open`
-- and has no restricted ancestor is open); admins hold every permission; on a restricted account the caller's own user
-- grant wins, else any of the caller's roles' grants. The posting engine's exemption (origin `event`) belongs to the
-- process, not to SQL.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.restricted_root(p_account uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  with recursive chain as (
    select a.id, a.parent_id, a.access, 0 as depth
    from accounting.accounts a
    where a.id = p_account and a.company_id = kernel.current_company_id()
    union all
    select a.id, a.parent_id, a.access, c.depth + 1
    from accounting.accounts a join chain c on a.id = c.parent_id
  )
  select id from chain where access = 'restricted' order by depth limit 1;
$$;
revoke execute on function accounting.restricted_root(uuid) from public, anon;
grant execute on function accounting.restricted_root(uuid) to authenticated, service_role;

create or replace function accounting.account_allowed(p_account uuid, p_post boolean) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_root    uuid;
  v_grant   boolean;
begin
  -- The common case, a company with no restricted account: one indexed probe.
  if not exists (select 1 from accounting.accounts where company_id = v_company and access = 'restricted') then
    return exists (select 1 from accounting.accounts where id = p_account and company_id = v_company);
  end if;
  if not exists (select 1 from accounting.accounts where id = p_account and company_id = v_company) then
    return false;
  end if;
  if kernel.is_company_admin() then
    return true;
  end if;
  v_root := accounting.restricted_root(p_account);
  if v_root is null then
    return true;
  end if;
  select case when p_post then g.can_post else g.can_view end into v_grant
  from accounting.account_permissions g
  where g.account_id = v_root and g.subject_kind = 'user' and g.subject_id = kernel.current_user_id() and g.is_active;
  if found then
    return v_grant;
  end if;
  return exists (
    select 1 from accounting.account_permissions g
    where g.account_id = v_root and g.subject_kind = 'role' and g.subject_id = any (kernel.current_role_ids()) and g.is_active
      and case when p_post then g.can_post else g.can_view end
  );
end;
$$;
revoke execute on function accounting.account_allowed(uuid, boolean) from public, anon;
grant execute on function accounting.account_allowed(uuid, boolean) to authenticated, service_role;

create or replace function accounting.can_view_account(p_account uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select accounting.account_allowed(p_account, false); $$;
revoke execute on function accounting.can_view_account(uuid) from public, anon;
grant execute on function accounting.can_view_account(uuid) to authenticated, service_role;

create or replace function accounting.can_post_account(p_account uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$ select accounting.account_allowed(p_account, true); $$;
revoke execute on function accounting.can_post_account(uuid) from public, anon;
grant execute on function accounting.can_post_account(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated at authoring time by maskedViewSql
-- (packages/kernel/src/security/masked-views.ts) from the entity definitions in
-- packages/modules/accounting/src/entities.ts and pasted here; views.test.ts fails when they drift.
-- accounting.v_accounts adds the account security of §5.13 as a where clause.
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_accounts with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.account', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.account', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.account', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.account', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.account', 'level')) then "level" else null end as "level",
  case when (select kernel.field_visible('accounting.account', 'nature')) then "nature" else null end as "nature",
  case when (select kernel.field_visible('accounting.account', 'allows_movement')) then "allows_movement" else null end as "allows_movement",
  case when (select kernel.field_visible('accounting.account', 'requires_party')) then "requires_party" else null end as "requires_party",
  case when (select kernel.field_visible('accounting.account', 'requires_cost_center')) then "requires_cost_center" else null end as "requires_cost_center",
  case when (select kernel.field_visible('accounting.account', 'requires_open_auxiliary')) then "requires_open_auxiliary" else null end as "requires_open_auxiliary",
  case when (select kernel.field_visible('accounting.account', 'requires_item')) then "requires_item" else null end as "requires_item",
  case when (select kernel.field_visible('accounting.account', 'requires_business_unit')) then "requires_business_unit" else null end as "requires_business_unit",
  case when (select kernel.field_visible('accounting.account', 'statement_section')) then "statement_section" else null end as "statement_section",
  case when (select kernel.field_visible('accounting.account', 'is_opening_result')) then "is_opening_result" else null end as "is_opening_result",
  case when (select kernel.field_visible('accounting.account', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.account', 'access')) then "access" else null end as "access",
  case when (select kernel.field_visible('accounting.account', 'extra')) then kernel.mask_extra('accounting.account', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.account', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.accounts
where accounting.can_view_account(id);
grant select on accounting.v_accounts to authenticated;

create or replace view accounting.v_account_role_mappings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.account_role_mapping', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.account_role_mapping', 'role')) then "role" else null end as "role",
  case when (select kernel.field_visible('accounting.account_role_mapping', 'dimension')) then "dimension" else null end as "dimension",
  case when (select kernel.field_visible('accounting.account_role_mapping', 'account_id')) then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.account_role_mapping', 'extra')) then kernel.mask_extra('accounting.account_role_mapping', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.account_role_mapping', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.account_role_mappings;
grant select on accounting.v_account_role_mappings to authenticated;

create or replace view accounting.v_account_permissions with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.account_permission', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.account_permission', 'account_id')) then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.account_permission', 'subject_kind')) then "subject_kind" else null end as "subject_kind",
  case when (select kernel.field_visible('accounting.account_permission', 'subject_id')) then "subject_id" else null end as "subject_id",
  case when (select kernel.field_visible('accounting.account_permission', 'can_view')) then "can_view" else null end as "can_view",
  case when (select kernel.field_visible('accounting.account_permission', 'can_post')) then "can_post" else null end as "can_post",
  case when (select kernel.field_visible('accounting.account_permission', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.account_permission', 'extra')) then kernel.mask_extra('accounting.account_permission', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.account_permission', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.account_permissions;
grant select on accounting.v_account_permissions to authenticated;

create or replace view accounting.v_journals with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.journal', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.journal', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.journal', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.journal', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.journal', 'next_number')) then "next_number" else null end as "next_number",
  case when (select kernel.field_visible('accounting.journal', 'manual_entries')) then "manual_entries" else null end as "manual_entries",
  case when (select kernel.field_visible('accounting.journal', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.journal', 'extra')) then kernel.mask_extra('accounting.journal', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.journal', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.journals;
grant select on accounting.v_journals to authenticated;

create or replace view accounting.v_fiscal_years with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.fiscal_year', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.fiscal_year', 'year')) then "year" else null end as "year",
  case when (select kernel.field_visible('accounting.fiscal_year', 'starts_on')) then "starts_on" else null end as "starts_on",
  case when (select kernel.field_visible('accounting.fiscal_year', 'ends_on')) then "ends_on" else null end as "ends_on",
  case when (select kernel.field_visible('accounting.fiscal_year', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.fiscal_year', 'extra')) then kernel.mask_extra('accounting.fiscal_year', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.fiscal_year', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.fiscal_years;
grant select on accounting.v_fiscal_years to authenticated;

create or replace view accounting.v_periods with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.period', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.period', 'fiscal_year_id')) then "fiscal_year_id" else null end as "fiscal_year_id",
  case when (select kernel.field_visible('accounting.period', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('accounting.period', 'starts_on')) then "starts_on" else null end as "starts_on",
  case when (select kernel.field_visible('accounting.period', 'ends_on')) then "ends_on" else null end as "ends_on",
  case when (select kernel.field_visible('accounting.period', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.period', 'closed_at')) then "closed_at" else null end as "closed_at",
  case when (select kernel.field_visible('accounting.period', 'closed_by')) then "closed_by" else null end as "closed_by",
  case when (select kernel.field_visible('accounting.period', 'reopened_count')) then "reopened_count" else null end as "reopened_count",
  case when (select kernel.field_visible('accounting.period', 'reopened_for')) then "reopened_for" else null end as "reopened_for",
  case when (select kernel.field_visible('accounting.period', 'extra')) then kernel.mask_extra('accounting.period', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.period', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.periods;
grant select on accounting.v_periods to authenticated;

create or replace view accounting.v_cost_centers with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.cost_center', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.cost_center', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.cost_center', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.cost_center', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.cost_center', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.cost_center', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.cost_center', 'extra')) then kernel.mask_extra('accounting.cost_center', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.cost_center', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.cost_centers;
grant select on accounting.v_cost_centers to authenticated;

create or replace view accounting.v_open_auxiliaries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'extra')) then kernel.mask_extra('accounting.open_auxiliary', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.open_auxiliaries;
grant select on accounting.v_open_auxiliaries to authenticated;

create or replace view accounting.v_items with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.item', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.item', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.item', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.item', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.item', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.item', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.item', 'extra')) then kernel.mask_extra('accounting.item', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.item', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.items;
grant select on accounting.v_items to authenticated;

create or replace view accounting.v_business_units with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.business_unit', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.business_unit', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.business_unit', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.business_unit', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.business_unit', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.business_unit', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.business_unit', 'extra')) then kernel.mask_extra('accounting.business_unit', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.business_unit', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.business_units;
grant select on accounting.v_business_units to authenticated;

create or replace view accounting.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.settings', 'ledger_starts_on')) then "ledger_starts_on" else null end as "ledger_starts_on",
  case when (select kernel.field_visible('accounting.settings', 'rounding_tolerance')) then "rounding_tolerance" else null end as "rounding_tolerance",
  case when (select kernel.field_visible('accounting.settings', 'manual_journal_id')) then "manual_journal_id" else null end as "manual_journal_id",
  case when (select kernel.field_visible('accounting.settings', 'require_attachment_on_manual')) then "require_attachment_on_manual" else null end as "require_attachment_on_manual",
  case when (select kernel.field_visible('accounting.settings', 'niif_group')) then "niif_group" else null end as "niif_group",
  case when (select kernel.field_visible('accounting.settings', 'require_approval_on_manual')) then "require_approval_on_manual" else null end as "require_approval_on_manual",
  case when (select kernel.field_visible('accounting.settings', 'use_open_auxiliaries')) then "use_open_auxiliaries" else null end as "use_open_auxiliaries",
  case when (select kernel.field_visible('accounting.settings', 'use_items')) then "use_items" else null end as "use_items",
  case when (select kernel.field_visible('accounting.settings', 'use_business_units')) then "use_business_units" else null end as "use_business_units",
  case when (select kernel.field_visible('accounting.settings', 'extra')) then kernel.mask_extra('accounting.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.settings;
grant select on accounting.v_settings to authenticated;

create or replace view accounting.v_fiscal_concept_mappings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'format')) then "format" else null end as "format",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'concept')) then "concept" else null end as "concept",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'account_id')) then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'extra')) then kernel.mask_extra('accounting.fiscal_concept_mapping', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.fiscal_concept_mapping', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.fiscal_concept_mappings;
grant select on accounting.v_fiscal_concept_mappings to authenticated;
