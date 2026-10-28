-- 0010_core_custom_field_hook
-- Forward-only migration (rule 34). Covered by packages/modules/core/src/__tests__/custom-fields.integration.test.ts
-- The hook kernel.notify_custom_field_changed (0008) calls when an admin defines, changes or removes a
-- custom field of a core entity (design §5.14): re-evaluates which records miss a required field.
--
-- A missing required field is stored in dian_missing as "Dato adicional: <label>" next to the country
-- pack's entries (core.party.create / update and the product twins write both). This function rewrites
-- only the entries that carry that prefix and leaves the pack's entries alone, then derives dian_status
-- (an 'errors' status stays) and, through the compute_invoice_ready trigger, invoice_ready. Only rows
-- whose missing data actually changes are written. A value counts as empty when it is absent, null or
-- only spaces, as in packages/kernel/src/custom-fields/validate.ts.
-- Entities without dian_missing (categories, contacts) have nothing to recompute.

create or replace function core.custom_field_changed(p_entity text, p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_entity = 'core.party' then
    update core.parties p set dian_missing = r.missing,
      dian_status = case when p.dian_status = 'errors' then 'errors'
                         when cardinality(r.missing) = 0 then 'complete'
                         else 'missing: ' || cardinality(r.missing) end
    from (
      select q.id, core.merge_custom_missing(q.dian_missing, q.company_id, p_entity, q.extra) as missing
      from core.parties q where q.company_id = p_company
    ) r
    where p.id = r.id and p.dian_missing is distinct from r.missing;
  elsif p_entity = 'core.product' then
    update core.products p set dian_missing = r.missing,
      dian_status = case when p.dian_status = 'errors' then 'errors'
                         when cardinality(r.missing) = 0 then 'complete'
                         else 'missing: ' || cardinality(r.missing) end
    from (
      select q.id, core.merge_custom_missing(q.dian_missing, q.company_id, p_entity, q.extra) as missing
      from core.products q where q.company_id = p_company
    ) r
    where p.id = r.id and p.dian_missing is distinct from r.missing;
  end if;
end;
$$;
revoke execute on function core.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function core.custom_field_changed(text, uuid) to service_role;

-- The record's missing data with the "Dato adicional: " entries replaced by the required custom fields
-- of the entity that the record's extra leaves empty.
create or replace function core.merge_custom_missing(p_missing text[], p_company uuid, p_entity text, p_extra jsonb) returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce((select array_agg(m order by o) from unnest(p_missing) with ordinality as t (m, o) where m not like 'Dato adicional: %'), '{}'::text[])
      || coalesce((
           select array_agg('Dato adicional: ' || cf.label order by cf.label)
           from kernel.custom_fields cf
           where cf.company_id = p_company and cf.entity = p_entity and cf.required
             and (p_extra -> cf.key is null or jsonb_typeof(p_extra -> cf.key) = 'null' or btrim(p_extra ->> cf.key) = '')
         ), '{}'::text[]);
$$;
revoke execute on function core.merge_custom_missing(text[], uuid, text, jsonb) from public, anon, authenticated;
grant execute on function core.merge_custom_missing(text[], uuid, text, jsonb) to service_role;
