-- 0067_core_product_stock
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/movement.integration.test.ts (a service is
-- refused, a product that keeps no stock moves nothing) and stock-level.integration.test.ts.
-- What other modules need to know of a product to move its stock (rule 3: they read core's published views, never its tables), the
-- pattern of core.v_party_readiness (0037): core.v_products masks fields by the caller's field visibility, so a role that cannot see
-- `track_stock` or `kind` would make inventory move a service or skip a stocked good. This view publishes those facts unmasked, with the
-- SKU for the refusals' text and the category for costing (plan 2B Tasks 6, 8). Security invoker: company RLS and the products' record
-- access read policy apply; soft-deleted products are gone. Reads only; core's processes keep writing the products.

create or replace view core.v_product_stock with (security_invoker = true) as
select
  "id",
  "company_id",
  "sku",
  "kind",
  "track_stock",
  "uom_code",
  "category_id"
from core.products
where deleted_at is null;

grant select on core.v_product_stock to authenticated;
