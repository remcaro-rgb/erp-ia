-- 0101_invoicing_parametros
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/parametros.integration.test.ts,
-- einvoice-workflow.integration.test.ts and entities.test.ts (the masked view).
-- The Parámetros of electronic invoicing (plan 2B Task 19; rule 12; Tasks 5, 17 and 18 carry-overs):
--   * dian_defaults_confirmed (false by default; only invoicing.settings.update, step-up, sets it): the company confirmed the DIAN defaults
--     the documents use that the DIAN may still ask to change (CreditNoteTypeCode 91 on every credit note, CustomizationID 10 on export
--     invoices, no InvoiceControl on notes: Task 18). A company in producción has it confirmed (the database holds the rule too);
--   * what the signing certificate says of itself (subject, its NIT, issuer, serial, validity) and when it and the software PIN were stored.
--     The certificate, its password and the PIN themselves live only in the secret store (Supabase Vault: migration 0099), never here;
--   * the PDF of an accepted document (einvoice_submissions.pdf_path, Task 17's slot): only an accepted submission has one, and it is
--     written once (exactly once: a stored representation is never replaced).
-- invoicing.v_settings is recreated with the new columns (maskedViewSql of invoicing.settings).

alter table invoicing.settings
  add column dian_defaults_confirmed boolean not null default false,
  add column certificate_subject     text check (certificate_subject is null or char_length(certificate_subject) <= 300),
  add column certificate_tax_id      text check (certificate_tax_id is null or char_length(certificate_tax_id) <= 30),
  add column certificate_issuer      text check (certificate_issuer is null or char_length(certificate_issuer) <= 300),
  add column certificate_serial      text check (certificate_serial is null or char_length(certificate_serial) <= 100),
  add column certificate_valid_from  timestamptz,
  add column certificate_valid_to    timestamptz,
  add column certificate_uploaded_at timestamptz,
  add column software_pin_set_at     timestamptz,
  add constraint settings_dian_defaults_confirmed check (dian_environment <> 'produccion' or dian_defaults_confirmed);

alter table invoicing.einvoice_submissions
  add constraint einvoice_submissions_pdf_accepted check (pdf_path is null or status = 'accepted');

create or replace function invoicing.einvoice_pdf_once() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path then
    raise exception 'einvoice_pdf_stored: the PDF of an accepted document is stored once' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger einvoice_submissions_pdf_once before update of pdf_path on invoicing.einvoice_submissions
  for each row execute function invoicing.einvoice_pdf_once();

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
  case when (select kernel.field_visible('invoicing.settings', 'extra')) then kernel.mask_extra('invoicing.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.settings;
grant select on invoicing.v_settings to authenticated;
