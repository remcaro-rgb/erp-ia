-- 0041_kernel_record_usable
-- Maestro usability gate and reference check for the typed-entity lifecycle (entity types spec 2026-11-02 §5.2, §10 D10).
--   kernel.entity_tables : entity id -> (schema, table) of every maestro / documento, written by syncModuleManifest, so SQL can find the
--                          table of an entity without the kernel naming a module (rule 4). Global schema metadata, like kernel.entity_fields.
--   kernel.record_usable(entity, id)     : whether a maestro record of the caller's company can be used on documents (not deleted, active,
--                                          approved when it requires approval, otherwise saved). Same rule as isUsable() in lifecycle.ts.
--   kernel.record_referenced(entity, id) : whether any column registered in kernel."references" holds the record's id, whatever the
--                                          caller's RLS shows of the referencing rows.
-- Both are security definer, set search_path = '', resolve the table only through kernel.entity_tables, check every identifier and quote it
-- with format(%I), and answer only for rows of the caller's company (kernel.current_company_id()); anything else is false.

create table kernel.entity_tables (
  entity       text primary key check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module_id    text not null,
  entity_type  text not null check (entity_type in ('maestro', 'documento')),
  table_schema text not null check (table_schema ~ '^[a-z_][a-z0-9_]*$'),
  table_name   text not null check (table_name ~ '^[a-z_][a-z0-9_]*$'),
  updated_at   timestamptz not null default now()
);
create index entity_tables_module_id_idx on kernel.entity_tables (module_id);
alter table kernel.entity_tables enable row level security;
create policy read_all on kernel.entity_tables for select to authenticated using (true);
grant select on kernel.entity_tables to authenticated;
grant all on kernel.entity_tables to service_role;

create or replace function kernel.record_usable(p_entity text, p_id uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_company  uuid := kernel.current_company_id();
  v_schema   text;
  v_table    text;
  v_status   text;
  v_requires boolean;
  v_active   boolean;
begin
  if v_company is null or p_id is null then
    return false;
  end if;
  select t.table_schema, t.table_name into v_schema, v_table
  from kernel.entity_tables t
  where t.entity = p_entity and t.entity_type = 'maestro';
  if not found then
    raise exception 'record_usable: % is not a registered maestro', p_entity using errcode = '22023';
  end if;
  if v_schema !~ '^[a-z_][a-z0-9_]*$' or v_table !~ '^[a-z_][a-z0-9_]*$' then
    raise exception 'record_usable: invalid identifier for %', p_entity using errcode = '22023';
  end if;
  execute format(
    'select status, requires_approval, is_active from %I.%I where id = $1 and company_id = $2 and deleted_at is null',
    v_schema, v_table)
    into v_status, v_requires, v_active using p_id, v_company;
  -- EXECUTE ... INTO does not set FOUND: no row (missing, deleted or of another company) leaves v_status null.
  if v_status is null then
    return false;
  end if;
  return coalesce(v_active, false) and v_status = case when coalesce(v_requires, false) then 'approved' else 'saved' end;
end;
$$;
revoke execute on function kernel.record_usable(text, uuid) from public, anon;
grant execute on function kernel.record_usable(text, uuid) to authenticated, service_role;

create or replace function kernel.record_referenced(p_entity text, p_id uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_schema  text;
  v_table   text;
  v_ref     record;
  v_used    boolean;
begin
  if v_company is null or p_id is null then
    return false;
  end if;
  select t.table_schema, t.table_name into v_schema, v_table
  from kernel.entity_tables t
  where t.entity = p_entity;
  if not found then
    raise exception 'record_referenced: % is not a registered entity', p_entity using errcode = '22023';
  end if;
  -- Only a record of the caller's company is answered for; the referencing tables need no company_id of their own.
  execute format('select exists (select 1 from %I.%I where id = $1 and company_id = $2)', v_schema, v_table)
    into v_used using p_id, v_company;
  if not v_used then
    return false;
  end if;
  for v_ref in select r.ref_schema, r.ref_table, r.ref_column from kernel."references" r where r.entity = p_entity order by 1, 2, 3 loop
    if v_ref.ref_schema !~ '^[a-z_][a-z0-9_]*$' or v_ref.ref_table !~ '^[a-z_][a-z0-9_]*$' or v_ref.ref_column !~ '^[a-z_][a-z0-9_]*$' then
      raise exception 'record_referenced: invalid identifier in the reference of %', p_entity using errcode = '22023';
    end if;
    execute format('select exists (select 1 from %I.%I where %I = $1)', v_ref.ref_schema, v_ref.ref_table, v_ref.ref_column)
      into v_used using p_id;
    if v_used then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke execute on function kernel.record_referenced(text, uuid) from public, anon;
grant execute on function kernel.record_referenced(text, uuid) to authenticated, service_role;
