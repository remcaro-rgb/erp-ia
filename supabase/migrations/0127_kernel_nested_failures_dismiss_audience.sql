-- 0127_kernel_nested_failures_dismiss_audience
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/nested-run-config.integration.test.ts (section 8).
-- Plan 2B Task 32, fix round 1 of the security review (M9): a role granted only kernel.nested_failure.dismiss sees the nested-run failure
-- queue too (it could dismiss a row it could not see). 0126 is already recorded as applied on the local stack, so this is a new migration
-- instead of an edit of 0126. The view kernel.v_nested_run_failures is security invoker and follows the policy unchanged; the raw input stays
-- without a user grant.

drop policy queue_audience on kernel.nested_run_failures;
create policy queue_audience on kernel.nested_run_failures as restrictive for select to authenticated
  using (kernel.is_company_admin() or kernel.can_run_process('kernel.nested_failure.retry') or kernel.can_run_process('kernel.nested_failure.dismiss'));
