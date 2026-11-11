-- 0043_accounting_entries_typed
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/typed-masters.integration.test.ts,
-- entry-lifecycle.integration.test.ts and views.test.ts.
-- The accounting maestros and comprobantes on the typed-entity lifecycle (entity types spec 2026-11-02 §5, §8, §10 D2, D3, D8, D9,
-- §10.2, §12; Phase 2A.5 Task 8b):
--   * Maestros: cuentas, fuentes, the four analytic dimensions and the plantillas get the maestro columns of kernel.typed_columns
--     (0040). Every existing row is Grabado ('saved'), the column default too (as core in 0042: a master is created by its create
--     process, which writes the state; a row inserted without a process lands Grabado and stays usable). Años fiscales and períodos
--     are Parámetros (D13, D14): their status stays open / closed and they get no lifecycle columns.
--   * Plantillas: the name is unique per company (D14 import key). Duplicate names, if any, are renamed "<name> (#<seq>)" first (seq is unique per company, so the new name cannot collide), oldest
--     kept as is, with the row triggers disabled for the statement.
--   * Comprobantes: a documento that posts itself (`posts` true, the column default too). Old states map as spec §5.1 / D2 say:
--     draft → draft, pending → pending, posted → posted, reversed → posted with the mark extra.reversed = true (the reversed_by_id
--     link stays), voided → voided (its extra.void_reason copied to void_reason). No row becomes Grabado: an existing posting
--     comprobante in 'saved' would post on its next Grabar (Task 6 note). requires_approval: true for a pending entry and for a
--     non-automatic one of a company with require_approval_on_manual; the create processes write it explicitly from now on.
--     A posted comprobante is balanced (the old check also exempted pending; now every state before posted is).
--   * Lines change while the comprobante is Borrador, Grabado or No Aprobado (D3), and during its posting step (the rounding line
--     and the header business unit), which the post hook marks with the transaction-local setting accounting.posting_entry.
--   * The data rewrites run with the row triggers disabled for their statements: the migration writes no audit rows and does not
--     touch updated_at (a schema change, not a user's edit).
-- Then: the kernel.entity_tables rows, the references to the accounting maestros (Eliminar refuses a referenced one) and the masked
-- views with the lifecycle columns appended and without soft-deleted maestros.

-- ---------------------------------------------------------------------------------------------
-- Maestros: status (Grabado for every existing row) and the typed columns.
-- ---------------------------------------------------------------------------------------------
alter table accounting.accounts         add column status text not null default 'saved';
alter table accounting.journals         add column status text not null default 'saved';
alter table accounting.cost_centers     add column status text not null default 'saved';
alter table accounting.open_auxiliaries add column status text not null default 'saved';
alter table accounting.items            add column status text not null default 'saved';
alter table accounting.business_units   add column status text not null default 'saved';
alter table accounting.entry_templates  add column status text not null default 'saved';

-- Plantillas: one name per company.
alter table accounting.entry_templates disable trigger audit_row_change;
alter table accounting.entry_templates disable trigger touch_row;
update accounting.entry_templates t
   set name = t.name || ' (#' || t.seq || ')'
  from (select id, row_number() over (partition by company_id, name order by seq) as n from accounting.entry_templates) d
 where d.id = t.id and d.n > 1;
alter table accounting.entry_templates enable trigger audit_row_change;
alter table accounting.entry_templates enable trigger touch_row;
alter table accounting.entry_templates add constraint entry_templates_company_id_name_key unique (company_id, name);

select kernel.typed_columns('accounting', 'accounts',         'maestro', 'accounting.account');
select kernel.typed_columns('accounting', 'journals',         'maestro', 'accounting.journal');
select kernel.typed_columns('accounting', 'cost_centers',     'maestro', 'accounting.cost_center');
select kernel.typed_columns('accounting', 'open_auxiliaries', 'maestro', 'accounting.open_auxiliary');
select kernel.typed_columns('accounting', 'items',            'maestro', 'accounting.item');
select kernel.typed_columns('accounting', 'business_units',   'maestro', 'accounting.business_unit');
select kernel.typed_columns('accounting', 'entry_templates',  'maestro', 'accounting.entry_template');

-- ---------------------------------------------------------------------------------------------
-- Comprobantes: the old states, then the documento columns.
-- ---------------------------------------------------------------------------------------------
-- The state an old comprobante takes (spec §5.1, D2). Unknown values raise: nothing is turned into Grabado by accident.
create or replace function accounting.legacy_entry_status(p_status text) returns text
language plpgsql immutable
set search_path = ''
as $$
begin
  case p_status
    when 'draft' then return 'draft';
    when 'pending' then return 'pending';
    when 'posted' then return 'posted';
    when 'reversed' then return 'posted';
    when 'voided' then return 'voided';
    else raise exception 'legacy_entry_status: unexpected comprobante state %', p_status using errcode = '22023';
  end case;
end;
$$;
revoke execute on function accounting.legacy_entry_status(text) from public, anon;
grant execute on function accounting.legacy_entry_status(text) to authenticated, service_role;

alter table accounting.entries drop constraint entries_status_check;
alter table accounting.entries drop constraint entries_check;
alter table accounting.entries disable trigger audit_row_change;
alter table accounting.entries disable trigger touch_row;
update accounting.entries
   set status = accounting.legacy_entry_status(status),
       extra = case when status = 'reversed' then extra || '{"reversed": true}'::jsonb else extra end
 where status not in ('draft', 'pending', 'posted', 'voided');

select kernel.typed_columns('accounting', 'entries', 'documento', 'accounting.entry');

update accounting.entries e
   set posts = true,
       requires_approval = (e.status = 'pending' or (e.origin <> 'auto' and coalesce((select s.require_approval_on_manual from accounting.settings s where s.company_id = e.company_id), false))),
       void_reason = case when e.status = 'voided' then nullif(e.extra->>'void_reason', '') end;
alter table accounting.entries enable trigger audit_row_change;
alter table accounting.entries enable trigger touch_row;
-- A comprobante posts itself (spec §10.2): an insert that does not say otherwise posts.
alter table accounting.entries alter column posts set default true;
-- A comprobante that is posted is balanced (§5.5); before posting the rounding line is not there yet.
alter table accounting.entries add constraint entries_posted_balanced check (status <> 'posted' or total_debit = total_credit);

-- Lines of a comprobante change while it may change (D3: Borrador, Grabado, No Aprobado) and during its posting step, which the
-- post hook marks for that comprobante (rounding line, header business unit); a posted one is corrected by reversal (§4.7).
create or replace function accounting.entry_lines_frozen() returns trigger
language plpgsql
as $$
declare
  v_entry uuid := case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
  v_status text;
begin
  select status into v_status from accounting.entries where id = v_entry;
  if v_status in ('draft', 'saved', 'rejected')
     or (v_status = 'approved' and current_setting('accounting.posting_entry', true) = v_entry::text) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Las líneas de un comprobante solo se pueden cambiar mientras está en Borrador, Grabado o No Aprobado';
end;
$$;

-- Eliminar (D1): a Borrador is deleted with its lines by the lifecycle, as the caller (company RLS applies). Only a Borrador: a
-- comprobante that was ever Grabado is voided or reversed, never deleted, whoever issues the statement.
grant delete on accounting.entries to authenticated;
create or replace function accounting.entries_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'erp:invalid_input:Solo se elimina un comprobante en Borrador';
  end if;
  return old;
end;
$$;
create trigger entries_delete_draft_only before delete on accounting.entries for each row execute function accounting.entries_delete_draft_only();

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate and the reference check work
-- from the migration on. Años fiscales and períodos are Parámetros: no row.
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name) values
  ('accounting.account',        'accounting', 'maestro',   'accounting', 'accounts'),
  ('accounting.journal',        'accounting', 'maestro',   'accounting', 'journals'),
  ('accounting.cost_center',    'accounting', 'maestro',   'accounting', 'cost_centers'),
  ('accounting.open_auxiliary', 'accounting', 'maestro',   'accounting', 'open_auxiliaries'),
  ('accounting.item',           'accounting', 'maestro',   'accounting', 'items'),
  ('accounting.business_unit',  'accounting', 'maestro',   'accounting', 'business_units'),
  ('accounting.entry_template', 'accounting', 'maestro',   'accounting', 'entry_templates'),
  ('accounting.entry',          'accounting', 'documento', 'accounting', 'entries')
on conflict (entity) do nothing;
delete from kernel.entity_tables where entity in ('accounting.fiscal_year', 'accounting.period');

-- ---------------------------------------------------------------------------------------------
-- Who uses an accounting maestro (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no. The parent
-- column of a maestro's own lines (entry_template_lines.template_id) is not a use. A tree node is used by its children (parent_id).
-- The party columns were registered by 0042 and are registered again here (idempotent). Fiscal years and periods are Parámetros
-- (no Eliminar), their columns are registered all the same so the registry tells who uses them.
-- ---------------------------------------------------------------------------------------------
select kernel.register_reference('accounting.account', 'accounting', 'accounts',                'parent_id');
select kernel.register_reference('accounting.account', 'accounting', 'account_role_mappings',   'account_id');
select kernel.register_reference('accounting.account', 'accounting', 'account_permissions',     'account_id');
select kernel.register_reference('accounting.account', 'accounting', 'fiscal_concept_mappings', 'account_id');
select kernel.register_reference('accounting.account', 'accounting', 'entry_lines',             'account_id');
select kernel.register_reference('accounting.account', 'accounting', 'entry_template_lines',    'account_id');
select kernel.register_reference('accounting.journal', 'accounting', 'entries',         'journal_id');
select kernel.register_reference('accounting.journal', 'accounting', 'entry_templates', 'journal_id');
select kernel.register_reference('accounting.journal', 'accounting', 'posting_rules',   'journal_id');
select kernel.register_reference('accounting.journal', 'accounting', 'settings',        'manual_journal_id');
select kernel.register_reference('accounting.cost_center',    'accounting', 'cost_centers',         'parent_id');
select kernel.register_reference('accounting.cost_center',    'accounting', 'entry_lines',          'cost_center_id');
select kernel.register_reference('accounting.cost_center',    'accounting', 'entry_template_lines', 'cost_center_id');
select kernel.register_reference('accounting.open_auxiliary', 'accounting', 'open_auxiliaries',     'parent_id');
select kernel.register_reference('accounting.open_auxiliary', 'accounting', 'entry_lines',          'open_auxiliary_id');
select kernel.register_reference('accounting.open_auxiliary', 'accounting', 'entry_template_lines', 'open_auxiliary_id');
select kernel.register_reference('accounting.item',           'accounting', 'items',                'parent_id');
select kernel.register_reference('accounting.item',           'accounting', 'entry_lines',          'item_id');
select kernel.register_reference('accounting.item',           'accounting', 'entry_template_lines', 'item_id');
select kernel.register_reference('accounting.business_unit',  'accounting', 'business_units',       'parent_id');
select kernel.register_reference('accounting.business_unit',  'accounting', 'entries',              'business_unit_id');
select kernel.register_reference('accounting.business_unit',  'accounting', 'entry_lines',          'business_unit_id');
select kernel.register_reference('accounting.business_unit',  'accounting', 'entry_templates',      'business_unit_id');
select kernel.register_reference('accounting.business_unit',  'accounting', 'entry_template_lines', 'business_unit_id');
select kernel.register_reference('accounting.fiscal_year', 'accounting', 'periods',             'fiscal_year_id');
select kernel.register_reference('accounting.period',      'accounting', 'entries',             'period_id');
select kernel.register_reference('accounting.period',      'accounting', 'period_close_checks', 'period_id');
select kernel.register_reference('core.party', 'accounting', 'entry_lines',          'party_id');
select kernel.register_reference('core.party', 'accounting', 'entry_template_lines', 'party_id');

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/accounting/src/entities.ts and pasted here
-- (views.test.ts fails when they drift). The lifecycle columns are appended (create or replace view keeps the existing columns in
-- place). A soft-deleted maestro (Eliminar, spec §10.2) leaves every grid, lookup and export; v_accounts keeps the account security
-- filter of design §5.13.
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_accounts with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.account', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.account', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.account', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.account', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.account', 'level')) then "level" else null end as "level",
  case when (select kernel.field_visible('accounting.account', 'nature')) then "nature" else null end as "nature",
  case when (select kernel.field_visible('accounting.account', 'allows_movement')) then "allows_movement" else null end as "allows_movement",
  case when (select kernel.field_visible('accounting.account', 'requires_party')) then "requires_party" else null end as "requires_party",
  case when (select kernel.field_visible('accounting.account', 'requires_invoice_ready')) then "requires_invoice_ready" else null end as "requires_invoice_ready",
  case when (select kernel.field_visible('accounting.account', 'requires_cost_center')) then "requires_cost_center" else null end as "requires_cost_center",
  case when (select kernel.field_visible('accounting.account', 'requires_open_auxiliary')) then "requires_open_auxiliary" else null end as "requires_open_auxiliary",
  case when (select kernel.field_visible('accounting.account', 'requires_item')) then "requires_item" else null end as "requires_item",
  case when (select kernel.field_visible('accounting.account', 'requires_business_unit')) then "requires_business_unit" else null end as "requires_business_unit",
  case when (select kernel.field_visible('accounting.account', 'statement_section')) then "statement_section" else null end as "statement_section",
  case when (select kernel.field_visible('accounting.account', 'is_opening_result')) then "is_opening_result" else null end as "is_opening_result",
  case when (select kernel.field_visible('accounting.account', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.account', 'access')) then "access" else null end as "access",
  case when (select kernel.field_visible('accounting.account', 'extra')) then kernel.mask_extra('accounting.account', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.account', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.account', 'period_figure')) then accounting.period_figure('account', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid) else null end as "period_figure",
  case when (select kernel.field_visible('accounting.account', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.account', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.accounts
where deleted_at is null and accounting.can_view_account(id);
grant select on accounting.v_accounts to authenticated;

create or replace view accounting.v_journals with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.journal', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.journal', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.journal', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.journal', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.journal', 'next_number')) then "next_number" else null end as "next_number",
  case when (select kernel.field_visible('accounting.journal', 'manual_entries')) then "manual_entries" else null end as "manual_entries",
  case when (select kernel.field_visible('accounting.journal', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.journal', 'extra')) then kernel.mask_extra('accounting.journal', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.journal', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.journal', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.journal', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.journals
where deleted_at is null;
grant select on accounting.v_journals to authenticated;

create or replace view accounting.v_cost_centers with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.cost_center', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.cost_center', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.cost_center', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.cost_center', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.cost_center', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.cost_center', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.cost_center', 'extra')) then kernel.mask_extra('accounting.cost_center', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.cost_center', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.cost_center', 'period_figure')) then accounting.period_figure('cost_center', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid) else null end as "period_figure",
  case when (select kernel.field_visible('accounting.cost_center', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.cost_center', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.cost_centers
where deleted_at is null;
grant select on accounting.v_cost_centers to authenticated;

create or replace view accounting.v_open_auxiliaries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'extra')) then kernel.mask_extra('accounting.open_auxiliary', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'period_figure')) then accounting.period_figure('open_auxiliary', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid) else null end as "period_figure",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.open_auxiliary', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.open_auxiliaries
where deleted_at is null;
grant select on accounting.v_open_auxiliaries to authenticated;

create or replace view accounting.v_items with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.item', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.item', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.item', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.item', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.item', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.item', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.item', 'extra')) then kernel.mask_extra('accounting.item', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.item', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.item', 'period_figure')) then accounting.period_figure('item', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid) else null end as "period_figure",
  case when (select kernel.field_visible('accounting.item', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.item', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.items
where deleted_at is null;
grant select on accounting.v_items to authenticated;

create or replace view accounting.v_business_units with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.business_unit', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.business_unit', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('accounting.business_unit', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('accounting.business_unit', 'parent_id')) then "parent_id" else null end as "parent_id",
  case when (select kernel.field_visible('accounting.business_unit', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('accounting.business_unit', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('accounting.business_unit', 'extra')) then kernel.mask_extra('accounting.business_unit', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.business_unit', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.business_unit', 'period_figure')) then accounting.period_figure('business_unit', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid) else null end as "period_figure",
  case when (select kernel.field_visible('accounting.business_unit', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.business_unit', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.business_units
where deleted_at is null;
grant select on accounting.v_business_units to authenticated;

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
  case when (select kernel.field_visible('accounting.entry_template', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from accounting.entry_templates
where deleted_at is null;
grant select on accounting.v_entry_templates to authenticated;

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
  case when (select kernel.field_visible('accounting.entry', 'void_reason')) then "void_reason" else null end as "void_reason"
from accounting.entries;
grant select on accounting.v_entries to authenticated;


-- The process ids this migration removes (entity types spec D2; review of Task 8b, Important 2). A role's grant and a company's step-up
-- setting on a removed id move to the ids that now do the same work, so nobody loses what they could do and no raise to step-up is lost:
--   accounting.entry.post            → accounting.entry.save and accounting.entry.approve (Grabar y contabilizar, Aprobar y contabilizar)
--   accounting.entry.return_to_draft → accounting.entry.reject (No Aprobar)
--   accounting.entry.void            → kept (Anular, now of Grabado / Pendiente / No Aprobado / Aprobado) and accounting.entry.delete
--                                      (Eliminar: the old void of a Borrador)
-- An existing row on a target id wins (on conflict do nothing); the rows on the removed ids are deleted. Idempotent: the integration
-- test calls it again on rows it writes.
create or replace function accounting.migrate_entry_process_ids() returns void
language plpgsql as $$
begin
  insert into kernel.process_permissions (company_id, role_id, process_id, allowed)
  select p.company_id, p.role_id, m.target, p.allowed
    from kernel.process_permissions p
    join (values ('accounting.entry.post', 'accounting.entry.save'), ('accounting.entry.post', 'accounting.entry.approve'),
                 ('accounting.entry.return_to_draft', 'accounting.entry.reject'), ('accounting.entry.void', 'accounting.entry.delete')) m(source, target)
      on m.source = p.process_id
  on conflict (company_id, role_id, process_id) do nothing;
  insert into kernel.sensitive_processes (company_id, process_id, mode)
  select s.company_id, m.target, s.mode
    from kernel.sensitive_processes s
    join (values ('accounting.entry.post', 'accounting.entry.save'), ('accounting.entry.post', 'accounting.entry.approve'),
                 ('accounting.entry.return_to_draft', 'accounting.entry.reject'), ('accounting.entry.void', 'accounting.entry.delete')) m(source, target)
      on m.source = s.process_id
  on conflict (company_id, process_id) do nothing;
  delete from kernel.process_permissions where process_id in ('accounting.entry.post', 'accounting.entry.return_to_draft');
  delete from kernel.sensitive_processes where process_id in ('accounting.entry.post', 'accounting.entry.return_to_draft');
end;
$$;
revoke all on function accounting.migrate_entry_process_ids() from public;
select accounting.migrate_entry_process_ids();
