-- 0136_invoicing_dian_checks_policies
-- Forward-only migration (rule 34). Covered by dian-checklist.integration.test.ts.
-- Task 35 fix round 1 (M3): the ticks are written only by invoicing.dian_checklist.tick; 0135's policies admitted any process id with the
-- prefix (the consult, a future process; `_` is also a like wildcard). Replaced by equality; 0135 stays as applied.

drop policy via_process_insert on invoicing.dian_checks;
drop policy via_process_update on invoicing.dian_checks;
create policy via_process_insert on invoicing.dian_checks as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'invoicing.dian_checklist.tick');
create policy via_process_update on invoicing.dian_checks as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'invoicing.dian_checklist.tick')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'invoicing.dian_checklist.tick');
