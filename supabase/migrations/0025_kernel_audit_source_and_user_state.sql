-- 0025_kernel_audit_source_and_user_state
-- Forward-only migration (rule 34). Covered by packages/kernel/src/audit/__tests__/audit-detail.integration.test.ts.
--
-- Owner decisions of 2026-10-29 (design §22.13, §22.14, §22.16; rules 16 and 37):
--   * The source record of a clone. kernel.audit_log.source_row_id is the record a creation was cloned from:
--     runProcess(…, { sourceRowId }) writes it on the process entry (writeAudit) and sets `erp.audit_source_row_id` for
--     the transaction (setAuditContext), which the row trigger copies onto the insert entries of that run.
--   * The audit viewer's detail. kernel.v_audit_entries also publishes the entry's `diff` (the row trigger's column
--     before/after), its `input` and its `source_row_id`, still to the company admin only. The registry entity
--     `kernel.audit` does not declare diff or input: the grid, its exports and kernel.audit.consult select registry fields
--     only, so they never carry them; kernel.audit.entry reads them for one entry and applies the viewer's field
--     visibility (kernel.field_mode, kernel.mask_extra) before anything leaves the database session. The existing system
--     admin roles are granted kernel.audit.entry; the row trigger never records a `token`, `secret` or `password` column.
--   * Editable users (Task 7). kernel.memberships.is_active: a deactivated membership keeps its history and its roles but
--     stops counting: kernel.current_role_ids() (0024) ignores it, so every helper built on it (is_company_admin,
--     can_run_process, field_mode, mask_extra, party_scope, the recommendation policies) refuses at once.
--     kernel.v_memberships shows the state to the admin.

-- ---------------------------------------------------------------------------------------------
-- The source record of a clone (rule 37). No foreign key, like row_id: the log outlives the rows it describes.
-- ---------------------------------------------------------------------------------------------
alter table kernel.audit_log add column source_row_id uuid;

-- Same body as 0002 with two changes:
--   * the source of a cloned creation: an insert entry carries `erp.audit_source_row_id` when the process transaction set
--     it; updates and deletes never do;
--   * secrets never reach the log (review of Task 4, defence in depth): a column named `token`, `secret` or `password`
--     (kernel.agent_confirmations.token is a bearer secret 0020 hides from every reader) is left out of the recorded
--     diff, on every audited table, whether or not its value changed.
create or replace function kernel.audit_row_change() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  old_json jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) - array['token', 'secret', 'password'] end;
  new_json jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) - array['token', 'secret', 'password'] end;
  row_json jsonb := case when tg_op = 'DELETE' then old_json else new_json end;
  changes  jsonb;
begin
  select jsonb_object_agg(
           coalesce(o.key, n.key),
           jsonb_build_object('old', coalesce(o.value, 'null'::jsonb), 'new', coalesce(n.value, 'null'::jsonb))
         )
    into changes
  from jsonb_each(old_json) o
  full join jsonb_each(new_json) n on n.key = o.key
  where coalesce(o.key, n.key) not in ('updated_at', 'updated_by')
    and coalesce(o.value, 'null'::jsonb) is distinct from coalesce(n.value, 'null'::jsonb);

  -- An update that changed nothing worth recording writes no row.
  if tg_op = 'UPDATE' and changes is null then
    return new;
  end if;

  insert into kernel.audit_log
    (company_id, actor_user_id, origin, process_id, entity, row_id, action, diff, chain_id, conversation_id, source_row_id)
  values (
    -- A company's own id is its company id; every other table carries a company_id column (or none).
    nullif(
      case when tg_table_schema = 'kernel' and tg_table_name = 'companies' then row_json ->> 'id'
           else row_json ->> 'company_id' end,
      ''
    )::uuid,
    coalesce(nullif(current_setting('erp.audit_actor_user_id', true), '')::uuid, kernel.current_user_id()),
    coalesce(nullif(current_setting('erp.audit_origin', true), ''), 'db'),
    nullif(current_setting('erp.audit_process_id', true), ''),
    tg_table_schema || '.' || tg_table_name,
    nullif(row_json ->> 'id', '')::uuid,
    lower(tg_op),
    coalesce(changes, '{}'::jsonb),
    coalesce(nullif(current_setting('erp.audit_chain_id', true), '')::uuid, gen_random_uuid()),
    nullif(current_setting('erp.audit_conversation_id', true), '')::uuid,
    case when tg_op = 'INSERT' then nullif(current_setting('erp.audit_source_row_id', true), '')::uuid end
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function kernel.audit_row_change() from public;

-- ---------------------------------------------------------------------------------------------
-- The audit viewer's read view (0023) with the entry's diff, input and source, appended (same leading columns). Still
-- the company admin's only: anyone else reads nothing here.
-- ---------------------------------------------------------------------------------------------
create or replace view kernel.v_audit_entries with (security_invoker = true) as
select a.id, a.company_id, a.occurred_at, a.origin, a.process_id, a.entity, a.row_id, a.action,
       a.actor_user_id, u.email as actor, a.chain_id, a.conversation_id,
       a.diff, a.input, a.source_row_id
from kernel.audit_log a
left join kernel.users u on u.id = a.actor_user_id
where (select kernel.is_company_admin());

-- The detail of an update gathers the row changes of its run: same chain, same record.
create index if not exists audit_log_chain_row_idx on kernel.audit_log (chain_id, row_id);

-- ---------------------------------------------------------------------------------------------
-- The detail's consult (kernel.audit.entry) for the system admin roles that already exist: kernel.seed_role_defaults
-- (0021) gives a new admin role every registered process, but a database seeded before this migration has admin roles
-- without the new process in their matrix. Service role and migrations only; idempotent (returns the grants added).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.grant_process_to_system_admins(p_process text) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_added integer;
begin
  insert into kernel.process_permissions (company_id, role_id, process_id)
  select r.company_id, r.id, p_process
  from kernel.roles r
  where r.is_system and r.name = 'admin'
  on conflict (company_id, role_id, process_id) do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end;
$$;
revoke execute on function kernel.grant_process_to_system_admins(text) from public, anon, authenticated;
grant execute on function kernel.grant_process_to_system_admins(text) to service_role;

select kernel.grant_process_to_system_admins('kernel.audit.entry');

-- ---------------------------------------------------------------------------------------------
-- Membership state (Task 7 deactivates through kernel.admin.user.update).
-- ---------------------------------------------------------------------------------------------
alter table kernel.memberships add column is_active boolean not null default true;

-- Same body as 0024 with an inactive membership left out: its roles no longer count, whatever the token says.
create or replace function kernel.current_role_ids() returns uuid[]
language sql stable security definer parallel safe
set search_path = ''
as $$
  select coalesce(
    array(
      select claimed.id
      from (select distinct jsonb_array_elements_text(kernel.jwt_claims() -> 'role_ids')::uuid as id) as claimed
      where (
          kernel.current_user_id() = '00000000-0000-0000-0000-000000000000'::uuid
          and session_user <> 'authenticator'
        )
        or exists (
          select 1
          from kernel.membership_roles mr
          join kernel.memberships m on m.id = mr.membership_id
          where m.user_id = kernel.current_user_id()
            and m.company_id = kernel.current_company_id()
            and m.is_active
            and mr.role_id = claimed.id
        )
      order by claimed.id
    ),
    '{}'::uuid[]
  );
$$;
revoke execute on function kernel.current_role_ids() from public, anon;
grant execute on function kernel.current_role_ids() to authenticated, service_role;

-- 0021's member list with the membership state appended (same leading columns, same predicates).
create or replace view kernel.v_memberships with (security_barrier = true) as
select m.id, m.user_id, m.company_id, u.email, u.full_name,
       case when own.only then u.mobile_cc end as mobile_cc,
       case when own.only then u.mobile end as mobile,
       case when own.only then u.photo end as photo,
       m.created_at,
       coalesce((select array_agg(mr.role_id order by mr.role_id) from kernel.membership_roles mr where mr.membership_id = m.id), '{}'::uuid[]) as role_ids,
       kernel.member_mfa_enrolled(m.user_id) as mfa_enrolled,
       m.is_active
from kernel.memberships m
join kernel.users u on u.id = m.user_id
-- Same predicate as kernel.user_of_caller_tenant, inline (owner's rights): every membership in the caller's tenant.
cross join lateral (
  select not exists (
    select 1 from kernel.memberships o join kernel.companies c on c.id = o.company_id
    where o.user_id = m.user_id and c.tenant_id is distinct from (select kernel.current_tenant_id())
  ) as only
) own
where m.company_id = (select kernel.current_company_id())
  and array[m.company_id] <@ (select kernel.current_company_ids())
  and (select kernel.is_company_admin());
