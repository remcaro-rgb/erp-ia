-- Plan 2B.2 Task 44, fix round 1 (review C1, I1, M1, M2; owner item 76). Covered by unknown-cost.integration.test.ts and entities.test.ts.
-- Forward-only (0130 is applied).

-- C1: an open cost_missing row that took an estimate (cost_source last_known). While it is open the layer's average is made of estimates, so
-- a line valued at that average is an estimate too, never a real cost. The row closes only through a real cost (resolveMissing) or the void
-- of its last occurrence (undoMissing), and the marker goes with it.
alter table costing.cost_missing add column if not exists estimated boolean not null default false;

-- Its masked view, regenerated from the entity (a column in the middle cannot be added by create or replace view).
drop view costing.v_cost_missing;
create or replace view costing.v_cost_missing with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.cost_missing', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.cost_missing', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('costing.cost_missing', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('costing.cost_missing', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('costing.cost_missing', 'occurrences')) then "occurrences" else null end as "occurrences",
  case when (select kernel.field_visible('costing.cost_missing', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('costing.cost_missing', 'first_movement_id')) then "first_movement_id" else null end as "first_movement_id",
  case when (select kernel.field_visible('costing.cost_missing', 'last_movement_id')) then "last_movement_id" else null end as "last_movement_id",
  case when (select kernel.field_visible('costing.cost_missing', 'first_date')) then "first_date" else null end as "first_date",
  case when (select kernel.field_visible('costing.cost_missing', 'last_date')) then "last_date" else null end as "last_date",
  case when (select kernel.field_visible('costing.cost_missing', 'resolved_at')) then "resolved_at" else null end as "resolved_at",
  case when (select kernel.field_visible('costing.cost_missing', 'resolved_movement_id')) then "resolved_movement_id" else null end as "resolved_movement_id",
  case when (select kernel.field_visible('costing.cost_missing', 'estimated')) then "estimated" else null end as "estimated",
  case when (select kernel.field_visible('costing.cost_missing', 'extra')) then kernel.mask_extra('costing.cost_missing', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.cost_missing', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.cost_missing;
grant select on costing.v_cost_missing to authenticated;

-- I1: inventory values an adjustment at the average costing publishes; an average made of estimates is not a user's cost, so none is published
-- while the product's open row in the bodega is estimated (inventory then falls back to the standard cost, or nothing).
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
        and not exists (select 1 from costing.cost_missing m
                        where m.company_id = l.company_id and m.product_id = l.product_id and m.warehouse_id = l.warehouse_id
                          and m.status = 'open' and m.estimated)
    ) a
    where a.avg_cost is not null and a.avg_cost > 0;
end;
$$;
revoke execute on function costing.average_costs(uuid, uuid[]) from public, anon;
grant execute on function costing.average_costs(uuid, uuid[]) to authenticated, service_role;

-- M2: the last-known-cost lookup (newest real event of a product, any bodega).
create index if not exists cost_events_last_known_idx on costing.cost_events (company_id, product_id, movement_seq desc) where unit_cost > 0 and not cost_missing;
