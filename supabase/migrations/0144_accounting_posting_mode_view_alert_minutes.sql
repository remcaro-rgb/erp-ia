-- 0144_accounting_posting_mode_view_alert_minutes
-- Forward-only migration (rule 34), plan 2B.2 Task 52.7 fix round 1 (owner item 107). Covered by
-- packages/modules/accounting/src/__tests__/posting-age.integration.test.ts («the scheduler's cheap read»).
--
-- The scheduled checks of the outbox tick (apps/web/src/lib/server/scheduled-checks.ts) run accounting.posting.age_check for a company only
-- when a cheap read says there is something to do, so the check writes no audit row on a quiet tick. That read needs the company's
-- alert threshold (0143) through a published view: accounting.v_posting_mode gains posting_alert_minutes, appended after its columns. Like
-- the mode, the threshold is not sensitive. security_invoker as before: the base table's company RLS applies to the caller.

create or replace view accounting.v_posting_mode with (security_invoker = true) as
select company_id, posting_mode, posting_alert_minutes from accounting.settings;
revoke all on accounting.v_posting_mode from public, anon;
grant select on accounting.v_posting_mode to authenticated, service_role;
