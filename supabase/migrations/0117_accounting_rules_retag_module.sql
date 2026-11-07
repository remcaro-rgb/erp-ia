-- 0117_accounting_rules_retag_module
-- Forward-only migration (rule 34), plan 2B.2 Task 50.14 (owner item 14, 2026-11-06). Covered by
-- packages/modules/accounting/src/__tests__/posting-rules-sync.integration.test.ts («migration 0117 …»).
-- Re-runnable: it only touches rows still tagged `accounting`.
--
-- The default posting rules `cogs-posted` and `inventory-adjustment` moved from accounting's 2A defaults to the manifests of the modules that
-- own their events (costing, inventory). accounting.posting_rule.sync matches a rule by (event, name) and never rewrites an existing row, so
-- a company seeded before this change still holds both rows tagged module = 'accounting': the off-switch of costing / inventory would not
-- reach them. This sets the owner on those rows, by (event, name); template, `when`, priority, journal and flags stay as they are (behaviour
-- identical). A rule the admin modified (is_modified) is not touched at all: the sync never reads its module for any decision.

update accounting.posting_rules
   set module = 'costing'
 where module = 'accounting' and is_default and not is_modified
   and event = 'costing.cogs.posted' and name = 'Costo de ventas';

update accounting.posting_rules
   set module = 'inventory'
 where module = 'accounting' and is_default and not is_modified
   and event = 'inventory.movement.posted' and name = 'Ajuste de inventario';
