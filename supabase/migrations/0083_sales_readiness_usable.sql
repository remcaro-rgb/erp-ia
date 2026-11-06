-- 0083_sales_readiness_usable
-- Forward-only migration (rule 34). Covered by packages/modules/crm/src/__tests__/quote.integration.test.ts (a tercero or a product that
-- is complete but pending approval or inactive is refused on a cotización with its reason; an approver sees the cotizaciones that need
-- approval) and packages/modules/crm/src/__tests__/entities.test.ts (the text of these views and policy).
--
-- 1. The sale facts of 0081 with both halves of invoice readiness (rule 10, §22.22, as core.v_party_readiness since 0042): `invoice_ready`
--    is the stored flag (DIAN data complete, required files) AND kernel.record_usable (active, Grabado, or Aprobado when it requires
--    approval), so a Pendiente de Aprobación tercero or product with complete data is not ready. `usable`, `status` and
--    `requires_approval` are published too, so the gate can say why (sales' readinessReasons).
--
--    Deliberate unmasked exposure (correcting the header of 0081, which said no price is here): these views do not apply field visibility.
--    A module that enforces the gate or computes taxes reads, whatever the caller's field permissions: of a tercero its kind, person type
--    and tax responsibilities; of a product its SKU, description, kind, unit, IVA and INC rates, other taxes, free-sample flag and its
--    reference price (the DIAN commercial value of a free sample, which the taxes of that line need); of both the readiness facts. Company
--    RLS, record-level read and the party scope still apply. The list price is not here: it stays masked in core.v_products (a role that
--    cannot see it cannot quote with it).
-- 2. Row isolation of cotizaciones (0082): besides the owner and whoever may reassign oportunidades, a role that may approve cotizaciones
--    (crm.quote.approve) sees the ones that need approval (requires_approval: pending, approved or rejected), so the approver does not need
--    the sales manager's reassign right. Their lines follow (their policy is the parent's visibility).

create or replace view core.v_party_sales with (security_invoker = true) as
select
  "id",
  "company_id",
  "kind",
  "person_type",
  "tax_responsibilities",
  "invoice_ready" and kernel.record_usable('core.party', "id") as "invoice_ready",
  "is_active",
  "status",
  "dian_status",
  "dian_missing",
  kernel.missing_attachments("company_id", 'core.party', "id", "country_code", "person_type", "kind") as "missing_files",
  kernel.record_usable('core.party', "id") as "usable",
  "requires_approval"
from core.parties
where deleted_at is null
  and core.party_scope_allows((select kernel.party_scope()), kind);

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
  "invoice_ready" and kernel.record_usable('core.product', "id") as "invoice_ready",
  "is_active",
  "status",
  "dian_status",
  "dian_missing",
  kernel.missing_attachments("company_id", 'core.product', "id", null, null, null) as "missing_files",
  kernel.record_usable('core.product', "id") as "usable",
  "requires_approval"
from core.products
where deleted_at is null;

drop policy owner_scope on crm.quotes;
create policy owner_scope on crm.quotes as restrictive for select to authenticated
  using (
    owner_id is null
    or owner_id = (select kernel.current_user_id())
    or (select kernel.can_run_process('crm.opportunity.reassign'))
    or (requires_approval and (select kernel.can_run_process('crm.quote.approve')))
  );
