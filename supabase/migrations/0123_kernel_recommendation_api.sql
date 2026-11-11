-- 0123_kernel_recommendation_api
-- Forward-only migration (rule 34). Covered by packages/kernel/src/home/__tests__/recommendation-api.integration.test.ts (and the invoicing and
-- costing consumers' tests: auto-recommendation, cost-missing-recommendation).
-- The kernel recommendation API (owner 2026-11-06, design §22.28, decisions items 26 and 36, plan 2B Task 38). kernel.recommendations (0022)
-- also holds what a registered process raises, besides what an agent offers (`source`):
--   * a process row is addressed to the holders of a process (`audience_process_id`, evaluated per read with kernel.can_run_process) or to a
--     role; it names its subject (entity and record) and a reason; one open row per company, subject and reason, a second raise merges;
--   * it stores no rendered text: catalogue keys for its title and body and `params` ({ value, entity?, field? }); users never read the raw
--     params or the subject: the view reads them through kernel.recommendation_safe, which masks every value of a field the viewer does not
--     see and the subject unless the viewer may consult it (rule 14);
--   * it is written only inside the run of the process that names itself (rule 1), through kernel.recommendation_raise / _close;
--     dismissed through kernel.recommendation.decide as before; closed by the process that fixes its cause (`closed`, cause_fixed);
--   * dismissed and closed rows are deleted 90 days after their decision or close, at the company's next raise (no scheduler job).

alter table kernel.recommendations
  add column source               text not null default 'agent' check (source in ('agent', 'process')),
  add column process_id           text,
  add column module               text,
  add column audience_process_id  text,
  add column subject_entity       text,
  add column subject_id           uuid,
  add column reason               text check (reason is null or length(reason) between 1 and 100),
  add column title_key            text,
  add column body_key             text,
  add column params               jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  add column occurrences          integer not null default 1 check (occurrences >= 1),
  add column last_raised_at       timestamptz,
  add column closed_at            timestamptz,
  add column closed_reason        text check (closed_reason is null or closed_reason in ('cause_fixed'));
alter table kernel.recommendations drop constraint recommendations_status_check;
alter table kernel.recommendations add constraint recommendations_status_check check (status in ('new', 'accepted', 'dismissed', 'closed'));
-- 0022's unnamed checks (names confirmed with \d): (audience_role_id is not null or user_id is not null) and ((status = 'new') = (decided_at is null)).
alter table kernel.recommendations drop constraint recommendations_check;
alter table kernel.recommendations drop constraint recommendations_check1;
alter table kernel.recommendations
  add constraint recommendations_audience_ck check (audience_role_id is not null or user_id is not null or audience_process_id is not null),
  add constraint recommendations_state_ck check (
    case status when 'new' then decided_at is null and closed_at is null
                when 'closed' then closed_at is not null and decided_at is null and closed_reason is not null
                else decided_at is not null and closed_at is null end),
  add constraint recommendations_process_ck check (
    source = 'agent' or (process_id is not null and module is not null and subject_entity is not null and subject_id is not null
                         and reason is not null and title_key is not null and body_key is not null and audience_process_id is not null));
create unique index recommendations_open_subject_reason_uq on kernel.recommendations (company_id, subject_entity, subject_id, reason)
  where source = 'process' and status = 'new';
create index recommendations_module_status_idx on kernel.recommendations (company_id, module, status) where source = 'process';
create index recommendations_retention_idx on kernel.recommendations (company_id, coalesce(decided_at, closed_at)) where status <> 'new';

-- Raw params and subject are not readable by users: the view reads them through kernel.recommendation_safe (rule 14).
revoke select on kernel.recommendations from authenticated;
grant select (id, seq, company_id, audience_role_id, audience_process_id, user_id, agent_profile, title, body, evidence, suggested_actions,
              confidence, status, decided_at, decided_by, extra, extra_free, created_at, updated_at, created_by, updated_by, source, process_id,
              module, reason, title_key, body_key, occurrences, last_raised_at, closed_at, closed_reason)
  on kernel.recommendations to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Who a recommendation is for, in one place: the user it names, the holders of its role, the holders of its process. The process branch is
-- asked per read, so a role that gains or loses the process sees or stops seeing the row at once. The company admin holds every process
-- (ruling 2026-10-28) and so is in the audience of every process row; a role row stays the role's only (0022).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.recommendation_audience(p_user uuid, p_role uuid, p_process text) returns boolean
language sql stable parallel safe
set search_path = ''
as $$
  select (p_user is not null and p_user = kernel.current_user_id())
      or (p_role is not null and p_role = any (kernel.current_role_ids()))
      or (p_process is not null and kernel.can_run_process(p_process));
$$;
revoke execute on function kernel.recommendation_audience(uuid, uuid, text) from public, anon;
grant execute on function kernel.recommendation_audience(uuid, uuid, text) to authenticated, service_role;

drop policy audience on kernel.recommendations;
create policy audience on kernel.recommendations as restrictive for select to authenticated
  using (kernel.recommendation_audience(user_id, audience_role_id, audience_process_id));

drop policy via_process_update on kernel.recommendations;
create policy via_process_update on kernel.recommendations as restrictive for update to authenticated
  using (
    coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.recommendation.decide'
    and status = 'new'
    and kernel.recommendation_audience(user_id, audience_role_id, audience_process_id)
  )
  with check (
    status in ('accepted', 'dismissed')
    and decided_by = (select kernel.current_user_id())
  );

-- ---------------------------------------------------------------------------------------------
-- The masked params and the subject of one recommendation, for the caller: nothing outside the caller's company or audience; a value whose
-- entity.field the caller does not see becomes {"value": null} (a value without entity and field is shown as is); the subject only when the
-- caller may run <subject_entity>.consult.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.recommendation_safe(p_id uuid) returns table (params jsonb, subject_entity text, subject_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row record;
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
  return next;
end;
$$;
revoke execute on function kernel.recommendation_safe(uuid) from public, anon;
grant execute on function kernel.recommendation_safe(uuid) to authenticated, service_role;

-- The read view: 0024's columns first (same order), then the new ones and the masked params and subject.
create or replace view kernel.v_recommendations with (security_invoker = true) as
select r.id, r.company_id, r.seq, r.audience_role_id, r.user_id, r.agent_profile, r.title, r.body, r.evidence, r.suggested_actions, r.confidence,
       r.status, r.decided_at, r.decided_by, r.created_at, r.updated_at,
       r.audience_process_id, r.source, r.module, r.reason, r.title_key, r.body_key, r.occurrences, r.last_raised_at, r.closed_at,
       s.params, s.subject_entity, s.subject_id
from kernel.recommendations r
left join lateral kernel.recommendation_safe(r.id) s on true
where kernel.recommendation_audience(r.user_id, r.audience_role_id, r.audience_process_id);
grant select on kernel.v_recommendations to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The process gate of both writers: a user session reaches them only inside the run of the process it names (rule 1, as 0116), and that
-- process is a registered create or update (a consult changes nothing); the company is the caller's active one. Answers the raising
-- process's module.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.recommendation_writer(p_process text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_module text;
  v_company uuid := kernel.current_company_id();
begin
  if p_process is null or coalesce(current_setting('erp.audit_process_id', true), '') <> p_process then
    raise exception 'a recommendation is written only inside a process run of %', coalesce(p_process, '(none)') using errcode = 'insufficient_privilege';
  end if;
  select rp.module_id into v_module from kernel.registered_processes rp where rp.process_id = p_process and rp.kind in ('create', 'update');
  if v_module is null then
    raise exception 'process % may not write recommendations: it is not a registered create or update process', p_process using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'a recommendation is written for the caller''s active company' using errcode = 'insufficient_privilege';
  end if;
  return v_module;
end;
$$;
revoke execute on function kernel.recommendation_writer(text) from public, anon, authenticated;
grant execute on function kernel.recommendation_writer(text) to service_role;

create or replace function kernel.recommendation_raise(
  p_process text, p_audience_process text, p_audience_role uuid, p_subject_entity text, p_subject_id uuid, p_reason text,
  p_title_key text, p_body_key text, p_params jsonb
) returns table (id uuid, merged boolean)
language plpgsql volatile security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_module text := kernel.recommendation_writer(p_process);
  v_company uuid := kernel.current_company_id();
  v_id uuid;
begin
  if p_subject_entity is null or p_subject_id is null or p_reason is null or p_title_key is null or p_body_key is null then
    raise exception 'a recommendation needs its subject, reason and keys' using errcode = 'invalid_parameter_value';
  end if;
  if p_audience_process is null and p_audience_role is null then
    raise exception 'a recommendation needs an audience process or role' using errcode = 'invalid_parameter_value';
  end if;
  if p_audience_process is not null and not exists (select 1 from kernel.registered_processes rp where rp.process_id = p_audience_process) then
    raise exception 'audience process % is not registered', p_audience_process using errcode = 'invalid_parameter_value';
  end if;
  if p_audience_role is not null and not exists (select 1 from kernel.roles ro where ro.id = p_audience_role and ro.company_id = v_company) then
    raise exception 'audience role % is not a role of the company', p_audience_role using errcode = 'invalid_parameter_value';
  end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'recommendation params must be an object' using errcode = 'invalid_parameter_value';
  end if;

  -- Retention (R38-3): what was dismissed, accepted or closed more than 90 days ago goes, this company's only (audited by the row trigger).
  delete from kernel.recommendations r
  where r.company_id = v_company and r.status <> 'new' and coalesce(r.decided_at, r.closed_at) < now() - interval '90 days';

  -- One open row per subject and reason (R38-5): concurrent raises of one key queue here; the second finds the first's row and merges.
  perform pg_advisory_xact_lock(hashtextextended('kernel.recommendation:' || v_company || ':' || p_subject_entity || ':' || p_subject_id || ':' || p_reason, 0));
  loop
    select r.id into v_id
    from kernel.recommendations r
    where r.company_id = v_company and r.source = 'process' and r.subject_entity = p_subject_entity and r.subject_id = p_subject_id
      and r.reason = p_reason and r.status = 'new'
    for update;
    if found then
      update kernel.recommendations r
      set occurrences = r.occurrences + 1, last_raised_at = now(), params = p_params, title_key = p_title_key, body_key = p_body_key,
          title = p_title_key, body = p_body_key, process_id = p_process, updated_by = kernel.current_user_id()
      where r.id = v_id;
      return query select v_id, true;
      return;
    end if;
    begin
      -- No rendered text is stored: title and body (not null since 0022) carry the catalogue keys.
      insert into kernel.recommendations as r (company_id, source, process_id, module, audience_process_id, audience_role_id, agent_profile,
                                               subject_entity, subject_id, reason, title_key, body_key, title, body, params, last_raised_at)
      values (v_company, 'process', p_process, v_module, p_audience_process, p_audience_role, 'process',
              p_subject_entity, p_subject_id, p_reason, p_title_key, p_body_key, p_title_key, p_body_key, p_params, now())
      returning r.id into v_id;
      return query select v_id, false;
      return;
    exception when unique_violation then
      -- A writer outside the lock (none in the code) inserted first: read its row again and merge (the subtransaction gave its seq back).
      null;
    end;
  end loop;
end;
$$;
revoke execute on function kernel.recommendation_raise(text, text, uuid, text, uuid, text, text, text, jsonb) from public, anon;
grant execute on function kernel.recommendation_raise(text, text, uuid, text, uuid, text, text, text, jsonb) to authenticated, service_role;

create or replace function kernel.recommendation_close(p_process text, p_subject_entity text, p_subject_id uuid, p_reason text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_module text := kernel.recommendation_writer(p_process);
  v_count integer;
begin
  update kernel.recommendations r
  set status = 'closed', closed_at = now(), closed_reason = 'cause_fixed', updated_by = kernel.current_user_id()
  where r.company_id = kernel.current_company_id() and r.source = 'process' and r.subject_entity = p_subject_entity
    and r.subject_id = p_subject_id and r.status = 'new' and (p_reason is null or r.reason = p_reason);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function kernel.recommendation_close(text, text, uuid, text) from public, anon;
grant execute on function kernel.recommendation_close(text, text, uuid, text) to authenticated, service_role;
-- kernel.seed_role_defaults is unchanged: `kernel.recommendation.%` already gives a plain role list and decide.
