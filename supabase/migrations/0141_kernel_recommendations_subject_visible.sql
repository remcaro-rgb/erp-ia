-- 0141_kernel_recommendations_subject_visible
-- Forward-only migration (rule 34). Covered by packages/kernel/src/home/__tests__/recommendation-api.integration.test.ts («a subject the
-- viewer may not read») and packages/modules/invoicing/src/__tests__/order-owner.integration.test.ts (plan 2B.2 Task 39, final review I-1).
-- A process recommendation names its subject and carries its number as a param. 0123 shows the row to its whole audience and hides only
-- the subject, by entity-level checks (the field masks, <entity>.consult); a row the viewer may not read (another salesperson's pedido,
-- 0139) was still named to them, with its number and link. Now:
--   * kernel.recommendation_safe (definer) also answers whether the subject is checkable: its entity has a read view (<schema>.v_<table>
--     of kernel.entity_tables), as kernel.document_visible reads it; it still returns the subject only to a viewer who may consult it;
--   * the security-invoker view kernel.v_recommendations drops a row whose checkable subject kernel.document_visible does not show to the
--     caller (as the caller: company, entitlement, consult, the read view's RLS). A definer cannot ask this (it reads past RLS), so it is
--     asked here. A subject without a read view (or a row with no subject, the agent's) shows as in 0123; a checkable subject that the
--     caller may not consult, or that is no longer in its view, is not shown;
--   * the audience and the masks are unchanged; the list's total and kernel.recommendation.decide read through the view (code).

drop view kernel.v_recommendations;
drop function kernel.recommendation_safe(uuid);

create function kernel.recommendation_safe(p_id uuid) returns table (params jsonb, subject_entity text, subject_id uuid, subject_checkable boolean)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row record;
  v_schema text;
  v_table text;
begin
  select r.params as p, r.subject_entity as se, r.subject_id as si, r.user_id as u, r.audience_role_id as ar, r.audience_process_id as ap
    into v_row
  from kernel.recommendations r
  where r.id = p_id
    and r.company_id = kernel.current_company_id()
    and array[r.company_id] <@ kernel.current_company_ids();
  if not found or not kernel.recommendation_audience(v_row.u, v_row.ar, v_row.ap) then
    return;
  end if;
  params := coalesce((
    select jsonb_object_agg(e.key,
             case when jsonb_typeof(e.value) = 'object' and e.value ? 'entity' and e.value ? 'field'
                       and not kernel.field_visible(e.value ->> 'entity', e.value ->> 'field')
                  then jsonb_build_object('value', null)
                  else e.value end)
    from jsonb_each(v_row.p) e), '{}'::jsonb);
  if v_row.se is not null and kernel.can_run_process(v_row.se || '.consult') then
    subject_entity := v_row.se;
    subject_id := v_row.si;
  end if;
  subject_checkable := false;
  if v_row.se is not null then
    select et.table_schema, et.table_name into v_schema, v_table from kernel.entity_tables et where et.entity = v_row.se;
    subject_checkable := v_schema is not null and to_regclass(format('%I.%I', v_schema, 'v_' || v_table)) is not null;
  end if;
  return next;
end;
$$;
revoke execute on function kernel.recommendation_safe(uuid) from public, anon;
grant execute on function kernel.recommendation_safe(uuid) to authenticated, service_role;

-- The read view: the columns of 0123 in the same order; a checkable subject must be visible to the caller.
create view kernel.v_recommendations with (security_invoker = true) as
select r.id, r.company_id, r.seq, r.audience_role_id, r.user_id, r.agent_profile, r.title, r.body, r.evidence, r.suggested_actions, r.confidence,
       r.status, r.decided_at, r.decided_by, r.created_at, r.updated_at,
       r.audience_process_id, r.source, r.module, r.reason, r.title_key, r.body_key, r.occurrences, r.last_raised_at, r.closed_at,
       s.params, s.subject_entity, s.subject_id
from kernel.recommendations r
left join lateral kernel.recommendation_safe(r.id) s on true
where kernel.recommendation_audience(r.user_id, r.audience_role_id, r.audience_process_id)
  and (s.subject_checkable is not true or kernel.document_visible(s.subject_entity, s.subject_id));
grant select on kernel.v_recommendations to authenticated;
