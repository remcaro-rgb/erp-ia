-- 0055_accounting_template_options
-- Plantillas de comprobante (accounting design §4.10), second round:
--   entry_templates.values_editable : the user of a template may change its fixed amounts (default true, as before)
--   entry_templates.note            : a free note kept with the template
--   entries.template_id             : the plantilla a comprobante was made from (Origen "Plantilla"); the page says so
-- Who may use a template is the record access of kernel.record_access (right "use"), written from the template's Acceso tab.
alter table accounting.entry_templates add column values_editable boolean not null default true;
alter table accounting.entry_templates add column note text;
alter table accounting.entries add column template_id uuid references accounting.entry_templates (id);
create index entries_template_idx on accounting.entries (company_id, template_id) where template_id is not null;
select kernel.register_reference('accounting.entry_template', 'accounting', 'entries', 'template_id');

create or replace view accounting.v_entry_templates with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry_template', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry_template', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.entry_template', 'journal_id')) then "journal_id" else null end as "journal_id",
  case when (select kernel.field_visible('accounting.entry_template', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry_template', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry_template', 'extra')) then kernel.mask_extra('accounting.entry_template', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry_template', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.entry_template', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.entry_template', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.entry_template', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('accounting.entry_template', 'values_editable')) then "values_editable" else null end as "values_editable",
  case when (select kernel.field_visible('accounting.entry_template', 'note')) then "note" else null end as "note"
from accounting.entry_templates
where deleted_at is null;

create or replace view accounting.v_entries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry', 'journal_id')) then "journal_id" else null end as "journal_id",
  case when (select kernel.field_visible('accounting.entry', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('accounting.entry', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('accounting.entry', 'period_id')) then "period_id" else null end as "period_id",
  case when (select kernel.field_visible('accounting.entry', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.entry', 'origin')) then "origin" else null end as "origin",
  case when (select kernel.field_visible('accounting.entry', 'reverse_on')) then "reverse_on" else null end as "reverse_on",
  case when (select kernel.field_visible('accounting.entry', 'submitted_by')) then "submitted_by" else null end as "submitted_by",
  case when (select kernel.field_visible('accounting.entry', 'submitted_at')) then "submitted_at" else null end as "submitted_at",
  case when (select kernel.field_visible('accounting.entry', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('accounting.entry', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('accounting.entry', 'total_debit')) then "total_debit" else null end as "total_debit",
  case when (select kernel.field_visible('accounting.entry', 'total_credit')) then "total_credit" else null end as "total_credit",
  case when (select kernel.field_visible('accounting.entry', 'source_event_id')) then "source_event_id" else null end as "source_event_id",
  case when (select kernel.field_visible('accounting.entry', 'posting_rule_id')) then "posting_rule_id" else null end as "posting_rule_id",
  case when (select kernel.field_visible('accounting.entry', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('accounting.entry', 'source_record_id')) then "source_record_id" else null end as "source_record_id",
  case when (select kernel.field_visible('accounting.entry', 'chain_id')) then "chain_id" else null end as "chain_id",
  case when (select kernel.field_visible('accounting.entry', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry', 'reversal_of_id')) then "reversal_of_id" else null end as "reversal_of_id",
  case when (select kernel.field_visible('accounting.entry', 'reversed_by_id')) then "reversed_by_id" else null end as "reversed_by_id",
  case when (select kernel.field_visible('accounting.entry', 'is_opening')) then "is_opening" else null end as "is_opening",
  case when (select kernel.field_visible('accounting.entry', 'is_closing')) then "is_closing" else null end as "is_closing",
  case when (select kernel.field_visible('accounting.entry', 'is_auto_reversal')) then "is_auto_reversal" else null end as "is_auto_reversal",
  case when (select kernel.field_visible('accounting.entry', 'posted_at')) then "posted_at" else null end as "posted_at",
  case when (select kernel.field_visible('accounting.entry', 'posted_by')) then "posted_by" else null end as "posted_by",
  case when (select kernel.field_visible('accounting.entry', 'extra')) then kernel.mask_extra('accounting.entry', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.entry', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('accounting.entry', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('accounting.entry', 'void_reason')) then "void_reason" else null end as "void_reason",
  case when (select kernel.field_visible('accounting.entry', 'template_id')) then "template_id" else null end as "template_id"
from accounting.entries;
