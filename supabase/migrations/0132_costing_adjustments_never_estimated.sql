-- Plan 2B.2 Task 44, fix round 2 (re-review N1, N3). Forward-only (0130 and 0131 are applied).

-- N1: inventory posts an adjustment's ledger entry at qty x the line cost it sets from costing.average_costs(), and nothing when it has none.
-- Hiding an estimated layer's average (0131) made inventory post 0 while costing moved the layer at an estimate, so the subledger stopped
-- matching the ledger. The function is restored to its 0075 body: inventory keeps valuing the adjustment at the layer's average, and costing
-- flags an adjustment valued at an estimated average (an adjustment is never estimated by costing itself).
create or replace function costing.average_costs(p_warehouse uuid, p_ids uuid[]) returns table (product_id uuid, avg_cost numeric)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'inventory.%'
     and coalesce(current_setting('erp.audit_process_id', true), '') not like 'costing.%' then
    raise exception 'costing.average_costs is read only inside an inventory or costing process' using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.product_id, a.avg_cost
    from (
      select l.product_id,
             case when l.qty > 0 then round(greatest(l.value / l.qty, 0), 4) else l.avg_cost end as avg_cost
      from costing.cost_layers l
      where l.company_id = kernel.current_company_id()
        and array[l.company_id] <@ kernel.current_company_ids()
        and l.method = 'average'
        and l.warehouse_id = p_warehouse
        and l.product_id = any (p_ids)
        and not exists (select 1 from kernel.company_modules cm
                        where cm.company_id = l.company_id and cm.module_id = 'costing' and not cm.enabled)
    ) a
    where a.avg_cost is not null and a.avg_cost > 0;
end;
$$;
revoke execute on function costing.average_costs(uuid, uuid[]) from public, anon;
grant execute on function costing.average_costs(uuid, uuid[]) to authenticated, service_role;

-- N3: the reversal check of the last-known-cost lookup (a cost event reversed by a void is not a source).
create index if not exists cost_events_reversal_idx on costing.cost_events (company_id, source_line_id) where kind = 'reversal';
