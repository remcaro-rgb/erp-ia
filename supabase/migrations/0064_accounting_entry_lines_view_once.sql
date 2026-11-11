-- 0064_accounting_entry_lines_view_once
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/permission.integration.test.ts.
-- v_entry_lines names `can_view` in about fifteen of its masked columns. The planner pulled the inner select up and repeated its
-- expression in each of them, so every copy ran its own `accounting.hidden_account_ids()` (0057): 85 ms for the five lines of one
-- comprobante on the hosted project. OFFSET 0 keeps the inner select as it is, evaluated once. hidden_account_ids itself returns at
-- once for an administrator and for a company with no restricted account.

create or replace function accounting.hidden_account_ids()
returns uuid[]
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_hidden  uuid[];
begin
  if not exists (select 1 from accounting.accounts a where a.company_id = v_company and a.access = 'restricted') then
    return '{}'::uuid[];
  end if;
  if kernel.is_company_admin() then
    return '{}'::uuid[];
  end if;
  with recursive chain as (
    select a.id, a.id as root
    from accounting.accounts a
    where a.company_id = v_company and a.access = 'restricted'
    union all
    select a.id, c.root
    from accounting.accounts a join chain c on a.parent_id = c.id
    where a.access <> 'restricted'
  ),
  refused as (
    select c.id
    from chain c
    where not coalesce(
      (select g.can_view from accounting.account_permissions g
       where g.account_id = c.root and g.subject_kind = 'user' and g.subject_id = kernel.current_user_id() and g.is_active
       limit 1),
      exists (select 1 from accounting.account_permissions g
              where g.account_id = c.root and g.subject_kind = 'role' and g.subject_id = any (kernel.current_role_ids()) and g.is_active and g.can_view))
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_hidden from refused;
  return v_hidden;
end;
$$;

create or replace view accounting.v_entry_lines with (security_invoker = true) as
SELECT id,
    company_id,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'seq'::text) AS field_visible) THEN seq
            ELSE NULL::bigint
        END AS seq,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'entry_id'::text) AS field_visible) THEN entry_id
            ELSE NULL::uuid
        END AS entry_id,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'line_no'::text) AS field_visible) THEN line_no
            ELSE NULL::integer
        END AS line_no,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'account_id'::text) AS field_visible) AND can_view) THEN account_id
            ELSE NULL::uuid
        END AS account_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'party_id'::text) AS field_visible) AND can_view) THEN party_id
            ELSE NULL::uuid
        END AS party_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'cost_center_id'::text) AS field_visible) AND can_view) THEN cost_center_id
            ELSE NULL::uuid
        END AS cost_center_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'open_auxiliary_id'::text) AS field_visible) AND can_view) THEN open_auxiliary_id
            ELSE NULL::uuid
        END AS open_auxiliary_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'item_id'::text) AS field_visible) AND can_view) THEN item_id
            ELSE NULL::uuid
        END AS item_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'business_unit_id'::text) AS field_visible) AND can_view) THEN business_unit_id
            ELSE NULL::uuid
        END AS business_unit_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'description'::text) AS field_visible) AND can_view) THEN description
            ELSE NULL::text
        END AS description,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'debit'::text) AS field_visible) AND can_view) THEN debit
            ELSE NULL::numeric
        END AS debit,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'credit'::text) AS field_visible) AND can_view) THEN credit
            ELSE NULL::numeric
        END AS credit,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'debit_doc'::text) AS field_visible) AND can_view) THEN debit_doc
            ELSE NULL::numeric
        END AS debit_doc,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'credit_doc'::text) AS field_visible) AND can_view) THEN credit_doc
            ELSE NULL::numeric
        END AS credit_doc,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'tax_code'::text) AS field_visible) AND can_view) THEN tax_code
            ELSE NULL::text
        END AS tax_code,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'tax_rate'::text) AS field_visible) AND can_view) THEN tax_rate
            ELSE NULL::numeric
        END AS tax_rate,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'tax_base'::text) AS field_visible) AND can_view) THEN tax_base
            ELSE NULL::numeric
        END AS tax_base,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'reference'::text) AS field_visible) AND can_view) THEN reference
            ELSE NULL::text
        END AS reference,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'due_date'::text) AS field_visible) AND can_view) THEN due_date
            ELSE NULL::date
        END AS due_date,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'extra'::text) AS field_visible) THEN kernel.mask_extra('accounting.entry_line'::text, extra)
            ELSE NULL::jsonb
        END AS extra,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'extra_free'::text) AS field_visible) THEN extra_free
            ELSE NULL::jsonb
        END AS extra_free,
    created_at,
    updated_at,
    (NOT can_view) AS is_restricted
   FROM ( SELECT el.id,
            el.seq,
            el.company_id,
            el.entry_id,
            el.line_no,
            el.account_id,
            el.party_id,
            el.cost_center_id,
            el.open_auxiliary_id,
            el.item_id,
            el.business_unit_id,
            el.description,
            el.debit,
            el.credit,
            el.debit_doc,
            el.credit_doc,
            el.tax_code,
            el.tax_rate,
            el.tax_base,
            el.reference,
            el.due_date,
            el.extra,
            el.extra_free,
            el.created_at,
            el.updated_at,
            el.created_by,
            el.updated_by,
            ((el.company_id = ( SELECT kernel.current_company_id() AS current_company_id)) AND (el.account_id <> ALL (( SELECT accounting.hidden_account_ids() AS hidden_account_ids)::uuid[]))) AS can_view
           FROM accounting.entry_lines el
          OFFSET 0) entry_lines;
