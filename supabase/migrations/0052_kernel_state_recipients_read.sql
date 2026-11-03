-- 0052_kernel_state_recipients_read
-- Forward-only migration (rule 34). Covered by packages/kernel/src/typed/__tests__/settings.integration.test.ts
-- («only a company admin reads the state recipients», «a member reads only their own audit rows»).
--
-- Phase 2A.5 minors (final review, parked m5; owner 2026-11-03): the e-mail lists of kernel.state_recipients (Parámetros ›
-- Destinatarios por estado) are external addresses only a company admin configures; any member could read them. Reading them is now
-- for company admins only, like writing them (0040). The state-mail consumer reads them on the service connection (it sends in the
-- actor's name, not with the actor's rights over this table), so the mails a member's action triggers are unchanged; Notificar shows
-- the configured list to admins only.

create policy admin_reads on kernel.state_recipients as restrictive for select to authenticated using ((select kernel.is_company_admin()));

-- Phase 2A.5 minors round 2 (review concern 3, defense in depth): kernel.audit_log carries `input` and `diff`, which can hold values only a
-- record's masked view may show (the recipients above, credit limits, costs). Members held select on every row of their company (0002).
-- A row is now readable by a company admin (kernel.v_audit_entries and the audit detail, 0023 / 0025), by its own actor
-- (kernel.v_audit_log, 0022, the home screen's recent records) and inside the run whose causal chain it belongs to (the transaction-local
-- erp.audit_chain_id that setAuditContext sets: the lifecycle's causingUser looks up the person behind an event on its chain). The
-- security definer readers (kernel.record_access_hidden_audit_keys, 0044) are unaffected; record_access_read (0044) still applies.
create policy member_reads on kernel.audit_log as restrictive for select to authenticated using (
  (select kernel.is_company_admin())
  or actor_user_id = (select kernel.current_user_id())
  or chain_id = nullif(current_setting('erp.audit_chain_id', true), '')::uuid
);
