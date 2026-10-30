-- 0030_kernel_saved_views_reports
-- Forward-only migration (rule 34). Covered by packages/kernel/src/saved-views/__tests__/saved-views.integration.test.ts
-- Saved parameter sets of reports (design §9): a saved view's `entity` may be `report:<module>.<name>`, the key of a
-- report's parameter sets, besides a registered entity id. The state then carries the report's `params`.

alter table kernel.saved_views drop constraint saved_views_entity_check;
alter table kernel.saved_views add constraint saved_views_entity_check
  check (entity ~ '^(report:)?[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
