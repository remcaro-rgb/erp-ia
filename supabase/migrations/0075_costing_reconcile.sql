-- 0075_costing_reconcile
-- Forward-only migration (rule 34). Covered by packages/modules/costing/src/__tests__/average.integration.test.ts
-- ("the subledger reconciles", "costing.average_costs follows the module switch") and average.test.ts.
-- Task 8 review (controller ruling, 2026-11-05): the costing subledger reconciles. For every layer, value = Σ signed amounts of its
-- cost events: an entry into a backordered layer (qty < 0) adds its amount to the negative value ((−3, −300) + 10 @ 120 → (7, 900));
-- an exit at a given cost removes exactly that amount, even when it leaves a positive quantity with a negative value. The check
-- "qty <= 0 or value >= 0" of 0073 refused those states, so it goes. avg_cost keeps its "not negative" check: it is the snapshot
-- max(value / qty, 0) for qty > 0, the last average otherwise.
alter table costing.cost_layers drop constraint cost_layers_check;

-- The average inventory reads (inventory.adjustment, rule 35: its manifest documents the read) is derived at read time from the
-- full-precision value and quantity (value / qty, rounded to the unit cost's 4 decimals), not from the stored snapshot; and a
-- company that switched costing off (kernel.company_modules.enabled = false) gets no average, so inventory falls back to the
-- standard cost exactly as when costing is not installed.
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
