-- 0051_kernel_record_versions
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/record-versions.integration.test.ts.
--
-- Versiones in SQL (entity types spec 2026-11-02 §8, D18, rule 14; Phase 2A.5 Task 15 review round 1):
--   * kernel.entity_tables gains lines_entity: the entity of a documento's lines (the registry's `typed.lines`), written by the
--     entitlement resolver and backfilled here for the comprobante.
--   * kernel.record_versions(entity, id): the documento's snapshots with every header and line field the caller may not see
--     (kernel.field_visible) replaced by the mask, and the Datos adicionales through kernel.mask_extra. Security invoker: company RLS
--     and the record access policy of kernel.record_snapshots (0044) apply. A documento without a registered lines entity answers
--     every line field masked (deny by default). The raw payload never reaches the application.
--   * kernel.record_authors (0050) names users by their name only: a user without a name answers null, never an e-mail the viewer
--     may not see (review m4).

alter table kernel.entity_tables add column lines_entity text check (lines_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
update kernel.entity_tables set lines_entity = 'accounting.entry_line' where entity = 'accounting.entry';

create or replace function kernel.mask_fields(p_entity text, p_row jsonb) returns jsonb
language sql stable security invoker parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(
      kv.key,
      case when p_entity is not null and kernel.field_visible(p_entity, kv.key) then kv.value else to_jsonb('••••••••'::text) end
    ),
    '{}'::jsonb
  )
  from jsonb_each(coalesce(p_row, '{}'::jsonb)) as kv;
$$;

create or replace function kernel.record_versions(p_entity text, p_id uuid)
returns table (version bigint, status text, header jsonb, lines jsonb, extra jsonb, reason text, created_at timestamptz, by_name text)
language sql stable security invoker
set search_path = ''
as $$
  select row_number() over (order by s.seq) as version,
         s.status,
         kernel.mask_fields(p_entity, s.payload -> 'header'),
         coalesce((select jsonb_agg(kernel.mask_fields(et.lines_entity, l.value) order by l.ordinality)
                   from jsonb_array_elements(case when jsonb_typeof(s.payload -> 'lines') = 'array' then s.payload -> 'lines' else '[]'::jsonb end)
                        with ordinality as l(value, ordinality)), '[]'::jsonb),
         kernel.mask_extra(p_entity, s.payload -> 'extra'),
         s.reason,
         s.created_at,
         (select u.full_name from kernel.v_users u where u.id = s.created_by)
  from kernel.record_snapshots s
  join kernel.entity_tables et on et.entity = s.entity and et.entity_type = 'documento'
  where s.company_id = kernel.current_company_id()
    and s.entity = p_entity
    and s.record_id = p_id
  order by s.seq;
$$;

revoke execute on function kernel.mask_fields(text, jsonb), kernel.record_versions(text, uuid) from public, anon;
grant execute on function kernel.mask_fields(text, jsonb), kernel.record_versions(text, uuid) to authenticated, service_role;

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
  if v_found is null then
    return;
  end if;
  return query
    select (select nullif(u.full_name, '') from kernel.users u where u.id = v_created),
           (select nullif(u.full_name, '') from kernel.users u where u.id = coalesce(v_updated, v_created));
end;
$$;
