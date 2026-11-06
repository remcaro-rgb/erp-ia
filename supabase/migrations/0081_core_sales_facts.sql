-- 0081_core_sales_facts
-- Forward-only migration (rule 34). Covered by packages/modules/crm/src/__tests__/quote.integration.test.ts (the line gate and the taxes
-- of a cotización read these views) and packages/modules/sales/src/__tests__/pricing.integration.test.ts.
-- What a sale document line needs of a tercero and a product, published by core for the modules that sell (rule 3: other modules read core
-- only through views core publishes; precedents core.v_party_readiness 0037, core.v_product_stock 0067):
--   * the invoice readiness and its reasons (rule 10, design §5.17): `invoice_ready`, the DIAN data still missing, whether it is active and
--     the required files it lacks. core.v_parties / v_products mask these by field visibility; a module that must enforce the gate (and say
--     why) reads them here, unmasked, under the same company RLS, record-level read and party scope.
--   * the tax facts the country pack computes the line's taxes from (person type and responsibilities of the tercero; IVA, INC, other taxes,
--     free sample and reference price of the product). Taxes must be right whoever writes the line, so these are not masked either.
-- Prices are not here: the list price stays masked in core.v_products (a role that cannot see it cannot quote with it).

create or replace view core.v_party_sales with (security_invoker = true) as
select
  "id",
  "company_id",
  "kind",
  "person_type",
  "tax_responsibilities",
  "invoice_ready",
  "is_active",
  "status",
  "dian_status",
  "dian_missing",
  kernel.missing_attachments("company_id", 'core.party', "id", "country_code", "person_type", "kind") as "missing_files"
from core.parties
where deleted_at is null
  and core.party_scope_allows((select kernel.party_scope()), kind);

grant select on core.v_party_sales to authenticated;

create or replace view core.v_product_sales with (security_invoker = true) as
select
  "id",
  "company_id",
  "sku",
  "description",
  "kind",
  "uom_code",
  "iva_rate",
  "inc_rate",
  "other_taxes",
  "is_free_sample",
  "reference_price",
  "invoice_ready",
  "is_active",
  "status",
  "dian_status",
  "dian_missing",
  kernel.missing_attachments("company_id", 'core.product', "id", null, null, null) as "missing_files"
from core.products
where deleted_at is null;

grant select on core.v_product_sales to authenticated;
