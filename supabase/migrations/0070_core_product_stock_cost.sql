-- 0070_core_product_stock_cost
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/adjustment.integration.test.ts.
-- core.v_product_stock (0067) gains the standard cost: an inventory adjustment is valued at the line's cost or, failing that, the
-- product's standard cost. The column is masked like the products view (rule 14): a role that cannot see the cost reads null here,
-- and an adjustment without a cost is worth zero (it moves the stock and posts nothing).

create or replace view core.v_product_stock with (security_invoker = true) as
select
  "id",
  "company_id",
  "sku",
  "kind",
  "track_stock",
  "uom_code",
  "category_id",
  case when (select kernel.field_visible('core.product', 'standard_cost')) then "standard_cost" else null end as "standard_cost"
from core.products
where deleted_at is null;

grant select on core.v_product_stock to authenticated;
