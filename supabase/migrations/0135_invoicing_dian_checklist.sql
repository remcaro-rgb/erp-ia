-- 0135_invoicing_dian_checklist
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/dian-checklist.integration.test.ts,
-- parametros.integration.test.ts and entities.test.ts (the masked views).
-- The DIAN verification checklist (plan 2B Task 35, owner item 20; R35-5..R35-7, R35-10):
--   * invoicing.dian_checks: one row per item of the country pack's checklist ever ticked in the company (the list itself lives in the pack,
--     rule 5, so the database does not validate the key: the process does). A tick has its who and when; an untick keeps the row with
--     neither, and the row audit (kernel.enable_row_audit) records every change with actor, origin and chain (rule 16). Nothing is deleted.
--     Only invoicing.dian_checklist.tick writes it (restrictive policies: the process id).
--   * invoicing.settings.dian_checklist_version: the list version the confirmation was made at (null when not confirmed); the check ties
--     it to dian_defaults_confirmed. The confirmation counts only while it equals the pack's version and every item is ticked.
--   * guard_dian_defaults: dian_defaults_confirmed and dian_checklist_version change only inside invoicing.dian_checklist.tick (it clears them
--     when an item is unticked) and invoicing.dian_defaults.confirm; a user session outside them is refused, the service connection passes.
--   * invoicing.v_settings is recreated with the new column and invoicing.v_dian_checks is created (maskedViewSql of their entities).

alter table invoicing.settings add column dian_checklist_version int check (dian_checklist_version is null or dian_checklist_version > 0);
-- Existing confirmed rows (Task 19 era, before the checklist) keep the confirmation only if the company is in producción (0101 forbids lowering it there);
-- they get the version 1 stamp. Companies in habilitación lose it: the checklist is the new way to confirm (R35-7).
update invoicing.settings set dian_checklist_version = 1 where dian_defaults_confirmed and dian_environment = 'produccion';
update invoicing.settings set dian_defaults_confirmed = false where dian_defaults_confirmed and dian_environment <> 'produccion';
alter table invoicing.settings add constraint settings_dian_checklist_version check (dian_defaults_confirmed = (dian_checklist_version is not null));

create table invoicing.dian_checks (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  item_key   text not null check (item_key ~ '^[a-z][a-z0-9_]*$' and char_length(item_key) <= 80),
  ticked     boolean not null default false,
  ticked_by  uuid,
  ticked_at  timestamptz,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, item_key),
  -- A tick has its who and when; an untick keeps neither.
  check (ticked = (ticked_by is not null and ticked_at is not null))
);

select kernel.enable_company_rls('invoicing', 'dian_checks');
select kernel.enable_row_audit('invoicing', 'dian_checks');
create trigger assign_seq before insert on invoicing.dian_checks for each row execute function core.assign_seq('invoicing.dian_check');
create trigger touch_row before update on invoicing.dian_checks for each row execute function core.touch_row();

grant select, insert, update on invoicing.dian_checks to authenticated;
grant all on invoicing.dian_checks to service_role;

create policy via_process_insert on invoicing.dian_checks as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.dian_checklist.%');
create policy via_process_update on invoicing.dian_checks as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.dian_checklist.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.dian_checklist.%');

-- A tick is never deleted (the record of who verified what, rule 9), whoever issues the statement.
create or replace function invoicing.dian_check_kept() returns trigger
language plpgsql
as $$
begin
  raise exception 'erp:invalid_input:La verificación de un valor DIAN no se elimina: se desmarca';
end;
$$;
create trigger dian_check_kept before delete on invoicing.dian_checks
  for each row execute function invoicing.dian_check_kept();

-- R35-6d: only the two processes change the confirmation (rule 1): a user session outside them is refused, a session without a user (service) passes.
create or replace function invoicing.guard_dian_defaults() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if kernel.current_user_id() is not null
     and coalesce(current_setting('erp.audit_process_id', true), '') not in ('invoicing.dian_checklist.tick', 'invoicing.dian_defaults.confirm')
     and (tg_op = 'INSERT' and (new.dian_defaults_confirmed or new.dian_checklist_version is not null)
          or tg_op = 'UPDATE' and (new.dian_defaults_confirmed is distinct from old.dian_defaults_confirmed
                                   or new.dian_checklist_version is distinct from old.dian_checklist_version)) then
    raise exception 'dian_defaults_confirmed and dian_checklist_version change only through invoicing.dian_checklist.tick and invoicing.dian_defaults.confirm' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists guard_dian_defaults on invoicing.settings;
create trigger guard_dian_defaults before insert or update of dian_defaults_confirmed, dian_checklist_version on invoicing.settings
  for each row execute function invoicing.guard_dian_defaults();

-- The masked views, generated from the entities (a column in the middle cannot be added by create or replace view).
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
  case when (select kernel.field_visible('invoicing.settings', 'dian_checklist_version')) then "dian_checklist_version" else null end as "dian_checklist_version",
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

create or replace view invoicing.v_dian_checks with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.dian_check', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.dian_check', 'item_key')) then "item_key" else null end as "item_key",
  case when (select kernel.field_visible('invoicing.dian_check', 'ticked')) then "ticked" else null end as "ticked",
  case when (select kernel.field_visible('invoicing.dian_check', 'ticked_by')) then "ticked_by" else null end as "ticked_by",
  case when (select kernel.field_visible('invoicing.dian_check', 'ticked_at')) then "ticked_at" else null end as "ticked_at",
  case when (select kernel.field_visible('invoicing.dian_check', 'extra')) then kernel.mask_extra('invoicing.dian_check', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.dian_check', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from invoicing.dian_checks;
grant select on invoicing.v_dian_checks to authenticated;
