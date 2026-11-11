-- 0044_kernel_record_access
-- Record-level access for maestros and documentos (entity types spec 2026-11-02 §9.1, D7, D11, D12; Phase 2A.5 Task 9).
--   kernel.record_access         : who (a role or a user) may read / use / modify / delete / void one record. No rows for a record =
--                                  unrestricted (the role permissions apply as before). When a record has rows, only the listed grantees
--                                  have the listed rights. Rules only narrow: they are AND-ed with the company policy (read) and with the
--                                  role's process permission that runProcess checks first (use, modify, delete, void); they never grant.
--                                  Company admins are never narrowed (D12). Written only by the admin process kernel.record_access.set,
--                                  which replaces the set; a rule is never edited in place (update refused) and every insert / delete is
--                                  in the append-only audit log (rule 16), which is the history of the rules.
--   kernel.can_access_record     : the right of the caller on a record (security definer, reads the company and roles from the JWT).
--   kernel.record_access_hidden  : the ids of an entity's records the caller may not read (empty for an admin or without rules),
--   kernel.record_access_hidden_keys / _audit_keys : the same as `entity/id` keys across entities, and as the audit log's
--                                  `entity/row_id` keys (the record's own rows, its lines' rows and its process runs). The read
--                                  policies evaluate them once per statement (an initplan) and test each row with `<> all (...)`:
--                                  set-based, no per-row plpgsql (review I5).
--   kernel.record_access_tables  : which table holds the records of which entity, and in which column (id for the maestro / documento
--                                  itself, the parent column for its line tables, which inherit the parent's read right). Written by
--                                  kernel.typed_columns (typed tables) and kernel.typed_lines (line tables, declared by each module in
--                                  its own migration, so the kernel names no module: rule 4).
--   kernel.record_access_policy  : (re)creates the restrictive SELECT policy `record_access_read` on such a table. The new versions of
--                                  kernel.enable_company_rls and kernel.typed_columns call it; on any other table it does nothing, so
--                                  every non-typed table keeps exactly the policies it had.
-- Read is enforced in RLS on the record's table, its lines and its detail rows (snapshots, mail log, attachments), so every
-- security_invoker view follows (grids, lookups, exports, the assistant). Aggregate reports that must keep the amounts of a hidden
-- record (D11) read them through their module's security-definer functions, never through these tables.

-- ---------------------------------------------------------------------------------------------
-- The rules
-- ---------------------------------------------------------------------------------------------
create table kernel.record_access (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  entity          text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  record_id       uuid not null,
  -- A rule goes with its grantee: deleting a role or a user deletes their rules (the audit log keeps them).
  grantee_role_id uuid references kernel.roles (id) on delete cascade,
  grantee_user_id uuid references kernel.users (id) on delete cascade,
  can_read        boolean not null default false,
  can_use         boolean not null default false,
  can_modify      boolean not null default false,
  can_delete      boolean not null default false,
  can_void        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  -- Exactly one grantee: a role or a user.
  constraint record_access_one_grantee check (num_nonnulls(grantee_role_id, grantee_user_id) = 1),
  -- Every right needs read: a record the grantee cannot see cannot be used, changed, deleted or voided by them.
  constraint record_access_read_first check (can_read or not (can_use or can_modify or can_delete or can_void))
);
create index record_access_record_idx on kernel.record_access (company_id, entity, record_id);
create unique index record_access_role_uq on kernel.record_access (company_id, entity, record_id, grantee_role_id) where grantee_role_id is not null;
create unique index record_access_user_uq on kernel.record_access (company_id, entity, record_id, grantee_user_id) where grantee_user_id is not null;
create index record_access_grantee_role_idx on kernel.record_access (grantee_role_id);
create index record_access_grantee_user_idx on kernel.record_access (grantee_user_id);

-- A rule is replaced (deleted and inserted, both audited), never edited after the fact (spec §4 anti-goals).
create or replace function kernel.record_access_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'record_access_immutable: an access rule is replaced, never edited' using errcode = 'insufficient_privilege';
end;
$$;
create trigger record_access_immutable before update or truncate on kernel.record_access
  for each statement execute function kernel.record_access_immutable();

create trigger assign_seq before insert on kernel.record_access for each row execute function core.assign_seq('kernel.record_access');

grant select, insert, delete on kernel.record_access to authenticated;
grant all on kernel.record_access to service_role;
select kernel.enable_company_rls('kernel', 'record_access');
select kernel.enable_row_audit('kernel', 'record_access');
-- Only company admins read or write the rules (the record tab "Acceso" is admin only); the checks read them as security definer.
create policy admin_only on kernel.record_access as restrictive for all to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy author_is_caller on kernel.record_access as restrictive for insert to authenticated
  with check (created_by is not distinct from (select kernel.current_user_id()));

-- ---------------------------------------------------------------------------------------------
-- The checks
-- ---------------------------------------------------------------------------------------------
-- The caller's `p_right` (read, use, modify, delete, void) on record `p_id` of entity `p_entity`, in the active company: true for a
-- company admin, true when the record has no rule, otherwise true only when a rule of the caller's user or of one of the roles they
-- hold (kernel.current_role_ids: the claim's roles they still hold) grants it. Without an active company: false.
create or replace function kernel.can_access_record(p_entity text, p_id uuid, p_right text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if p_right is null or p_right not in ('read', 'use', 'modify', 'delete', 'void') then
    raise exception 'can_access_record: unknown right %', p_right using errcode = '22023';
  end if;
  if v_company is null then
    return false;
  end if;
  if p_id is null or kernel.is_company_admin() then
    return true;
  end if;
  if not exists (select 1 from kernel.record_access ra where ra.company_id = v_company and ra.entity = p_entity and ra.record_id = p_id) then
    return true;
  end if;
  return exists (
    select 1 from kernel.record_access ra
    where ra.company_id = v_company and ra.entity = p_entity and ra.record_id = p_id
      and (ra.grantee_user_id = kernel.current_user_id() or ra.grantee_role_id = any (kernel.current_role_ids()))
      and case p_right
            when 'read' then ra.can_read
            when 'use' then ra.can_use
            when 'modify' then ra.can_modify
            when 'delete' then ra.can_delete
            else ra.can_void
          end
  );
end;
$$;
revoke execute on function kernel.can_access_record(text, uuid, text) from public, anon;
grant execute on function kernel.can_access_record(text, uuid, text) to authenticated, service_role;

-- The ids of `p_entity`'s records in the active company that the caller may not read: records with at least one rule and no rule
-- granting read to the caller's user or to one of the roles they hold. Empty for a company admin (D12) and when the entity has no
-- rule. Stable and security definer: a read policy calls it once per statement, as an initplan `(select ...)`.
create or replace function kernel.record_access_hidden(p_entity text) returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(h.record_id), '{}')
  from (
    select ra.record_id
    from kernel.record_access ra
    where ra.company_id = kernel.current_company_id() and ra.entity = p_entity and not kernel.is_company_admin()
    group by ra.record_id
    having not coalesce(bool_or(ra.can_read and (ra.grantee_user_id is not distinct from kernel.current_user_id() and ra.grantee_user_id is not null
                                       or coalesce(ra.grantee_role_id = any (kernel.current_role_ids()), false))), false)
  ) h;
$$;
revoke execute on function kernel.record_access_hidden(text) from public, anon;
grant execute on function kernel.record_access_hidden(text) to authenticated, service_role;

-- The same across every entity, as `entity/record_id` keys: for the detail rows that carry (entity, record_id) (snapshots, mail log,
-- attachments), so a rule hides the detail rows of its own entity's record only.
create or replace function kernel.record_access_hidden_keys() returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(h.entity || '/' || h.record_id::text), '{}')
  from (
    select ra.entity, ra.record_id
    from kernel.record_access ra
    where ra.company_id = kernel.current_company_id() and not kernel.is_company_admin()
    group by ra.entity, ra.record_id
    having not coalesce(bool_or(ra.can_read and (ra.grantee_user_id is not distinct from kernel.current_user_id() and ra.grantee_user_id is not null
                                       or coalesce(ra.grantee_role_id = any (kernel.current_role_ids()), false))), false)
  ) h;
$$;
revoke execute on function kernel.record_access_hidden_keys() from public, anon;
grant execute on function kernel.record_access_hidden_keys() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Where the records are: schema metadata, not company data (like kernel.entity_tables): global rows, read by every authenticated
-- user, written only by migrations through kernel.typed_columns and kernel.typed_lines.
-- ---------------------------------------------------------------------------------------------
create table kernel.record_access_tables (
  table_schema  text not null check (table_schema ~ '^[a-z_][a-z0-9_]*$'),
  table_name    text not null check (table_name ~ '^[a-z_][a-z0-9_]*$'),
  entity        text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  record_column text not null check (record_column ~ '^[a-z_][a-z0-9_]*$'),
  primary key (table_schema, table_name)
);
alter table kernel.record_access_tables enable row level security;
create policy read_all on kernel.record_access_tables for select to authenticated using (true);
grant select on kernel.record_access_tables to authenticated;
grant all on kernel.record_access_tables to service_role;

-- The restrictive read policy of a typed table or line table: the row's record (its id, or its parent's) must be readable.
-- Nothing for a table that is neither.
create or replace function kernel.record_access_policy(p_schema text, p_table text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_entity text;
  v_column text;
begin
  select t.entity, t.record_column into v_entity, v_column
  from kernel.record_access_tables t
  where t.table_schema = p_schema and t.table_name = p_table;
  if v_entity is null then
    return;
  end if;
  execute format('drop policy if exists record_access_read on %I.%I', p_schema, p_table);
  execute format(
    'create policy record_access_read on %I.%I as restrictive for select to authenticated '
    'using (%I <> all ((select kernel.record_access_hidden(%L))::uuid[]))',
    p_schema, p_table, v_column, v_entity);
end;
$$;
revoke execute on function kernel.record_access_policy(text, text) from public, anon, authenticated;
grant execute on function kernel.record_access_policy(text, text) to service_role;

-- A module declares a line table of one of its maestros or documentos (the `lines` entity its parent's typed.lines names): the
-- lines inherit the parent's read right through `p_parent_column`. The parent's table must already be typed (kernel.typed_columns).
create or replace function kernel.typed_lines(p_schema text, p_table text, p_parent_entity text, p_parent_column text) returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from kernel.record_access_tables t where t.entity = p_parent_entity and t.record_column = 'id') then
    raise exception 'typed_lines: % is not a typed entity (run kernel.typed_columns on its table first)', p_parent_entity using errcode = '22023';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = to_regclass(format('%I.%I', p_schema, p_table)) and a.attname = p_parent_column and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'typed_lines: %.% has no column %', p_schema, p_table, p_parent_column using errcode = '22023';
  end if;
  insert into kernel.record_access_tables (table_schema, table_name, entity, record_column)
  values (p_schema, p_table, p_parent_entity, p_parent_column)
  on conflict (table_schema, table_name) do update set entity = excluded.entity, record_column = excluded.record_column;
  perform kernel.record_access_policy(p_schema, p_table);
end;
$$;
revoke execute on function kernel.typed_lines(text, text, text, text) from public, anon, authenticated;
grant execute on function kernel.typed_lines(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- kernel.enable_company_rls, new version: the company isolation of 0001 unchanged, plus the record read policy when the table is
-- a typed table or a line table (kernel.record_access_policy does nothing otherwise).
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
  perform kernel.record_access_policy(schema_name, tbl);
end;
$$;
revoke all on function kernel.enable_company_rls(text, text) from public;

-- ---------------------------------------------------------------------------------------------
-- kernel.typed_columns, new version: as in 0040, and the table is recorded as the table of `p_entity` with its read policy.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.typed_columns(p_schema text, p_table text, p_type text, p_entity text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_states text;
begin
  if p_type not in ('maestro', 'documento') then
    raise exception 'typed_columns: type must be maestro or documento, got %', p_type using errcode = '22023';
  end if;
  v_states := case p_type
    when 'maestro' then $s$'draft', 'saved', 'pending', 'rejected', 'approved'$s$
    else $s$'draft', 'saved', 'pending', 'rejected', 'approved', 'posted', 'voided'$s$ end;

  execute format('alter table %I.%I add column if not exists status text not null default ''draft''', p_schema, p_table);
  -- Added with a default so a table that already has rows can take it, then the default is dropped: the trigger must see NULL.
  execute format('alter table %I.%I add column if not exists requires_approval boolean not null default false', p_schema, p_table);
  execute format('alter table %I.%I alter column requires_approval drop default', p_schema, p_table);
  execute format('alter table %I.%I add column if not exists void_reason text', p_schema, p_table);
  if p_type = 'documento' then
    execute format('alter table %I.%I add column if not exists posts boolean not null default false', p_schema, p_table);
    execute format('alter table %I.%I alter column posts drop default', p_schema, p_table);
  else
    execute format('alter table %I.%I add column if not exists is_active boolean not null default true', p_schema, p_table);
    execute format('alter table %I.%I add column if not exists deleted_at timestamptz', p_schema, p_table);
  end if;

  execute format('alter table %I.%I drop constraint if exists %I', p_schema, p_table, p_table || '_status_check');
  execute format('alter table %I.%I add constraint %I check (status in (%s))', p_schema, p_table, p_table || '_status_check', v_states);

  execute format('drop trigger if exists typed_copy_flags on %I.%I', p_schema, p_table);
  execute format('create trigger typed_copy_flags before insert on %I.%I for each row execute function kernel.typed_copy_flags(%L, %L)',
                 p_schema, p_table, p_entity, p_type);

  insert into kernel.record_access_tables (table_schema, table_name, entity, record_column)
  values (p_schema, p_table, p_entity, 'id')
  on conflict (table_schema, table_name) do update set entity = excluded.entity, record_column = excluded.record_column;
  perform kernel.record_access_policy(p_schema, p_table);
end;
$$;
revoke execute on function kernel.typed_columns(text, text, text, text) from public, anon, authenticated;
grant execute on function kernel.typed_columns(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The tables made typed before this migration (0042, 0043): found by the trigger typed_columns gave them, whose first argument is the
-- entity, so no module is named here. Their line tables are declared by their modules' own migrations (kernel.typed_lines).
-- ---------------------------------------------------------------------------------------------
insert into kernel.record_access_tables (table_schema, table_name, entity, record_column)
select n.nspname, c.relname, split_part(encode(t.tgargs, 'escape'), '\000', 1), 'id'
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where t.tgname = 'typed_copy_flags' and not t.tgisinternal
on conflict (table_schema, table_name) do nothing;

do $$
declare
  v record;
begin
  for v in select table_schema, table_name from kernel.record_access_tables order by 1, 2 loop
    perform kernel.record_access_policy(v.table_schema, v.table_name);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Detail rows of a record follow its read right (D11): its snapshots (Versiones), its mail log and its files.
-- ---------------------------------------------------------------------------------------------
create policy record_access_read on kernel.record_snapshots as restrictive for select to authenticated
  using ((entity || '/' || record_id::text) <> all ((select kernel.record_access_hidden_keys())::text[]));
create policy record_access_read on kernel.mail_log as restrictive for select to authenticated
  using (record_id is null or (entity || '/' || record_id::text) <> all ((select kernel.record_access_hidden_keys())::text[]));
create policy record_access_read on kernel.attachments as restrictive for select to authenticated
  using ((entity || '/' || record_id::text) <> all ((select kernel.record_access_hidden_keys())::text[]));

-- ---------------------------------------------------------------------------------------------
-- The audit log follows the read right too (ruling of 2026-11-02 on review I3: narrowing read covers every output channel). The keys
-- of the entries of the records the caller may not read, as `entity/row_id`:
--   * the record's process runs (entity = the entity id, row_id = the record id);
--   * the row changes of its table (entity = `schema.table`, row_id = the record id);
--   * the row changes of its line tables (row_id = the line id): every line the record has now, and every line whose insert or
--     delete entry names the record in its parent column (an update records only the changed columns, so the line ids are taken
--     from the live rows and from those entries; a deleted line's entries are still hidden).
-- Empty for an admin or without rules. Security definer: it reads the line tables and the log whatever the caller's policies.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.record_access_hidden_audit_keys() returns text[]
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_keys text[] := '{}';
  v_hidden uuid[];
  v_entity text;
  v_table record;
  v_lines text[];
begin
  if v_company is null or kernel.is_company_admin() then
    return v_keys;
  end if;
  for v_entity in select distinct ra.entity from kernel.record_access ra where ra.company_id = v_company loop
    v_hidden := kernel.record_access_hidden(v_entity);
    continue when cardinality(v_hidden) = 0;
    v_keys := v_keys || array(select v_entity || '/' || h::text from unnest(v_hidden) h);
    for v_table in select t.table_schema, t.table_name, t.record_column from kernel.record_access_tables t where t.entity = v_entity loop
      if v_table.record_column = 'id' then
        v_keys := v_keys || array(select v_table.table_schema || '.' || v_table.table_name || '/' || h::text from unnest(v_hidden) h);
      else
        execute format(
          'select array(select %L || id::text from %I.%I where company_id = $1 and %I = any ($2)
                        union
                        select %L || a.row_id::text from kernel.audit_log a
                        where a.company_id = $1 and a.entity = %L and a.action in (''insert'', ''delete'') and a.row_id is not null
                          and coalesce(a.diff -> %L ->> ''new'', a.diff -> %L ->> ''old'')::uuid = any ($2))',
          v_table.table_schema || '.' || v_table.table_name || '/', v_table.table_schema, v_table.table_name, v_table.record_column,
          v_table.table_schema || '.' || v_table.table_name || '/', v_table.table_schema || '.' || v_table.table_name,
          v_table.record_column, v_table.record_column)
        into v_lines using v_company, v_hidden;
        v_keys := v_keys || v_lines;
      end if;
    end loop;
  end loop;
  return v_keys;
end;
$$;
revoke execute on function kernel.record_access_hidden_audit_keys() from public, anon;
grant execute on function kernel.record_access_hidden_audit_keys() to authenticated, service_role;

create policy record_access_read on kernel.audit_log as restrictive for select to authenticated
  using (row_id is null or (entity || '/' || row_id::text) <> all ((select kernel.record_access_hidden_audit_keys())::text[]));
