-- 0103_invoicing_certificate_fingerprint
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/parametros.integration.test.ts and entities.test.ts.
-- Plan 2B Task 19 fix round 1 (ruling on deviation 3): invoicing.certificate.upload writes the certificate to the secret store FIRST (its own
-- service connection, outside the process transaction) and its metadata after, with the SHA-256 of the .p12 (certificate_fingerprint). If
-- the run fails after the secret was written, the settings keep the previous metadata and fingerprint; invoicing.settings.consult compares
-- the fingerprint with the stored certificate and answers certificate_status 'mismatch' (the page asks to upload it again). The fingerprint
-- is a hash of the encrypted container, not the certificate or its password. invoicing.v_settings is recreated with it.

alter table invoicing.settings
  add column certificate_fingerprint text check (certificate_fingerprint is null or certificate_fingerprint ~ '^[0-9a-f]{64}$');

drop view invoicing.v_settings;
create or replace view invoicing.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.settings', 'invoice_creation')) then "invoice_creation" else null end as "invoice_creation",
  case when (select kernel.field_visible('invoicing.settings', 'dian_environment')) then "dian_environment" else null end as "dian_environment",
  case when (select kernel.field_visible('invoicing.settings', 'default_cost_center_id')) then "default_cost_center_id" else null end as "default_cost_center_id",
  case when (select kernel.field_visible('invoicing.settings', 'credit_days')) then "credit_days" else null end as "credit_days",
  case when (select kernel.field_visible('invoicing.settings', 'software_id')) then "software_id" else null end as "software_id",
  case when (select kernel.field_visible('invoicing.settings', 'software_provider_tax_id')) then "software_provider_tax_id" else null end as "software_provider_tax_id",
  case when (select kernel.field_visible('invoicing.settings', 'test_set_id')) then "test_set_id" else null end as "test_set_id",
  case when (select kernel.field_visible('invoicing.settings', 'issuer_tax_responsibilities')) then "issuer_tax_responsibilities" else null end as "issuer_tax_responsibilities",
  case when (select kernel.field_visible('invoicing.settings', 'issuer_tax_scheme')) then "issuer_tax_scheme" else null end as "issuer_tax_scheme",
  case when (select kernel.field_visible('invoicing.settings', 'issuer_department_code')) then "issuer_department_code" else null end as "issuer_department_code",
  case when (select kernel.field_visible('invoicing.settings', 'issuer_municipality_code')) then "issuer_municipality_code" else null end as "issuer_municipality_code",
  case when (select kernel.field_visible('invoicing.settings', 'dian_defaults_confirmed')) then "dian_defaults_confirmed" else null end as "dian_defaults_confirmed",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_subject')) then "certificate_subject" else null end as "certificate_subject",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_tax_id')) then "certificate_tax_id" else null end as "certificate_tax_id",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_issuer')) then "certificate_issuer" else null end as "certificate_issuer",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_serial')) then "certificate_serial" else null end as "certificate_serial",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_valid_from')) then "certificate_valid_from" else null end as "certificate_valid_from",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_valid_to')) then "certificate_valid_to" else null end as "certificate_valid_to",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_uploaded_at')) then "certificate_uploaded_at" else null end as "certificate_uploaded_at",
  case when (select kernel.field_visible('invoicing.settings', 'software_pin_set_at')) then "software_pin_set_at" else null end as "software_pin_set_at",
  case when (select kernel.field_visible('invoicing.settings', 'certificate_fingerprint')) then "certificate_fingerprint" else null end as "certificate_fingerprint",
  case when (select kernel.field_visible('invoicing.settings', 'extra')) then kernel.mask_extra('invoicing.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.settings;
grant select on invoicing.v_settings to authenticated;
