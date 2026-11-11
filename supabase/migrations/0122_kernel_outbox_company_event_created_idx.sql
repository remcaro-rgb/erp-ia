-- 0122_kernel_outbox_company_event_created_idx
-- Forward-only migration (rule 34), plan 2B.2 Task 50.6 fix round 1. Covered by
-- packages/modules/accounting/src/__tests__/rule-stale.integration.test.ts.
--
-- accounting.posting_rule.consult's stale scan reads the newest events of one event name for one company within N days
-- (where company_id and event and created_at > ... order by created_at desc limit 5000): this index serves it.

create index if not exists outbox_company_event_created_idx on kernel.outbox (company_id, event, created_at desc);
