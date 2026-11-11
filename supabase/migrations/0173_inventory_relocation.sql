-- 0173_inventory_relocation
-- Forward-only migration (rule 34). Covered by packages/modules/warehouse/src/__tests__/putaway.integration.test.ts (a put-away relocates the
-- stock with a movement of kind relocation; costing ignores it) and packages/modules/inventory/src/__tests__/entities.test.ts (the kinds).
-- Plan 2B.2 Task 29.3 (PG §4.3 step 8, owner item 155): the movement kind `relocation` (Reubicación, numbered RU-), posted by
-- inventory.relocation.post: stock moved between two ubicaciones of ONE bodega, two lines per relocated line (− from, + to) with the lot
-- and the serial kept. It changes no quantity of the bodega and no cost: costing skips it (packages/modules/costing, its feed goes past it),
-- accounting has no rule for it. The kinds of inventory/src/entities.ts (MOVEMENT_KINDS, KIND_SIGN, KIND_PREFIX) follow this check.

alter table inventory.movements drop constraint movements_kind_check;
alter table inventory.movements add constraint movements_kind_check
  check (kind in ('receipt', 'issue', 'sale_issue', 'sale_return', 'adjustment', 'transfer_out', 'transfer_in', 'relocation'));
