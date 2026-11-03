-- 0054_accounting_period_figure_fast
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/master-figures.integration.test.ts and
-- record-access.integration.test.ts (the figure and its account permissions are unchanged).
--
-- accounting.period_figure (0046) asked accounting.can_view_account of every descendant of the node, and with any restricted account in
-- the company each call walks the ancestor chain: the Tabla of the Plan de cuentas, whose footer sums the figure over every row, took
-- minutes and the grid never left "Cargando…". The walk now asks only at a restricted account (the one place the answer can change):
-- an open account hangs from a viewable parent, so it is viewable too, and a restricted one the caller may not view cuts its whole
-- subtree. The figure is the same.

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
      select a.id from accounting.accounts a join below b on a.parent_id = b.id where a.access <> 'restricted' or accounting.can_view_account(a.id)
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
