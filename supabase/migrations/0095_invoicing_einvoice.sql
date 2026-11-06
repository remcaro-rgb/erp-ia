-- 0095_invoicing_einvoice
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/einvoice-workflow.integration.test.ts and
-- entities.test.ts (the masked views match the entity definitions).
-- The DIAN submission of issued invoices (plan 2B Task 17, which named it 0068; 0095 was the next free number; design §18a, §19, OD-1):
--   * invoicing.settings gains what the electronic document needs beyond the resolution: the software registered with the DIAN (its id and
--     the provider's NIT; its PIN is a secret of the secret store, never a column: rule 12), the habilitación test set and the company's
--     fiscal profile as issuer (responsibilities, tax scheme, department and municipality). invoicing.v_settings is recreated with them;
--   * invoicing.einvoice_submissions (sistema, one row per issued invoice, unique on the invoice): what the e-invoice workflow did — its
--     status, the sending round (a rejected document corrected and sent again with the same number and CUFE), the submit attempts and the
--     polls, the DIAN's trackId, the errors of a rejection, the signed XML, the ApplicationResponse and (Task 19) the PDF in the file store;
--   * the DIAN status of an invoice only moves forward: draft → submitted → accepted | rejected, and rejected → submitted when a corrected
--     document is sent again («Reintentar envío»); a Borrador is never sent.
-- Company RLS, row audit, seq, extra / extra_free, writes only through the invoicing processes (restrictive policies on
-- erp.audit_process_id), the invoice's read right inherited (kernel.typed_lines).

-- =============================================================================================
-- Parámetros: software and issuer profile
-- =============================================================================================
alter table invoicing.settings
  add column software_id                 text check (software_id is null or char_length(software_id) between 1 and 100),
  add column software_provider_tax_id    text check (software_provider_tax_id is null or software_provider_tax_id ~ '^[0-9]{5,15}$'),
  add column test_set_id                 text check (test_set_id is null or char_length(test_set_id) between 1 and 100),
  add column issuer_tax_responsibilities text[] not null default '{}',
  add column issuer_tax_scheme           text not null default '01' check (issuer_tax_scheme in ('01', '04', 'ZA', 'ZZ')),
  add column issuer_department_code      text check (issuer_department_code is null or issuer_department_code ~ '^[0-9]{2}$'),
  add column issuer_municipality_code    text check (issuer_municipality_code is null or issuer_municipality_code ~ '^[0-9]{5}$');

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
  case when (select kernel.field_visible('invoicing.settings', 'extra')) then kernel.mask_extra('invoicing.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.settings;
grant select on invoicing.v_settings to authenticated;

-- =============================================================================================
-- Envíos a la DIAN
-- =============================================================================================
-- status: queued (waiting for its workflow run) · not_configured (the company has no software registered: nothing was sent; «Reintentar
-- envío» once it is) · processing (a run claimed it: building, signing, sending, polling) · submitted (the DIAN has it, no verdict yet) ·
-- accepted · rejected (errors lists the DIAN's) · failed (the run stopped: last_error says why; a document already sent is polled again by
-- its trackId on «Reintentar envío», never sent twice). `attempts` counts the submits of the current round (one, unless its answer was lost
-- and the next attempt polled instead), `polls` the polls of the round. `run_id` is the workflow run that owns the row.
create table invoicing.einvoice_submissions (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  invoice_id    uuid not null references invoicing.invoices (id),
  status        text not null default 'queued' check (status in ('queued', 'not_configured', 'processing', 'submitted', 'accepted', 'rejected', 'failed')),
  round         int not null default 1 check (round > 0),
  attempts      int not null default 0 check (attempts >= 0),
  polls         int not null default 0 check (polls >= 0),
  track_id      text check (track_id is null or char_length(track_id) <= 200),
  run_id        text check (run_id is null or char_length(run_id) <= 200),
  cufe          text check (cufe is null or cufe ~ '^[0-9a-f]{96}$'),
  errors        jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  last_error    text check (last_error is null or char_length(last_error) <= 2000),
  xml_path      text,
  response_path text,
  pdf_path      text,
  submitted_at  timestamptz,
  decided_at    timestamptz,
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (invoice_id),
  -- A verdict has its moment; an accepted document has its signed XML stored.
  check ((status in ('accepted', 'rejected')) = (decided_at is not null)),
  check (status <> 'accepted' or (xml_path is not null and track_id is not null))
);
create index einvoice_submissions_company_status_idx on invoicing.einvoice_submissions (company_id, status);

select kernel.enable_company_rls('invoicing', 'einvoice_submissions');
select kernel.enable_row_audit('invoicing', 'einvoice_submissions');
create trigger assign_seq before insert on invoicing.einvoice_submissions for each row execute function core.assign_seq('invoicing.einvoice_submission');
create trigger touch_row before update on invoicing.einvoice_submissions for each row execute function core.touch_row();
select kernel.typed_lines('invoicing', 'einvoice_submissions', 'invoicing.invoice', 'invoice_id');

grant select, insert, update on invoicing.einvoice_submissions to authenticated;
grant all on invoicing.einvoice_submissions to service_role;

create policy via_process_insert on invoicing.einvoice_submissions as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%');
create policy via_process_update on invoicing.einvoice_submissions as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%');

-- A submission is never deleted (the record of what was sent to the DIAN, rule 9), whoever issues the statement.
create or replace function invoicing.einvoice_submission_kept() returns trigger
language plpgsql
as $$
begin
  raise exception 'erp:invalid_input:El envío de una factura a la DIAN no se elimina';
end;
$$;
create trigger einvoice_submission_kept before delete on invoicing.einvoice_submissions
  for each row execute function invoicing.einvoice_submission_kept();

-- =============================================================================================
-- The DIAN status of an invoice only moves forward
-- =============================================================================================
create or replace function invoicing.invoice_dian_status_forward() returns trigger
language plpgsql
as $$
begin
  if new.dian_status is not distinct from old.dian_status then
    return new;
  end if;
  if new.stage = 'draft' then
    raise exception 'erp:invalid_input:Una factura en Borrador no se envía a la DIAN';
  end if;
  if not ((old.dian_status = 'draft' and new.dian_status = 'submitted')
       or (old.dian_status = 'submitted' and new.dian_status in ('accepted', 'rejected'))
       or (old.dian_status = 'rejected' and new.dian_status = 'submitted')) then
    raise exception 'erp:invalid_input:El estado DIAN de la factura no pasa de % a %', old.dian_status, new.dian_status;
  end if;
  return new;
end;
$$;
create trigger invoice_dian_status_forward before update of dian_status on invoicing.invoices
  for each row execute function invoicing.invoice_dian_status_forward();

-- ---------------------------------------------------------------------------------------------
-- Masked view (rule 14), generated by maskedViewSql from the entity definition: the invoice page lists the submission and its errors.
-- ---------------------------------------------------------------------------------------------
create or replace view invoicing.v_einvoice_submissions with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'round')) then "round" else null end as "round",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'attempts')) then "attempts" else null end as "attempts",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'polls')) then "polls" else null end as "polls",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'track_id')) then "track_id" else null end as "track_id",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'run_id')) then "run_id" else null end as "run_id",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'cufe')) then "cufe" else null end as "cufe",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'errors')) then "errors" else null end as "errors",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'last_error')) then "last_error" else null end as "last_error",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'xml_path')) then "xml_path" else null end as "xml_path",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'response_path')) then "response_path" else null end as "response_path",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'pdf_path')) then "pdf_path" else null end as "pdf_path",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'submitted_at')) then "submitted_at" else null end as "submitted_at",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'decided_at')) then "decided_at" else null end as "decided_at",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'extra')) then kernel.mask_extra('invoicing.einvoice_submission', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.einvoice_submission', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.einvoice_submissions;
grant select on invoicing.v_einvoice_submissions to authenticated;
