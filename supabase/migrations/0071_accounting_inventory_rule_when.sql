-- 0071_accounting_inventory_rule_when
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/inventory-adjustment.integration.test.ts
-- (a fresh company's rule carries the condition) and by the kernel's rule-when tests.
-- The default rule "Ajuste de inventario" (event inventory.movement.posted) now applies only to kind = adjustment with a non-zero value
-- (plan 2B Task 7): before, it fired on every inventory movement (receipts, issues, traslado legs) and recorded an invalid_template failure
-- for each, because only an adjustment carries a value. Companies seeded earlier keep their copy of the default; sync never rewrites an
-- existing rule, so this brings the unmodified default ones in line. A rule the admin modified keeps its template untouched.

update accounting.posting_rules
set template = template || jsonb_build_object(
      'when', jsonb_build_array(
        jsonb_build_object('path', '$.kind', 'equals', 'adjustment'),
        jsonb_build_object('path', '$.value', 'notEquals', 0)))
where event = 'inventory.movement.posted'
  and name = 'Ajuste de inventario'
  and is_default
  and not is_modified
  and not (template ? 'when');
