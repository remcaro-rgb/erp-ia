-- master_tree (0057) with its two one-row CTEs materialized (2026-11-04). Left inlined, Postgres pulled
-- accounting.hidden_account_ids() into the join and called it once per node instead of once per statement, which made the tree
-- slower than before. Same signature, same rows.

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
    'with h as materialized (select kernel.record_access_hidden($2) as ids),
          v as materialized (select case when %L = ''account'' then accounting.hidden_account_ids() else ''{}''::uuid[] end as ids)
     select t.id, t.parent_id, t.id <> all (h.ids) from accounting.%I t cross join h cross join v
     where t.company_id = $1 and t.id <> all (v.ids)', p_kind, v_table)
  using v_company, 'accounting.' || p_kind;
end;
$fn$;
