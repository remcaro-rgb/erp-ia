-- Phase 2A.5 Task 15: who created and who last changed a maestro or documento, for the record footer («Creado en … por …» /
-- «Modificado en … por …»). The masked views do not carry created_by / updated_by; this reads them from the record's table (found in
-- kernel.entity_tables, never named by the caller) for a record of the caller's active company that they may read
-- (kernel.can_access_record: the record's access rules, which never narrow an admin) and answers the users' names. A record the caller
-- may not read, an unknown entity or an unknown id answer no row: the same as a record that does not exist.

create or replace function kernel.record_authors(p_entity text, p_id uuid)
returns table (created_by_name text, updated_by_name text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_schema  text;
  v_table   text;
  v_created uuid;
  v_updated uuid;
  v_found   uuid;
begin
  if v_company is null or p_id is null then
    return;
  end if;
  select et.table_schema, et.table_name into v_schema, v_table from kernel.entity_tables et where et.entity = p_entity;
  if v_schema is null or not kernel.can_access_record(p_entity, p_id, 'read') then
    return;
  end if;
  execute format('select id, created_by, updated_by from %I.%I where id = $1 and company_id = $2', v_schema, v_table)
    into v_found, v_created, v_updated using p_id, v_company;
  -- EXECUTE does not set FOUND: the id read back says whether the record is there.
  if v_found is null then
    return;
  end if;
  return query
    select (select coalesce(u.full_name, u.email) from kernel.users u where u.id = v_created),
           (select coalesce(u.full_name, u.email) from kernel.users u where u.id = coalesce(v_updated, v_created));
end;
$$;

revoke execute on function kernel.record_authors(text, uuid) from public, anon;
grant execute on function kernel.record_authors(text, uuid) to authenticated, service_role;
