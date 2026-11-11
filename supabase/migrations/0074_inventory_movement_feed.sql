-- 0074_inventory_movement_feed
-- Forward-only migration (rule 34). Covered by packages/modules/costing/src/__tests__/average.integration.test.ts (the feed, its guard, the
-- order of delivery, and a sale return's return_of_line_id and its refusal).
-- What inventory publishes for costing (plan 2B Task 8, rule 3):
--   * movement_lines.return_of_line_id: a sale return line names the sale issue line it returns (inventory.movement.post resolves it from
--     the source line the caller names, the delivery line), so the returned units re-enter at the original issue's cost.
--   * inventory.movement_feed(after, until): the movement lines of the caller's company with seq in (after, seq of `until`], in seq order.
--     A movement's seq is gap-free and drawn under a lock held until its transaction ends, so once a movement is committed every movement
--     with a lower seq is committed too: costing values them in this order whatever order their events arrive in. Unmasked (a valuation
--     is a computation, not a display: the caller's field visibility never changes a cost), it answers only inside a costing process run.

alter table inventory.movement_lines add column return_of_line_id uuid references inventory.movement_lines (id);
create index movement_lines_return_of_idx on inventory.movement_lines (return_of_line_id) where return_of_line_id is not null;

create or replace function inventory.movement_feed(p_after bigint, p_until uuid)
returns table (
  movement_id uuid, seq bigint, number text, kind text, date date, warehouse_id uuid, source_entity text, source_id uuid, status text,
  line_id uuid, line_no integer, product_id uuid, location_id uuid, qty numeric, unit_cost numeric, source_line_id uuid, return_of_line_id uuid
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_until bigint;
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'costing.%' then
    raise exception 'inventory.movement_feed is read only inside a costing process' using errcode = 'insufficient_privilege';
  end if;
  select m.seq into v_until
  from inventory.movements m
  where m.id = p_until and m.company_id = kernel.current_company_id() and array[m.company_id] <@ kernel.current_company_ids() and m.applied_at is not null;
  if v_until is null then
    return;
  end if;
  return query
    select m.id, m.seq, m.number, m.kind, m.date, m.warehouse_id, m.source_entity, m.source_id, m.status,
           l.id, l.line_no, l.product_id, l.location_id, l.qty, l.unit_cost, l.source_line_id, l.return_of_line_id
    from inventory.movements m
    join inventory.movement_lines l on l.movement_id = m.id
    where m.company_id = kernel.current_company_id()
      and m.seq > p_after and m.seq <= v_until
      and m.applied_at is not null
    order by m.seq, l.line_no;
end;
$$;
revoke execute on function inventory.movement_feed(bigint, uuid) from public, anon;
grant execute on function inventory.movement_feed(bigint, uuid) to authenticated, service_role;
