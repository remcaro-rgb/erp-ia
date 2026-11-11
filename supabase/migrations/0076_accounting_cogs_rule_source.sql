-- 0076_accounting_cogs_rule_source
-- Forward-only migration (rule 34). Covered by packages/modules/costing/src/__tests__/cogs.integration.test.ts (the entry links to the
-- movement; this patch applied to an old unmodified copy, a modified copy and twice).
-- Task 8 review (controller ruling, approved 2026-11-05): the default rule "Costo de ventas" (event costing.cogs.posted) takes its
-- source from the sale issue movement, { entity: inventory.movement, id: $.movementId }, so the ledger entry links to a registered
-- record (rule 21) instead of the unregistered `costing.cogs`. Companies seeded earlier keep their copy of the default; sync never
-- rewrites an existing rule, so this brings the unmodified default ones in line. A rule the admin modified keeps its template.

update accounting.posting_rules
set template = jsonb_set(template, '{source}', '{"entity": "inventory.movement", "id": "$.movementId"}'::jsonb)
where event = 'costing.cogs.posted'
  and name = 'Costo de ventas'
  and is_default
  and not is_modified
  and template -> 'source' is distinct from '{"entity": "inventory.movement", "id": "$.movementId"}'::jsonb;
