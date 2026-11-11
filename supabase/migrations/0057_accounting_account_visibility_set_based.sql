-- Account visibility, once per statement instead of once per row (2026-11-04).
--
-- The Plan de cuentas (table and tree) and an account's record page took seconds on the hosted site: with any restricted account in
-- the company, accounting.can_view_account(id) ran its whole check (a security-definer plpgsql call of several queries) for every
-- account of the chart and every entry line read by v_accounts, v_account_balances and accounting.master_tree. This adds
-- accounting.hidden_account_ids(): the accounts of the active company the caller may not view, computed set-based in one query,
-- with exactly the rules of accounting.account_allowed (§5.13): an admin sees everything; an account takes the grants of its
-- nearest restricted ancestor-or-self; a user grant beats the role grants. The three readers test it as an InitPlan, so it runs
-- once per statement. can_view_account stays for single lookups. Forward-only; no data changes.

create or replace function accounting.hidden_account_ids()
returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  with recursive chain as (
    select a.id, a.id as root
    from accounting.accounts a
    where a.company_id = kernel.current_company_id() and a.access = 'restricted'
    union all
    select a.id, c.root
    from accounting.accounts a join chain c on a.parent_id = c.id
    where a.access <> 'restricted'
  ),
  refused as (
    select c.id
    from chain c
    where not kernel.is_company_admin()
      and not coalesce(
        (select g.can_view from accounting.account_permissions g
         where g.account_id = c.root and g.subject_kind = 'user' and g.subject_id = kernel.current_user_id() and g.is_active
         limit 1),
        exists (select 1 from accounting.account_permissions g
                where g.account_id = c.root and g.subject_kind = 'role' and g.subject_id = any (kernel.current_role_ids()) and g.is_active and g.can_view))
  )
  select coalesce(array_agg(id), '{}'::uuid[]) from refused;
$$;
revoke execute on function accounting.hidden_account_ids() from public, anon;
grant execute on function accounting.hidden_account_ids() to authenticated, service_role;

-- The structure of a master's tree (0046), with the account permissions tested once.
create or replace function accounting.master_tree(p_kind text)
returns table (id uuid, parent_id uuid, readable boolean)
language plpgsql stable security definer
set search_path = ''
as $fn$
declare
  v_company uuid := accounting.figure_company();
  v_table text := case p_kind when 'account' then 'accounts' when 'cost_center' then 'cost_centers' when 'open_auxiliary' then 'open_auxiliaries'
                              when 'item' then 'items' when 'business_unit' then 'business_units' end;
begin
  if v_table is null then raise exception 'master_tree: unknown kind %', p_kind using errcode = '22023'; end if;
  if v_company is null then return; end if;
  return query execute format(
    'with h as (select kernel.record_access_hidden($2) as ids),
          v as (select case when %L = ''account'' then accounting.hidden_account_ids() else ''{}''::uuid[] end as ids)
     select t.id, t.parent_id, t.id <> all (h.ids) from accounting.%I t cross join h cross join v
     where t.company_id = $1 and t.id <> all (v.ids)', p_kind, v_table)
  using v_company, 'accounting.' || p_kind;
end;
$fn$;

create or replace view accounting.v_account_balances with (security_invoker = false) as
SELECT l.company_id,
    e.period_id,
    l.account_id,
    l.party_id,
    l.cost_center_id,
    l.open_auxiliary_id,
    l.item_id,
    l.business_unit_id,
    sum(l.debit) AS debit,
    sum(l.credit) AS credit,
    e.is_opening,
    e.is_closing,
    a.statement_section
   FROM ((accounting.entry_lines l
     JOIN accounting.entries e ON ((e.id = l.entry_id)))
     JOIN accounting.accounts a ON ((a.id = l.account_id)))
  WHERE ((l.company_id = ( SELECT accounting.figure_company() AS figure_company)) AND (e.status = ANY (ARRAY['posted'::text, 'reversed'::text])) AND (l.account_id <> ALL ((SELECT accounting.hidden_account_ids())::uuid[])))
  GROUP BY l.company_id, e.period_id, l.account_id, l.party_id, l.cost_center_id, l.open_auxiliary_id, l.item_id, l.business_unit_id, e.is_opening, e.is_closing, a.statement_section;
revoke all on accounting.v_account_balances from anon;
grant select on accounting.v_account_balances to authenticated;

create or replace view accounting.v_accounts with (security_invoker = true) as
SELECT id,
    company_id,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'seq'::text) AS field_visible) THEN seq
            ELSE NULL::bigint
        END AS seq,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'code'::text) AS field_visible) THEN code
            ELSE NULL::text
        END AS code,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'name'::text) AS field_visible) THEN name
            ELSE NULL::text
        END AS name,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'parent_id'::text) AS field_visible) THEN parent_id
            ELSE NULL::uuid
        END AS parent_id,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'level'::text) AS field_visible) THEN level
            ELSE NULL::text
        END AS level,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'nature'::text) AS field_visible) THEN nature
            ELSE NULL::text
        END AS nature,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'allows_movement'::text) AS field_visible) THEN allows_movement
            ELSE NULL::boolean
        END AS allows_movement,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_party'::text) AS field_visible) THEN requires_party
            ELSE NULL::boolean
        END AS requires_party,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_invoice_ready'::text) AS field_visible) THEN requires_invoice_ready
            ELSE NULL::boolean
        END AS requires_invoice_ready,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_cost_center'::text) AS field_visible) THEN requires_cost_center
            ELSE NULL::boolean
        END AS requires_cost_center,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_open_auxiliary'::text) AS field_visible) THEN requires_open_auxiliary
            ELSE NULL::boolean
        END AS requires_open_auxiliary,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_item'::text) AS field_visible) THEN requires_item
            ELSE NULL::boolean
        END AS requires_item,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_business_unit'::text) AS field_visible) THEN requires_business_unit
            ELSE NULL::boolean
        END AS requires_business_unit,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'statement_section'::text) AS field_visible) THEN statement_section
            ELSE NULL::text
        END AS statement_section,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'is_opening_result'::text) AS field_visible) THEN is_opening_result
            ELSE NULL::boolean
        END AS is_opening_result,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'is_active'::text) AS field_visible) THEN is_active
            ELSE NULL::boolean
        END AS is_active,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'access'::text) AS field_visible) THEN access
            ELSE NULL::text
        END AS access,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'extra'::text) AS field_visible) THEN kernel.mask_extra('accounting.account'::text, extra)
            ELSE NULL::jsonb
        END AS extra,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'extra_free'::text) AS field_visible) THEN extra_free
            ELSE NULL::jsonb
        END AS extra_free,
    created_at,
    updated_at,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'period_figure'::text) AS field_visible) THEN accounting.period_figure('account'::text, id, (NULLIF(current_setting('erp.param.period_id'::text, true), ''::text))::uuid)
            ELSE NULL::numeric
        END AS period_figure,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'status'::text) AS field_visible) THEN status
            ELSE NULL::text
        END AS status,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.account'::text, 'requires_approval'::text) AS field_visible) THEN requires_approval
            ELSE NULL::boolean
        END AS requires_approval
   FROM accounting.accounts
  WHERE ((deleted_at IS NULL) AND (company_id = (SELECT kernel.current_company_id())) AND (id <> ALL ((SELECT accounting.hidden_account_ids())::uuid[])));
grant select on accounting.v_accounts to authenticated;
