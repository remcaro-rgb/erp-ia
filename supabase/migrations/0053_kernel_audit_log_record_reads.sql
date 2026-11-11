-- 0053_kernel_audit_log_record_reads
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/record-access.integration.test.ts (I3: grantees see the
-- audit of a record they may read) and packages/kernel/src/typed/__tests__/settings.integration.test.ts (0052 / 0053: the state
-- recipients' audit stays the admin's).
--
-- Regression of 0052 (member_reads: admin, own actor or same chain) on Task 9's rule (0044, I3): a caller who may read a record sees its
-- audit entries; only kernel.record_access_hidden_audit_keys() hides them (record_access_read, unchanged). member_reads is replaced by a
-- narrower restriction: what 0052 meant to protect, the external e-mails of kernel.state_recipients (the process entries of
-- kernel.state_recipients.update and the row trigger's diffs of the table, both under the entity 'kernel.state_recipients'), is read by a
-- company admin, by its own actor, or inside the run on its causal chain. Every other entry is read as before 0052 (company RLS and
-- record_access_read).

drop policy member_reads on kernel.audit_log;

create policy state_recipients_reads on kernel.audit_log as restrictive for select to authenticated using (
  entity is distinct from 'kernel.state_recipients'
  or (select kernel.is_company_admin())
  or actor_user_id = (select kernel.current_user_id())
  or chain_id = nullif(current_setting('erp.audit_chain_id', true), '')::uuid
);
