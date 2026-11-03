-- 0046_accounting_record_access
-- Record-level access on the ledger (entity types spec 2026-11-02 §9.1, D11; Phase 2A.5 Task 9, Review Focus 2).
--   * The line tables of the comprobante and of the plantilla inherit their parent's read right (kernel.typed_lines, 0044): a
--     comprobante narrowed out of a user hides its lines with it. The masters' and entries' own tables got the policy in 0044.
--   * D11 (ruling of 2026-11-02: every aggregate): the figures keep the amounts of the records a user cannot read, so accounting
--     totals never depend on who looks. They are read through the security-definer sources below, which answer only for the caller's
--     active company (kernel.current_company_id, within kernel.current_company_ids) and return aggregates only, grouped by the keys
--     the reports need. They never return the code, the name or the id of an account or a dimension node the caller cannot read, nor
--     any line of a hidden comprobante (review I6, M2): such a node is a `restricted` row with no identity, which the report folds
--     into the lock line. Detail rows (journal book, aging detail, auxiliary books) keep reading the RLS tables, so they drop the
--     narrowed records.
--   * The account permissions of §5.13 (accounting.can_view_account) still leave a restricted account out of the figures where they
--     did before; these sources only stop the record rules (kernel.record_access) from changing a total.

select kernel.typed_lines('accounting', 'entry_lines',          'accounting.entry',          'entry_id');
select kernel.typed_lines('accounting', 'entry_template_lines', 'accounting.entry_template', 'template_id');

-- The caller's active company when it is one of the companies of their claims; null otherwise (every source then answers nothing).
create or replace function accounting.figure_company() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select c from (select kernel.current_company_id() as c) x where array[x.c] <@ kernel.current_company_ids();
$$;
revoke execute on function accounting.figure_company() from public, anon;
grant execute on function accounting.figure_company() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The balances of the trial balance, ledger, balance sheet and income statement (reports/common.ts balanceRows): posted lines dated
-- up to p_to, grouped by the account node at p_level (the account code's first p_level digits, the whole code when shorter) and,
-- when p_by_cost_center, by cost center. opening_net is what precedes p_from; debit and credit the movement from p_from on, the
-- opening and year-close comprobantes counted only when asked. A node the caller cannot read (a record rule, or the account
-- permissions of §5.13) comes back restricted: no id, no code, no name; its nature and section stay, so the report classifies it.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.ledger_sums(
  p_from date, p_to date, p_level int, p_by_cost_center boolean,
  p_cost_center uuid, p_open_auxiliary uuid, p_item uuid, p_business_unit uuid, p_party uuid,
  p_include_opening boolean, p_include_closing boolean
)
returns table (
  node_id uuid, node_code text, name text, nature text, statement_section text, restricted boolean,
  cost_center_id uuid, opening_net numeric, debit numeric, credit numeric
)
language sql stable security definer
set search_path = ''
as $$
  with company as (select accounting.figure_company() as id),
  hidden as (select kernel.record_access_hidden('accounting.account') as ids),
  src as (
    select case when length(a.code) >= p_level then left(a.code, p_level) else a.code end as node_code,
           case when p_by_cost_center then l.cost_center_id end as cost_center_id,
           l.debit, l.credit, e.date, e.is_opening, e.is_closing
    from company c
    join accounting.entry_lines l on l.company_id = c.id
    join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    where e.status in ('posted', 'reversed') and (p_to is null or e.date <= p_to)
      and (p_cost_center is null or l.cost_center_id = p_cost_center)
      and (p_open_auxiliary is null or l.open_auxiliary_id = p_open_auxiliary)
      and (p_item is null or l.item_id = p_item)
      and (p_business_unit is null or l.business_unit_id = p_business_unit)
      and (p_party is null or l.party_id = p_party)
  ),
  agg as (
    select node_code, cost_center_id,
           sum(debit - credit) filter (where date < p_from) as opening_net,
           sum(debit) filter (where date >= p_from and (p_include_opening or not is_opening) and (p_include_closing or not is_closing)) as debit,
           sum(credit) filter (where date >= p_from and (p_include_opening or not is_opening) and (p_include_closing or not is_closing)) as credit
    from src group by node_code, cost_center_id
  ),
  nodes as (
    select agg.*, k.id as account_id, k.name as account_name, k.nature as account_nature, k.statement_section as section,
           k.id is not null and (k.id = any ((select ids from hidden)::uuid[]) or not accounting.can_view_account(k.id)) as is_restricted
    from agg
    left join accounting.accounts k on k.company_id = (select id from company) and k.code = agg.node_code
  )
  select case when is_restricted then null else account_id end,
         case when is_restricted then null else node_code end,
         case when is_restricted then null else account_name end,
         account_nature, section, is_restricted, cost_center_id, opening_net, debit, credit
  from nodes
  order by node_code, cost_center_id;
$$;
revoke execute on function accounting.ledger_sums(date, date, int, boolean, uuid, uuid, uuid, uuid, uuid, boolean, boolean) from public, anon;
grant execute on function accounting.ledger_sums(date, date, int, boolean, uuid, uuid, uuid, uuid, uuid, boolean, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The structure of a master's tree, every node of the active company: id, parent and whether the caller may read it. No code, no
-- name (they come from the RLS views for the readable nodes). Accounts the account permissions hide (§5.13) are left out, as in
-- every figure; a node a record rule hides is in, unreadable, so groups add up the whole tree (D11, review I7).
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.master_tree(p_kind text)
returns table (id uuid, parent_id uuid, readable boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := accounting.figure_company();
  v_table text := case p_kind when 'account' then 'accounts' when 'cost_center' then 'cost_centers' when 'open_auxiliary' then 'open_auxiliaries'
                              when 'item' then 'items' when 'business_unit' then 'business_units' end;
begin
  if v_table is null then raise exception 'master_tree: unknown kind %', p_kind using errcode = '22023'; end if;
  if v_company is null then return; end if;
  return query execute format(
    'with h as (select kernel.record_access_hidden($2) as ids)
     select t.id, t.parent_id, t.id <> all (h.ids) from accounting.%I t cross join h
     where t.company_id = $1 and (%L <> ''account'' or accounting.can_view_account(t.id))', v_table, p_kind)
  using v_company, 'accounting.' || p_kind;
end;
$$;
revoke execute on function accounting.master_tree(text) from public, anon;
grant execute on function accounting.master_tree(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- v_account_balances, new version: the same rows and columns as 0033 (posted and reversed lines per period, account, party and
-- the four dimensions), plus the account's statement section, now evaluated as the view's owner with the tenant predicates written
-- out, so a record rule never takes a comprobante's amounts out of a figure (D11, review I1). The account permissions of §5.13 still
-- apply. It is an aggregate: the ids of a hidden account or party may appear in a row, never their code, name or lines.
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_account_balances with (security_invoker = false) as
select
  l.company_id,
  e.period_id,
  l.account_id,
  l.party_id,
  l.cost_center_id,
  l.open_auxiliary_id,
  l.item_id,
  l.business_unit_id,
  sum(l.debit)  as debit,
  sum(l.credit) as credit,
  e.is_opening,
  e.is_closing,
  a.statement_section
from accounting.entry_lines l
join accounting.entries e on e.id = l.entry_id
join accounting.accounts a on a.id = l.account_id
where l.company_id = (select accounting.figure_company())
  and e.status in ('posted', 'reversed') and accounting.can_view_account(l.account_id)
group by l.company_id, e.period_id, l.account_id, l.party_id, l.cost_center_id, l.open_auxiliary_id, l.item_id, l.business_unit_id, e.is_opening, e.is_closing,
         a.statement_section;
revoke all on accounting.v_account_balances from anon;
grant select on accounting.v_account_balances to authenticated;

-- ---------------------------------------------------------------------------------------------
-- accounting.period_figure, new version (0036): the same figure, now security definer over the whole tree and every posted line of
-- the active company, so the Tabla's figure does not depend on the record rules (D11). Null when the caller may not read the node
-- (a record rule, or the account permissions for an account) or the period is not the company's.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.period_figure(p_kind text, p_node_id uuid, p_period_id uuid) returns numeric
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := accounting.figure_company();
  v_starts date;
  v_nature text;
  v_total numeric;
  v_table text;
  v_column text;
  v_sections constant text[] := array['revenue', 'cost_of_sales', 'operating_expenses', 'other_income', 'other_expenses', 'income_tax'];
begin
  if p_period_id is null or p_node_id is null or v_company is null then return null; end if;
  select starts_on into v_starts from accounting.periods where id = p_period_id and company_id = v_company;
  if v_starts is null then return null; end if;
  -- The node must be one the caller may read.
  if p_node_id = any (kernel.record_access_hidden('accounting.' || p_kind)) then return null; end if;

  if p_kind = 'account' then
    select nature into v_nature from accounting.accounts where id = p_node_id and company_id = v_company and accounting.can_view_account(id);
    if v_nature is null then return null; end if;
    -- Every posted line up to the end of the period, debit minus credit, over the account and its descendants the account
    -- permissions let the caller view (§5.13), whatever the record rules hide.
    with recursive below as (
      select id from accounting.accounts where id = p_node_id
      union
      select a.id from accounting.accounts a join below b on a.parent_id = b.id where accounting.can_view_account(a.id)
    )
    select coalesce(sum(l.debit - l.credit), 0) into v_total
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id
    join accounting.periods p on p.id = e.period_id
    where l.company_id = v_company and e.status in ('posted', 'reversed') and p.starts_on <= v_starts and l.account_id in (select id from below);
    return round(case when v_nature = 'credit' then -v_total else v_total end, 2);
  end if;

  v_table := case p_kind when 'cost_center' then 'cost_centers' when 'open_auxiliary' then 'open_auxiliaries' when 'item' then 'items' when 'business_unit' then 'business_units' end;
  v_column := case p_kind when 'cost_center' then 'cost_center_id' when 'open_auxiliary' then 'open_auxiliary_id' when 'item' then 'item_id' when 'business_unit' then 'business_unit_id' end;
  if v_table is null then raise exception 'period_figure: unknown kind %', p_kind; end if;
  execute format('select 1 from accounting.%I where id = $1 and company_id = $2', v_table) into v_total using p_node_id, v_company;
  if v_total is null then return null; end if;
  -- The result of a cost center: what the income sections credit less what they debit (an expense subtracts); the net movement
  -- (debit minus credit) of the other dimensions. Opening and year-close comprobantes are left out.
  execute format($q$
    with recursive below as (
      select id from accounting.%1$I where id = $1
      union
      select t.id from accounting.%1$I t join below b on t.parent_id = b.id
    )
    select coalesce(sum(case when $4 = 'cost_center' then l.credit - l.debit else l.debit - l.credit end), 0)
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    where l.company_id = $2 and e.period_id = $3 and e.status in ('posted', 'reversed') and not e.is_opening and not e.is_closing
      and accounting.can_view_account(l.account_id) and l.%2$I in (select id from below)
      and ($4 <> 'cost_center' or a.statement_section = any ($5))$q$, v_table, v_column)
    into v_total using p_node_id, v_company, p_period_id, p_kind, v_sections;
  return round(v_total, 2);
end;
$$;
revoke execute on function accounting.period_figure(text, uuid, uuid) from public, anon;
grant execute on function accounting.period_figure(text, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Resultados por centro de costo (reports/cost-center-statement.ts): posted lines of the income-statement sections between the two
-- dates, opening and year-close left out, per cost center (null: no cost center) and section.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.cost_center_sums(p_from date, p_to date, p_sections text[])
returns table (cost_center_id uuid, statement_section text, debit numeric, credit numeric)
language sql stable security definer
set search_path = ''
as $$
  select l.cost_center_id, a.statement_section, sum(l.debit), sum(l.credit)
  from accounting.entry_lines l
  join accounting.entries e on e.id = l.entry_id
  join accounting.accounts a on a.id = l.account_id
  where l.company_id = accounting.figure_company() and e.status in ('posted', 'reversed') and not e.is_opening and not e.is_closing
    and e.date between p_from and p_to and a.statement_section = any (p_sections)
  group by l.cost_center_id, a.statement_section;
$$;
revoke execute on function accounting.cost_center_sums(date, date, text[]) from public, anon;
grant execute on function accounting.cost_center_sums(date, date, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The control reconciliation (reports/control-reconciliation.ts, used by the period close checks). Aggregates per account and
-- party, per account, or one total: the comparison and the close checks see every comprobante whoever runs them. A row whose
-- account or party the caller may not read comes back restricted, with no id or code.
-- ---------------------------------------------------------------------------------------------
-- Receivable and payable: the ledger balance per account and party against the open items (accounting.open_items, read here as the
-- owner, so over every line).
create or replace function accounting.control_party_balances(p_as_of date)
returns table (is_receivable boolean, account_id uuid, code text, party_id uuid, restricted boolean, balance numeric, open numeric)
language sql stable security definer
set search_path = ''
as $$
  with company as (select accounting.figure_company() as id),
  groups as (
    select distinct left(a.code, 2) as grp, (m.role = 'receivable' or m.role like '%\_receivable') as is_receivable
    from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = (select id from company)
      and (m.role = 'receivable' or m.role like '%\_receivable' or m.role = 'payable' or m.role like '%\_payable')
  ),
  ledger as (
    select l.account_id, a.code, l.party_id, g.is_receivable,
           sum(case when g.is_receivable then l.debit - l.credit else l.credit - l.debit end) as balance
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    join groups g on g.grp = left(a.code, 2)
    where l.company_id = (select id from company) and a.requires_party and l.party_id is not null
      and e.status = 'posted' and e.date <= p_as_of and accounting.can_view_account(l.account_id)
    group by l.account_id, a.code, l.party_id, g.is_receivable
  ),
  opened as (
    select o.account_id, o.party_id, sum(o.open) as open
    from accounting.open_items((select id from company), p_as_of) o group by o.account_id, o.party_id
  ),
  marked as (
    select l.*, coalesce(o.open, 0) as open_amount,
           l.account_id = any (kernel.record_access_hidden('accounting.account')) as account_hidden,
           l.party_id = any (kernel.record_access_hidden('core.party')) as party_hidden
    from ledger l left join opened o on o.account_id = l.account_id and o.party_id = l.party_id
  )
  select is_receivable,
         case when account_hidden then null else account_id end,
         case when account_hidden then null else code end,
         case when account_hidden or party_hidden then null else party_id end,
         account_hidden or party_hidden, balance, open_amount
  from marked
  order by code nulls last, party_id;
$$;
revoke execute on function accounting.control_party_balances(date) from public, anon;
grant execute on function accounting.control_party_balances(date) to authenticated, service_role;

-- The ledger balance of the accounts in the groups (first two digits) of the accounts mapped to p_role (inventory).
create or replace function accounting.control_role_group_balance(p_as_of date, p_role text) returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0)
  from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
  where l.company_id = accounting.figure_company() and e.status = 'posted' and e.date <= p_as_of and accounting.can_view_account(l.account_id)
    and left(a.code, 2) in (select left(a2.code, 2) from accounting.account_role_mappings m join accounting.accounts a2 on a2.id = m.account_id
                            where m.company_id = accounting.figure_company() and m.role = p_role);
$$;
revoke execute on function accounting.control_role_group_balance(date, text) from public, anon;
grant execute on function accounting.control_role_group_balance(date, text) to authenticated, service_role;

-- The account mapped to p_role (no dimension) and its descendants by code: the net balance of each one that holds one (suspense).
create or replace function accounting.control_role_account_balances(p_as_of date, p_role text)
returns table (account_id uuid, code text, name text, restricted boolean, balance numeric)
language sql stable security definer
set search_path = ''
as $$
  with root as (
    select a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = accounting.figure_company() and m.role = p_role and m.dimension is null
  ),
  sums as (
    select a.id, a.code, a.name, sum(l.debit - l.credit) as balance, a.id = any (kernel.record_access_hidden('accounting.account')) as hidden
    from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
    where l.company_id = accounting.figure_company() and e.status = 'posted' and e.date <= p_as_of
      and a.code like (select code from root) || '%' and accounting.can_view_account(l.account_id)
    group by a.id, a.code, a.name having sum(l.debit - l.credit) <> 0
  )
  select case when hidden then null else id end, case when hidden then null else code end, case when hidden then null else name end, hidden, balance
  from sums order by sums.code;
$$;
revoke execute on function accounting.control_role_account_balances(date, text) from public, anon;
grant execute on function accounting.control_role_account_balances(date, text) to authenticated, service_role;

-- The lines posted to the account mapped to p_role (rounding) between the two dates: how many, their net, and how many exceed the
-- tolerance in a comprobante the caller may not read (the visible ones are listed by the report from the RLS tables).
create or replace function accounting.control_role_lines(p_from date, p_to date, p_role text, p_tolerance numeric)
returns table (lines int, net numeric, hidden_oversized int)
language sql stable security definer
set search_path = ''
as $$
  select count(*)::int, coalesce(sum(l.debit - l.credit), 0),
         (count(*) filter (where greatest(l.debit, l.credit) > p_tolerance and l.entry_id = any (kernel.record_access_hidden('accounting.entry'))))::int
  from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
  where l.company_id = accounting.figure_company() and e.status = 'posted' and e.date between p_from and p_to
    and accounting.can_view_account(l.account_id)
    and l.account_id = (select m.account_id from accounting.account_role_mappings m
                        where m.company_id = accounting.figure_company() and m.role = p_role and m.dimension is null);
$$;
revoke execute on function accounting.control_role_lines(date, date, text, numeric) from public, anon;
grant execute on function accounting.control_role_lines(date, date, text, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Información exógena (reports/exogena.ts). The mapped accounts (descendants included, the longest mapping wins) per concept and
-- party of one format and year; what blocks the file. Each source is an aggregate: a line with no party is listed by comprobante
-- number and line only when the caller may read the comprobante, otherwise only counted.
-- ---------------------------------------------------------------------------------------------
-- p_side 'balance': the balance at p_to in the account's own direction, opening and year close included. 'debit' / 'credit': the
-- movement between the two dates on that side (the opposite side only for reversals and credit notes), opening and year close left
-- out, with the tax base of the lines that carry one; a line with no party takes the comprobante's single party, if any.
-- Rows with party_id: the sums. Rows without: a line with no party (entry, line_no, code), or `hidden_lines` such lines of
-- comprobantes the caller may not read.
create or replace function accounting.exogena_cells(p_format text, p_from date, p_to date, p_side text)
returns table (concept text, party_id uuid, amount numeric, base numeric, has_base boolean, entry text, line_no int, code text, hidden_lines int)
language sql stable security definer
set search_path = ''
as $$
  with company as (select accounting.figure_company() as id),
  mapped as (
    select m.concept, a.code as mcode from accounting.fiscal_concept_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = (select id from company) and m.format = p_format and m.is_active
  ),
  raw as (
    select distinct on (l.id) mp.concept, l.party_id, l.entry_id, e.number as entry, l.line_no, a.code, l.debit, l.credit, l.tax_base,
           a.nature, (e.reversal_of_id is not null or e.source_entity = 'invoicing.note') as contra
    from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
    join mapped mp on a.code like mp.mcode || '%'
    where l.company_id = (select id from company) and e.status = 'posted' and accounting.can_view_account(l.account_id)
      and case when p_side = 'balance' then e.date <= p_to
               else e.date between p_from and p_to and not e.is_opening and not e.is_closing end
    order by l.id, length(mp.mcode) desc
  ),
  fallback as (
    select l.entry_id, (array_agg(distinct l.party_id))[1] as party from accounting.entry_lines l
    where p_side <> 'balance' and l.entry_id in (select entry_id from raw) and l.party_id is not null
    group by l.entry_id having count(distinct l.party_id) = 1
  ),
  calc as (
    select r.concept, case when p_side = 'balance' then r.party_id else coalesce(r.party_id, f.party) end as party_id,
           r.entry_id, r.entry, r.line_no, r.code, r.tax_base,
           case p_side when 'debit' then r.debit when 'credit' then r.credit end as own,
           case when p_side = 'balance' then case when r.nature = 'debit' then r.debit - r.credit else r.credit - r.debit end
                else case p_side when 'debit' then r.debit else r.credit end
                     - case when r.contra then case p_side when 'debit' then r.credit else r.debit end else 0 end end as amount
    from raw r left join fallback f on f.entry_id = r.entry_id
  ),
  -- A movement line on the other side that is not a reversal or a credit note adds nothing: it needs no party either.
  kept as (
    select c.*, c.entry_id = any (kernel.record_access_hidden('accounting.entry')) as hidden
    from calc c where p_side = 'balance' or not (c.amount = 0 and not (c.tax_base is not null and c.own > 0))
  )
  select k.concept, k.party_id, sum(k.amount), sum(k.tax_base) filter (where k.tax_base is not null and k.own > 0),
         coalesce(bool_or(k.tax_base is not null and k.own > 0), false), null::text, null::int, null::text, 0
  from kept k where k.party_id is not null group by k.concept, k.party_id
  union all
  select k.concept, null, null, null, false, k.entry, k.line_no, k.code, 0 from kept k where k.party_id is null and not k.hidden
  union all
  select null, null, null, null, false, null, null, null, count(*)::int from kept k where k.party_id is null and k.hidden having count(*) > 0;
$$;
revoke execute on function accounting.exogena_cells(text, date, date, text) from public, anon;
grant execute on function accounting.exogena_cells(text, date, date, text) to authenticated, service_role;

-- Withholdings practised or suffered per party and tax family (the tax code's first part) between the two dates.
create or replace function accounting.exogena_tax_sums(p_from date, p_to date)
returns table (party_id uuid, family text, amount numeric)
language sql stable security definer
set search_path = ''
as $$
  select l.party_id, split_part(l.tax_code, '_', 1), sum(l.credit - l.debit)
  from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
  where l.company_id = accounting.figure_company() and l.tax_code is not null and l.party_id is not null
    and e.status in ('posted', 'reversed') and e.date between p_from and p_to and accounting.can_view_account(l.account_id)
  group by l.party_id, split_part(l.tax_code, '_', 1);
$$;
revoke execute on function accounting.exogena_tax_sums(date, date) from public, anon;
grant execute on function accounting.exogena_tax_sums(date, date) to authenticated, service_role;

-- The accounts with movement on p_side between the two dates in a result section the format's mapping covers (a section of a mapped
-- account outside p_balance_sheet) that no mapping covers. An account the caller may not read comes back restricted, unnamed.
create or replace function accounting.exogena_unmapped(p_format text, p_from date, p_to date, p_side text, p_balance_sheet text[])
returns table (code text, name text, restricted boolean, movement numeric)
language sql stable security definer
set search_path = ''
as $$
  with company as (select accounting.figure_company() as id),
  mapping as (
    select a.code, a.statement_section from accounting.fiscal_concept_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = (select id from company) and m.format = p_format and m.is_active
  ),
  sections as (select distinct statement_section from mapping where statement_section is not null and statement_section <> all (p_balance_sheet)),
  moved as (
    select a.id, a.code, a.name, sum(case p_side when 'debit' then l.debit else l.credit end) as movement
    from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
    where l.company_id = (select id from company) and e.status = 'posted' and e.date between p_from and p_to
      and not e.is_opening and not e.is_closing and accounting.can_view_account(a.id)
      and a.statement_section in (select statement_section from sections)
      and not exists (select 1 from mapping mp where a.code like mp.code || '%')
    group by a.id, a.code, a.name having sum(case p_side when 'debit' then l.debit else l.credit end) > 0
  )
  select case when hidden then null else m.code end, case when hidden then null else m.name end, hidden, m.movement
  from (select moved.*, moved.id = any (kernel.record_access_hidden('accounting.account')) as hidden from moved) m
  order by m.code;
$$;
revoke execute on function accounting.exogena_unmapped(text, date, date, text, text[]) from public, anon;
grant execute on function accounting.exogena_unmapped(text, date, date, text, text[]) to authenticated, service_role;
