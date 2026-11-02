-- 0039_accounting_account_view_invoice_ready
-- Forward-only. The masked view of accounts publishes requires_invoice_ready (design §22.22, rule 14): migration 0038 added the
-- column to the table but not to accounting.v_accounts, so the account form read it as empty. The column sits where the entity
-- declares it (after requires_party), which `create or replace view` cannot do: the view is dropped and created again.

drop view accounting.v_accounts;

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
  case when (select kernel.field_visible('accounting.account', 'period_figure')) then accounting.period_figure('account', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid) else null end as "period_figure"
from accounting.accounts
where accounting.can_view_account(id);
grant select on accounting.v_accounts to authenticated;
