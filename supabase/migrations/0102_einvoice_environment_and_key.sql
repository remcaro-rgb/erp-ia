-- 0102_einvoice_environment_and_key
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/parametros.integration.test.ts and
-- einvoice-workflow.integration.test.ts. Plan 2B Task 19 fix round 1 (controller rulings on the report's deviations 2 and 6):
--   1. The DIAN environment an invoice or a note was issued in is frozen at «Emitir» (like is_export, 0097): its CUFE / CUDE names it, so
--      its QR, its document and the transport that sends it follow it, never the Parámetros of later. invoice_issued_frozen and
--      note_issued_frozen leave it out of their moving columns: once issued it never changes. Documents issued before this migration take
--      the company's current environment (what their CUFE was computed with: no company has left habilitación yet).
--   2. The resolution's technical key (it signs every CUFE) is no longer readable through core.v_document_sequences: the view answers
--      `technicalKeyEnding` (its last 4 characters) instead. The key is read only by core.document_technical_key, inside a process run, for
--      the caller's active company (the invoicing processes that build the electronic document). The view keeps maskedViewSql's column
--      list (rule 14); only its `from` changes.

alter table invoicing.invoices add column dian_environment text check (dian_environment is null or dian_environment in ('habilitacion', 'produccion'));
alter table invoicing.notes add column dian_environment text check (dian_environment is null or dian_environment in ('habilitacion', 'produccion'));

set local session_replication_role = replica;
update invoicing.invoices i
   set dian_environment = coalesce((select s.dian_environment from invoicing.settings s where s.company_id = i.company_id), 'habilitacion')
 where i.stage <> 'draft';
update invoicing.notes n
   set dian_environment = coalesce((select s.dian_environment from invoicing.settings s where s.company_id = n.company_id), 'habilitacion')
 where n.stage <> 'draft';
set local session_replication_role = origin;

alter table invoicing.invoices add constraint invoices_issued_environment check (stage = 'draft' or dian_environment is not null);
alter table invoicing.notes add constraint notes_issued_environment check (stage = 'draft' or dian_environment is not null);

create or replace function core.document_technical_key(p_company uuid, p_type text, p_prefix text, p_number text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') = '' then
    raise exception 'the technical key is read only inside a process run' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  select resolution ->> 'technicalKey' into v_key
    from core.document_sequences
   where company_id = p_company and document_type = p_type and prefix = coalesce(p_prefix, '') and resolution ->> 'number' = p_number;
  return v_key;
end;
$$;
revoke all on function core.document_technical_key(uuid, text, text, text) from public, anon;
grant execute on function core.document_technical_key(uuid, text, text, text) to authenticated, service_role;

create or replace view core.v_document_sequences with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.document_sequence', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.document_sequence', 'document_type')) then "document_type" else null end as "document_type",
  case when (select kernel.field_visible('core.document_sequence', 'prefix')) then "prefix" else null end as "prefix",
  case when (select kernel.field_visible('core.document_sequence', 'next_number')) then "next_number" else null end as "next_number",
  case when (select kernel.field_visible('core.document_sequence', 'padding')) then "padding" else null end as "padding",
  case when (select kernel.field_visible('core.document_sequence', 'resolution')) then "resolution" else null end as "resolution",
  case when (select kernel.field_visible('core.document_sequence', 'extra')) then kernel.mask_extra('core.document_sequence', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.document_sequence', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from (
  select s.id, s.company_id, s.seq, s.document_type, s.prefix, s.next_number, s.padding,
         case when s.resolution is null then null
              else (s.resolution - 'technicalKey') || jsonb_build_object('technicalKeyEnding', right(s.resolution ->> 'technicalKey', 4)) end as resolution,
         s.extra, s.extra_free, s.created_at, s.updated_at
  from core.document_sequences s
) as document_sequences;
grant select on core.v_document_sequences to authenticated;
