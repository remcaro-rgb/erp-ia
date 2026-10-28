-- 0023_kernel_audit_view
-- Forward-only migration (rule 34). Covered by packages/kernel/src/admin/__tests__/audit.integration.test.ts.
-- The audit viewer (design §5.9 "the audit viewer is itself a consult process with its own permission", §6, rule 16),
-- Task 22: kernel.v_audit_entries is the read view of the registry entity `kernel.audit`, which the /admin/audit grid,
-- its exports and the process kernel.audit.consult read (rule 14: one view for every channel).
--   * The company admin only (`kernel.is_company_admin()`): every entry of the active company (company RLS of 0002),
--     whoever made it. Anybody else reads nothing here, even with the process granted; a user's own entries stay in
--     kernel.v_audit_log (0022, the home screen's recent records).
--   * Without `input` and `diff`: what a process received and the column values it changed can carry confidential
--     fields (credit limits, costs) that only the record's own masked view may show. The entry says who, when, from
--     where, which process, which record and which causal chain.
--   * The actor's e-mail, read under the caller's rights (kernel.users visibility of 0001: members of the caller's
--     companies); null for an actor who is no longer one (or the system).

create or replace view kernel.v_audit_entries with (security_invoker = true) as
select a.id, a.company_id, a.occurred_at, a.origin, a.process_id, a.entity, a.row_id, a.action,
       a.actor_user_id, u.email as actor, a.chain_id, a.conversation_id
from kernel.audit_log a
left join kernel.users u on u.id = a.actor_user_id
where (select kernel.is_company_admin());

revoke all on kernel.v_audit_entries from anon;
grant select on kernel.v_audit_entries to authenticated, service_role;

-- The viewer's grid filters by process and origin and sorts by date within the company (0002 indexes company + date).
create index if not exists audit_log_company_process_idx on kernel.audit_log (company_id, process_id, occurred_at desc);
