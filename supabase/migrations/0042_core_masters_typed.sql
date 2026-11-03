-- 0042_core_masters_typed
-- Forward-only migration (rule 34). Covered by packages/modules/core/src/__tests__/typed-masters.integration.test.ts and views.test.ts.
-- The core maestros on the typed-entity lifecycle (entity types spec 2026-11-02 §2.2, §5, §10 D10, §12; Phase 2A.5 Task 8a):
-- core.parties, core.products, core.product_categories and core.price_lists get the maestro columns of kernel.typed_columns (0040):
-- status (Borrador, Grabado, Pendiente de Aprobación, No Aprobado, Aprobado), requires_approval, is_active, void_reason, deleted_at.
--   * Every existing row becomes Grabado ('saved'): no company requires approval of a core maestro today (Task 8 ruling), so a
--     Grabado record stays usable on documents exactly as before. A category's old active / inactive status becomes is_active.
--   * The column default is 'saved', not typed_columns' 'draft': a core maestro is created by its create process, which is the first
--     Grabar of the record (the processes write the state explicitly: Grabado, or Pendiente de Aprobación when the company requires
--     approval, spec §10.2). A row inserted without a process (fixtures, legacy loaders) therefore lands Grabado as the migrated rows do.
--   * The data rewrite of the category runs with its row triggers disabled for the statement: the migration writes no audit rows and
--     does not touch updated_at (a schema change, not a user's edit).
-- Then: the kernel.entity_tables rows of the four maestros (so kernel.record_usable / record_referenced work before the first registry
-- sync), the references to them (Eliminar refuses a referenced maestro), the masked views with the lifecycle columns and without
-- soft-deleted rows, and core.v_party_readiness, whose invoice_ready now also needs a usable party (rule 10, §22.22).

-- ---------------------------------------------------------------------------------------------
-- Categories: status active / inactive -> is_active; the status column becomes the lifecycle state.
-- ---------------------------------------------------------------------------------------------
alter table core.product_categories add column is_active boolean not null default true;
alter table core.product_categories drop constraint product_categories_status_check;
alter table core.product_categories disable trigger audit_row_change;
alter table core.product_categories disable trigger touch_row;
update core.product_categories set is_active = (status is distinct from 'inactive'), status = 'saved';
alter table core.product_categories enable trigger audit_row_change;
alter table core.product_categories enable trigger touch_row;
alter table core.product_categories alter column status set default 'saved';

-- Parties, products and price lists had no status: existing rows take 'saved' from the column default.
alter table core.parties     add column status text not null default 'saved';
alter table core.products    add column status text not null default 'saved';
alter table core.price_lists add column status text not null default 'saved';

-- The maestro columns, the state check and the trigger that copies Requiere aprobación from kernel.entity_type_settings at insert.
-- typed_columns keeps the existing status column and its default; party and product keep their is_active.
select kernel.typed_columns('core', 'parties', 'maestro', 'core.party');
select kernel.typed_columns('core', 'products', 'maestro', 'core.product');
select kernel.typed_columns('core', 'product_categories', 'maestro', 'core.product_category');
select kernel.typed_columns('core', 'price_lists', 'maestro', 'core.price_list');

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate and the reference check work
-- from the migration on.
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name) values
  ('core.party',            'core', 'maestro', 'core', 'parties'),
  ('core.product',          'core', 'maestro', 'core', 'products'),
  ('core.product_category', 'core', 'maestro', 'core', 'product_categories'),
  ('core.price_list',       'core', 'maestro', 'core', 'price_lists')
on conflict (entity) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Who uses a core maestro (kernel."references", 0040): a referenced maestro cannot be deleted, only set Activo = no.
-- The parent column of a maestro's own lines (party_contacts.party_id, price_list_items.price_list_id) is not a use: the lines are
-- part of the record (typed.lines). The accounting columns are registered here as well, so a party on a comprobante or a
-- template is protected from this migration on; accounting's own migration may register them again (the call is idempotent).
-- ---------------------------------------------------------------------------------------------
select kernel.register_reference('core.party',            'core',       'products',             'supplier_id');
select kernel.register_reference('core.party',            'accounting', 'entry_lines',          'party_id');
select kernel.register_reference('core.party',            'accounting', 'entry_template_lines', 'party_id');
select kernel.register_reference('core.product',          'core',       'price_list_items',     'product_id');
select kernel.register_reference('core.product_category', 'core',       'products',             'category_id');

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/core/src/entities.ts and pasted here (views.test.ts
-- fails when they drift). The lifecycle columns are appended (create or replace view keeps the existing columns in place). A
-- soft-deleted maestro (Eliminar, spec §10.2) leaves every grid, lookup and export. core.v_parties keeps the caller's party scope.
-- In core.v_product_categories, status now carries the lifecycle state; Activo is is_active.
-- ---------------------------------------------------------------------------------------------
create or replace view core.v_parties with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.party', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.party', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('core.party', 'person_type')) then "person_type" else null end as "person_type",
  case when (select kernel.field_visible('core.party', 'document_type')) then "document_type" else null end as "document_type",
  case when (select kernel.field_visible('core.party', 'document_number')) then "document_number" else null end as "document_number",
  case when (select kernel.field_visible('core.party', 'check_digit')) then "check_digit" else null end as "check_digit",
  case when (select kernel.field_visible('core.party', 'legal_name')) then "legal_name" else null end as "legal_name",
  case when (select kernel.field_visible('core.party', 'first_surname')) then "first_surname" else null end as "first_surname",
  case when (select kernel.field_visible('core.party', 'second_surname')) then "second_surname" else null end as "second_surname",
  case when (select kernel.field_visible('core.party', 'first_name')) then "first_name" else null end as "first_name",
  case when (select kernel.field_visible('core.party', 'other_names')) then "other_names" else null end as "other_names",
  case when (select kernel.field_visible('core.party', 'trade_name')) then "trade_name" else null end as "trade_name",
  case when (select kernel.field_visible('core.party', 'tax_responsibilities')) then "tax_responsibilities" else null end as "tax_responsibilities",
  case when (select kernel.field_visible('core.party', 'tax_scheme')) then "tax_scheme" else null end as "tax_scheme",
  case when (select kernel.field_visible('core.party', 'ciiu')) then "ciiu" else null end as "ciiu",
  case when (select kernel.field_visible('core.party', 'country_code')) then "country_code" else null end as "country_code",
  case when (select kernel.field_visible('core.party', 'department_code')) then "department_code" else null end as "department_code",
  case when (select kernel.field_visible('core.party', 'municipality_code')) then "municipality_code" else null end as "municipality_code",
  case when (select kernel.field_visible('core.party', 'address_line')) then "address_line" else null end as "address_line",
  case when (select kernel.field_visible('core.party', 'postal_code')) then "postal_code" else null end as "postal_code",
  case when (select kernel.field_visible('core.party', 'invoice_email')) then "invoice_email" else null end as "invoice_email",
  case when (select kernel.field_visible('core.party', 'supplier_email')) then "supplier_email" else null end as "supplier_email",
  case when (select kernel.field_visible('core.party', 'phone_cc')) then "phone_cc" else null end as "phone_cc",
  case when (select kernel.field_visible('core.party', 'phone')) then "phone" else null end as "phone",
  case when (select kernel.field_visible('core.party', 'contact_name')) then "contact_name" else null end as "contact_name",
  case when (select kernel.field_visible('core.party', 'credit_limit')) then "credit_limit" else null end as "credit_limit",
  case when (select kernel.field_visible('core.party', 'balance')) then "balance" else null end as "balance",
  case when (select kernel.field_visible('core.party', 'dian_status')) then "dian_status" else null end as "dian_status",
  case when (select kernel.field_visible('core.party', 'dian_missing')) then "dian_missing" else null end as "dian_missing",
  case when (select kernel.field_visible('core.party', 'invoice_ready')) then "invoice_ready" else null end as "invoice_ready",
  case when (select kernel.field_visible('core.party', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('core.party', 'extra')) then kernel.mask_extra('core.party', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.party', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('core.party', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('core.party', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from core.parties
where deleted_at is null and core.party_scope_allows((select kernel.party_scope()), kind);
grant select on core.v_parties to authenticated;

create or replace view core.v_product_categories with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.product_category', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.product_category', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('core.product_category', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('core.product_category', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('core.product_category', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('core.product_category', 'default_uom')) then "default_uom" else null end as "default_uom",
  case when (select kernel.field_visible('core.product_category', 'income_account')) then "income_account" else null end as "income_account",
  case when (select kernel.field_visible('core.product_category', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('core.product_category', 'extra')) then kernel.mask_extra('core.product_category', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.product_category', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('core.product_category', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('core.product_category', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from core.product_categories
where deleted_at is null;
grant select on core.v_product_categories to authenticated;

create or replace view core.v_products with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.product', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.product', 'sku')) then "sku" else null end as "sku",
  case when (select kernel.field_visible('core.product', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('core.product', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('core.product', 'id_scheme')) then "id_scheme" else null end as "id_scheme",
  case when (select kernel.field_visible('core.product', 'standard_code')) then "standard_code" else null end as "standard_code",
  case when (select kernel.field_visible('core.product', 'brand')) then "brand" else null end as "brand",
  case when (select kernel.field_visible('core.product', 'model')) then "model" else null end as "model",
  case when (select kernel.field_visible('core.product', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('core.product', 'uom_code')) then "uom_code" else null end as "uom_code",
  case when (select kernel.field_visible('core.product', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('core.product', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('core.product', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('core.product', 'tax_override')) then "tax_override" else null end as "tax_override",
  case when (select kernel.field_visible('core.product', 'list_price')) then "list_price" else null end as "list_price",
  case when (select kernel.field_visible('core.product', 'is_free_sample')) then "is_free_sample" else null end as "is_free_sample",
  case when (select kernel.field_visible('core.product', 'reference_price_type')) then "reference_price_type" else null end as "reference_price_type",
  case when (select kernel.field_visible('core.product', 'reference_price')) then "reference_price" else null end as "reference_price",
  case when (select kernel.field_visible('core.product', 'standard_cost')) then "standard_cost" else null end as "standard_cost",
  case when (select kernel.field_visible('core.product', 'track_stock')) then "track_stock" else null end as "track_stock",
  case when (select kernel.field_visible('core.product', 'min_stock')) then "min_stock" else null end as "min_stock",
  case when (select kernel.field_visible('core.product', 'supplier_id')) then "supplier_id" else null end as "supplier_id",
  case when (select kernel.field_visible('core.product', 'dian_status')) then "dian_status" else null end as "dian_status",
  case when (select kernel.field_visible('core.product', 'dian_missing')) then "dian_missing" else null end as "dian_missing",
  case when (select kernel.field_visible('core.product', 'invoice_ready')) then "invoice_ready" else null end as "invoice_ready",
  case when (select kernel.field_visible('core.product', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('core.product', 'extra')) then kernel.mask_extra('core.product', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.product', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('core.product', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('core.product', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from core.products
where deleted_at is null;
grant select on core.v_products to authenticated;

create or replace view core.v_price_lists with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.price_list', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.price_list', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('core.price_list', 'currency_code')) then "currency_code" else null end as "currency_code",
  case when (select kernel.field_visible('core.price_list', 'extra')) then kernel.mask_extra('core.price_list', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.price_list', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('core.price_list', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('core.price_list', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('core.price_list', 'is_active')) then "is_active" else null end as "is_active"
from core.price_lists
where deleted_at is null;
grant select on core.v_price_lists to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Invoice readiness for other modules (0037, rule 10, §22.22): a party is ready only when it is also usable on documents
-- (kernel.record_usable: active and Grabado, or Aprobado when it requires approval), so a Pendiente de Aprobación party with complete
-- DIAN data is not ready. Soft-deleted parties are gone.
-- ---------------------------------------------------------------------------------------------
create or replace view core.v_party_readiness with (security_invoker = true) as
select
  "id",
  "company_id",
  "invoice_ready" and kernel.record_usable('core.party', "id") as "invoice_ready"
from core.parties
where deleted_at is null and core.party_scope_allows((select kernel.party_scope()), kind);

grant select on core.v_party_readiness to authenticated;
