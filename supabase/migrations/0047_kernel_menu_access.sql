-- 0047_kernel_menu_access
-- Menu access (entity types spec 2026-11-02 §2.4, §9.2, D7, D12; design §22.23; Phase 2A.5 Task 10). Forward-only (rule 34).
--   kernel.menu_items        : every menu item of the loaded modules (registry metadata, like kernel.entity_tables): its group, its
--                              screen's address, the entity whose list page it is and the processes it lists. Written by
--                              syncModuleManifest (packages/kernel/src/entitlements/resolver.ts) from each manifest, so the kernel names
--                              no module (rule 4). Global rows, read by every authenticated user.
--   kernel.menu_access       : who (a role or a user) may see one menu item, at any level, in a company. No rows for an item = everyone
--                              who may open it by their role. A rule only narrows: an `allowed = false` rule hides the item from its
--                              grantee; once an item has an `allowed = true` rule, only the grantees of such rules see it; a deny wins over
--                              an allow. A rule never shows an item the role's process permissions would hide (the shell still needs the
--                              role to open it), and never applies to company admins (D12). Hiding a group (a section) hides its items.
--                              Written only by the admin process kernel.menu_access.set, which replaces an item's set; a rule is never
--                              edited in place (update refused) and every insert / delete is in the append-only audit log (rule 16).
--   kernel.menu_allowed      : whether the caller may see an item (true for an admin; true without rules in the company).
--   kernel.menu_hidden_keys  : the items hidden for the caller (the shell drops them).
--   kernel.menu_path_allowed : whether the caller may open an address (the proxy's route guard): false when the address is the screen of a
--                              hidden item, a page under it, or a record page of its entity.
--   kernel.menu_hides_process: whether a process is listed under an item hidden for the caller.
--   kernel.can_run_process   : now also false for such a process, so runProcess refuses it with the very refusal of a missing role
--                              permission (`forbidden`, nothing more revealed), and every menu, ⌘K command and assistant tool that asks
--                              can_run_process (runnableProcesses) leaves it out. Hiding is never the only guard (spec §4).

-- ---------------------------------------------------------------------------------------------
-- The menu items (registry metadata)
-- ---------------------------------------------------------------------------------------------
create table kernel.menu_items (
  nav_key     text primary key check (nav_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module_id   text not null,
  parent_key  text,
  href        text check (href is null or href ~ '^/'),
  entity      text check (entity is null or entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  process_ids text[] not null default '{}',
  updated_at  timestamptz not null default now()
);
create index menu_items_module_id_idx on kernel.menu_items (module_id);
create index menu_items_process_ids_idx on kernel.menu_items using gin (process_ids);
alter table kernel.menu_items enable row level security;
create policy read_all on kernel.menu_items for select to authenticated using (true);
grant select on kernel.menu_items to authenticated;
grant all on kernel.menu_items to service_role;

-- ---------------------------------------------------------------------------------------------
-- The rules
-- ---------------------------------------------------------------------------------------------
create table kernel.menu_access (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  nav_key         text not null check (nav_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- A rule goes with its grantee: deleting a role or a user deletes their rules (the audit log keeps them).
  grantee_role_id uuid references kernel.roles (id) on delete cascade,
  grantee_user_id uuid references kernel.users (id) on delete cascade,
  allowed         boolean not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  -- Exactly one grantee: a role or a user.
  constraint menu_access_one_grantee check (num_nonnulls(grantee_role_id, grantee_user_id) = 1)
);
create index menu_access_item_idx on kernel.menu_access (company_id, nav_key);
create unique index menu_access_role_uq on kernel.menu_access (company_id, nav_key, grantee_role_id) where grantee_role_id is not null;
create unique index menu_access_user_uq on kernel.menu_access (company_id, nav_key, grantee_user_id) where grantee_user_id is not null;
create index menu_access_grantee_role_idx on kernel.menu_access (grantee_role_id);
create index menu_access_grantee_user_idx on kernel.menu_access (grantee_user_id);

-- A rule is replaced (deleted and inserted, both audited), never edited after the fact (spec §4 anti-goals).
create or replace function kernel.menu_access_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'menu_access_immutable: a menu rule is replaced, never edited' using errcode = 'insufficient_privilege';
end;
$$;
create trigger menu_access_immutable before update or truncate on kernel.menu_access
  for each statement execute function kernel.menu_access_immutable();

create trigger assign_seq before insert on kernel.menu_access for each row execute function core.assign_seq('kernel.menu_access');

grant select, insert, delete on kernel.menu_access to authenticated;
grant all on kernel.menu_access to service_role;
select kernel.enable_company_rls('kernel', 'menu_access');
select kernel.enable_row_audit('kernel', 'menu_access');
-- Only company admins read or write the rules; the checks below read them as security definer, for the caller only.
create policy admin_only on kernel.menu_access as restrictive for all to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy author_is_caller on kernel.menu_access as restrictive for insert to authenticated
  with check (created_by is not distinct from (select kernel.current_user_id()));

-- ---------------------------------------------------------------------------------------------
-- The checks
-- ---------------------------------------------------------------------------------------------
-- The rules of one item in company `p_company`, for the caller (no admin bypass here: menu_allowed applies it): true without rules; false
-- when a deny names the caller's user or one of the roles they hold (kernel.current_role_ids); with an allow-list, true only when one of
-- its rules names them; otherwise true.
create or replace function kernel.menu_rule_allows(p_company uuid, p_key text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  with rules as (
    select ma.allowed,
           (ma.grantee_user_id is not null and ma.grantee_user_id = kernel.current_user_id())
             or coalesce(ma.grantee_role_id = any (kernel.current_role_ids()), false) as mine
    from kernel.menu_access ma
    where ma.company_id = p_company and ma.nav_key = p_key
  )
  select case
    when not exists (select 1 from rules) then true
    when exists (select 1 from rules where mine and not allowed) then false
    when exists (select 1 from rules where allowed) then exists (select 1 from rules where mine and allowed)
    else true
  end;
$$;
revoke execute on function kernel.menu_rule_allows(uuid, text) from public, anon, authenticated;
grant execute on function kernel.menu_rule_allows(uuid, text) to service_role;

-- Whether the caller may see menu item `p_key` in the active company: true for a company admin (D12) and when the company has no menu
-- rule at all; otherwise the item's rules and its group's (a hidden section hides its items) must both allow it. Without an active
-- company: false.
create or replace function kernel.menu_allowed(p_key text) returns boolean
language plpgsql stable security definer parallel safe
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_parent text;
begin
  if v_company is null then
    return false;
  end if;
  if kernel.is_company_admin() or not exists (select 1 from kernel.menu_access ma where ma.company_id = v_company) then
    return true;
  end if;
  if not kernel.menu_rule_allows(v_company, p_key) then
    return false;
  end if;
  select mi.parent_key into v_parent from kernel.menu_items mi where mi.nav_key = p_key;
  return v_parent is null or kernel.menu_rule_allows(v_company, v_parent);
end;
$$;
revoke execute on function kernel.menu_allowed(text) from public, anon;
grant execute on function kernel.menu_allowed(text) to authenticated, service_role;

-- The items hidden for the caller in the active company, sorted: empty for an admin and for a company without rules.
create or replace function kernel.menu_hidden_keys() returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(mi.nav_key order by mi.nav_key), '{}')
  from kernel.menu_items mi
  where exists (select 1 from kernel.menu_access ma where ma.company_id = kernel.current_company_id())
    and not kernel.menu_allowed(mi.nav_key);
$$;
revoke execute on function kernel.menu_hidden_keys() from public, anon;
grant execute on function kernel.menu_hidden_keys() to authenticated, service_role;

-- Whether the caller may open address `p_path` (a pathname, no query): false when it is the screen of an item hidden for them, a page
-- under it (`/accounting/cost-centers/…`) or a record page of the item's entity (`/r/<entity>/…`). An address under no item is allowed.
create or replace function kernel.menu_path_allowed(p_path text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (select 1 from kernel.menu_access ma where ma.company_id = kernel.current_company_id())
      or not exists (
        select 1 from kernel.menu_items mi
        where ((mi.href is not null and (p_path = mi.href or starts_with(p_path, mi.href || '/')))
               or (mi.entity is not null and starts_with(p_path, '/r/' || mi.entity || '/')))
          and not kernel.menu_allowed(mi.nav_key)
      );
$$;
revoke execute on function kernel.menu_path_allowed(text) from public, anon;
grant execute on function kernel.menu_path_allowed(text) to authenticated, service_role;

-- Whether process `p_process` is listed under an item hidden for the caller.
create or replace function kernel.menu_hides_process(p_process text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  select exists (select 1 from kernel.menu_access ma where ma.company_id = kernel.current_company_id())
     and exists (select 1 from kernel.menu_items mi where mi.process_ids @> array[p_process] and not kernel.menu_allowed(mi.nav_key));
$$;
revoke execute on function kernel.menu_hides_process(text) from public, anon;
grant execute on function kernel.menu_hides_process(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The process gate: same signature as 0004 / 0021. A company admin runs everything (never narrowed); any other caller needs a role
-- permission AND the process must not be listed under a menu item hidden for them.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.can_run_process(process_id text) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $$
  select kernel.is_company_admin() or (
    exists (
      select 1
      from kernel.process_permissions pp
      where pp.process_id = can_run_process.process_id
        and pp.company_id = kernel.current_company_id()
        and array[pp.company_id] <@ kernel.current_company_ids()
        and pp.role_id = any (kernel.current_role_ids())
        and pp.allowed
    )
    and not kernel.menu_hides_process(can_run_process.process_id)
  );
$$;
