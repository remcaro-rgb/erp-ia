-- 0086_costing_voids
-- Forward-only migration (rule 34). Covered by packages/modules/costing/src/__tests__/void.integration.test.ts and
-- packages/modules/sales/src/__tests__/delivery.integration.test.ts.
-- Plan 2B Task 14 (the voids carried from the reviews of Tasks 6–9): costing consumes inventory.movement.voided and takes the movement's
-- cost back out of (or into) its layers with opposite cost events, never deleting one:
--   * cost events of kind `reversal` (cost source `reversal`): the signed opposite of one cost event of the voided movement (its qty and its
--     amount exactly, at its unit cost), so a layer's value stays the sum of its events' amounts (0075's rule). Like a landed cost's event it
--     has no movement line of its own: movement_line_id is a fresh id and source_line_id names the movement line it reverses;
--   * the cost of sales of a sale return (costing.cogs.returned: Dr inventory / Cr cogs, the returned units at the original issue's cost) is
--     sent once like a sale issue's, so cogs_posted_at may now be set on a sale_return event too;
--   * costing.movement_landed_costs(): the landed costs still allocated to a receipt, published for inventory, whose Anular of a receipt
--     refuses while any is active (the landed cost is voided first: its own reversal posts, inline and strict).

alter table costing.cost_events drop constraint cost_events_kind_check;
alter table costing.cost_events add constraint cost_events_kind_check
  check (kind in ('receipt', 'issue', 'sale_issue', 'sale_return', 'adjustment', 'transfer_out', 'transfer_in', 'landed_cost', 'reversal'));
alter table costing.cost_events drop constraint cost_events_cost_source_check;
alter table costing.cost_events add constraint cost_events_cost_source_check
  check (cost_source in ('line', 'average', 'standard', 'original_issue', 'transfer', 'none', 'landed_cost', 'reversal'));
alter table costing.cost_events drop constraint cost_events_check1;
alter table costing.cost_events add constraint cost_events_cogs_posted_check check (cogs_posted_at is null or kind in ('sale_issue', 'sale_return'));
create index cost_events_reversal_idx on costing.cost_events (company_id, movement_id) where kind = 'reversal';

-- The numbers of the landed costs still allocated (Contabilizado, not Anulado) to the receipt `p_movement`. Security definer (the caller of
-- inventory.movement.void may not read costing), limited to the active company, answering only inside an inventory or costing process
-- run. A read of a published function, not a write (rule 3); inventory does not declare costing (documented in its manifest).
create or replace function costing.movement_landed_costs(p_movement uuid) returns text[]
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  if not (v_process like 'inventory.%' or v_process like 'costing.%') then
    raise exception 'costing.movement_landed_costs answers only inside an inventory or costing process' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((select array_agg(coalesce(l.number, l.id::text) order by l.seq) from costing.landed_costs l
                   where l.company_id = v_company and l.movement_id = p_movement and l.status = 'posted'), '{}'::text[]);
end;
$$;
revoke execute on function costing.movement_landed_costs(uuid) from public, anon;
grant execute on function costing.movement_landed_costs(uuid) to authenticated, service_role;
comment on function costing.movement_landed_costs(uuid) is
  'Published for inventory (rule 3): the landed costs still allocated to a receipt; its Anular refuses while any is active.';
