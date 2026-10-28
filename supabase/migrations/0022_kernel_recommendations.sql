-- 0022_kernel_recommendations
-- Forward-only migration (rule 34). Covered by packages/kernel/src/home/__tests__/home.integration.test.ts.
-- The home screen's server side (design §19a, §7.5, rules 25 and 28), Task 20:
--   * kernel.recommendations: what a background agent (phase 3) or the help agent offers a role or a user, with the
--     evidence it was computed from and the actions it suggests. Offered, never executed: a user accepts or dismisses it
--     through kernel.recommendation.decide and an accepted action opens the assistant, which asks for the usual
--     confirmation card. Phase 1 rows come from the seed (Task 22).
--   * kernel.v_recommendations: the read view the home inbox uses (rule 14), with the same predicate as the policies.
--   * kernel.v_audit_log: the caller's own audit entries, for the "recent records" widget (no input or diff published).
--   * The baseline grants of a plain role now include the home processes (kernel.seed_role_defaults).

-- ---------------------------------------------------------------------------------------------
-- Recommendations. `seq` is the company's consecutive number (rule 7), assigned by core.assign_seq like the tickets of
-- 0017. A recommendation is for the holders of `audience_role_id`, for one `user_id`, or both (never nobody); one decision
-- ends it for everyone it was offered to.
-- ---------------------------------------------------------------------------------------------
create table kernel.recommendations (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  audience_role_id  uuid references kernel.roles (id) on delete cascade,
  user_id           uuid references kernel.users (id) on delete cascade,
  -- Who wrote it: the agent profile of the background agents of phase 3, `help` for the help agent, `seed` for the demo.
  agent_profile     text not null check (length(agent_profile) between 1 and 64),
  title             text not null check (length(title) between 1 and 200),
  body              text not null check (length(body) between 1 and 2000),
  -- The numbers it was computed from (rule 29: statistics detect, the model composes).
  evidence          jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  -- [{ label, processId, input } | { label, href }]: validated again by the processes that read it.
  suggested_actions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggested_actions) = 'array' and jsonb_array_length(suggested_actions) <= 5),
  confidence        numeric(4,3) check (confidence is null or confidence between 0 and 1),
  status            text not null default 'new' check (status in ('new', 'accepted', 'dismissed')),
  decided_at        timestamptz,
  decided_by        uuid references kernel.users (id) on delete set null,
  extra             jsonb not null default '{}'::jsonb,
  extra_free        jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  check (audience_role_id is not null or user_id is not null),
  check ((status = 'new') = (decided_at is null))
);
create index recommendations_company_status_idx on kernel.recommendations (company_id, status, created_at desc);
create index recommendations_audience_role_id_idx on kernel.recommendations (audience_role_id) where audience_role_id is not null;
create index recommendations_user_id_idx on kernel.recommendations (user_id) where user_id is not null;
create index recommendations_decided_by_idx on kernel.recommendations (decided_by) where decided_by is not null;

create trigger assign_seq before insert on kernel.recommendations
  for each row execute function core.assign_seq('kernel.recommendation');
create trigger recommendations_touch_updated before update on kernel.recommendations
  for each row execute function kernel.touch_updated();

-- Users read what was offered to them and decide it; nobody inserts or deletes (the service role writes, from the agents
-- and the seed). The only column a user changes is the decision.
grant select on kernel.recommendations to authenticated;
grant update (status, decided_at, decided_by) on kernel.recommendations to authenticated;
grant all on kernel.recommendations to service_role;
select kernel.enable_company_rls('kernel', 'recommendations');
select kernel.enable_row_audit('kernel', 'recommendations');

-- Visible to the user it targets and to the holders of its audience role: not even the company admin reads what was
-- offered to another role.
create policy audience on kernel.recommendations as restrictive for select to authenticated
  using (user_id = (select kernel.current_user_id()) or audience_role_id = any (kernel.current_role_ids()));

-- A decision is written only inside kernel.recommendation.decide (rule 1), once: a recommendation that is no longer new
-- does not change again, and a decision is never taken back to `new`.
create policy via_process_update on kernel.recommendations as restrictive for update to authenticated
  using (
    coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.recommendation.decide'
    and status = 'new'
    and (user_id = (select kernel.current_user_id()) or audience_role_id = any (kernel.current_role_ids()))
  )
  with check (
    status in ('accepted', 'dismissed')
    and decided_by = (select kernel.current_user_id())
  );

create or replace view kernel.v_recommendations with (security_invoker = true) as
select id, company_id, seq, audience_role_id, user_id, agent_profile, title, body, evidence, suggested_actions, confidence,
       status, decided_at, decided_by, created_at, updated_at
from kernel.recommendations
where user_id = (select kernel.current_user_id()) or audience_role_id = any (kernel.current_role_ids());
grant select on kernel.v_recommendations to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The caller's own audit entries (rule 16 keeps the log append-only and company-wide; a user sees only what they did).
-- Without `input` and `diff`: the record's own view tells what the user may read of it.
-- ---------------------------------------------------------------------------------------------
create or replace view kernel.v_audit_log with (security_invoker = true) as
select id, company_id, occurred_at, origin, process_id, entity, row_id, action, chain_id
from kernel.audit_log
where actor_user_id = (select kernel.current_user_id());
grant select on kernel.v_audit_log to authenticated;
create index if not exists audit_log_actor_occurred_idx on kernel.audit_log (actor_user_id, occurred_at desc);

-- ---------------------------------------------------------------------------------------------
-- A plain role starts with the home screen: its KPIs, its recent records and its recommendations inbox. Same function as
-- 0021 with the home processes added to the baseline (existing grants and an admin's own choices are kept).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.seed_role_defaults(p_company uuid, p_role uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform kernel.assert_admin_write(p_company);
  select r.is_system and r.name = 'admin' into v_admin from kernel.roles r where r.id = p_role and r.company_id = p_company;
  if v_admin is null then
    raise exception 'role % is not a role of company %', p_role, p_company using errcode = '22023';
  end if;

  if v_admin then
    insert into kernel.process_permissions (company_id, role_id, process_id)
    select p_company, p_role, rp.process_id from kernel.registered_processes rp
    on conflict (company_id, role_id, process_id) do nothing;
    return;
  end if;

  insert into kernel.process_permissions (company_id, role_id, process_id)
  select p_company, p_role, rp.process_id
  from kernel.registered_processes rp
  where rp.process_id in ('kernel.help.search', 'kernel.data.query', 'kernel.attachment.list', 'kernel.verify.status', 'kernel.export.run')
     or rp.process_id like 'kernel.saved\_view.%'
     or rp.process_id like 'kernel.user\_prefs.%'
     or rp.process_id like 'kernel.home.%'
     or rp.process_id like 'kernel.recommendation.%'
     or (rp.kind = 'consult' and rp.module_id <> 'kernel' and kernel.entitled(p_company, 'module:' || rp.module_id))
  on conflict (company_id, role_id, process_id) do nothing;

  insert into kernel.field_permissions (company_id, role_id, entity, field, mode)
  select p_company, p_role, ef.entity, ef.field, 'masked'
  from kernel.entity_fields ef
  where ef.sensitivity = 'confidential'
  on conflict (company_id, role_id, entity, field) do nothing;
end;
$$;
revoke execute on function kernel.seed_role_defaults(uuid, uuid) from public, anon;
grant execute on function kernel.seed_role_defaults(uuid, uuid) to authenticated, service_role;
