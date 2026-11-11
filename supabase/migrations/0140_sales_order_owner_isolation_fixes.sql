-- 0140_sales_order_owner_isolation_fixes
-- Forward-only migration (rule 34; 0139 is applied and is not edited). Covered by packages/modules/sales/src/__tests__/order-owner.integration.test.ts
-- and packages/modules/invoicing/src/__tests__/order-owner.integration.test.ts. Review fix round 1 of plan 2B.2 Task 39:
--   * I-1: the approver of a pedido that needs approval reads it, as the cotizaciones of 0083 do: a pedido with requires_approval is visible to
--     whoever may run sales.order.approve or sales.order.reject (the kernel's lifecycle verbs of the pedido), so a credit or discount approver
--     who does not hold sales.order.reassign can open, approve and reject it. requires_approval stays true after the decision, so the row the
--     approval writes is still readable by them (an UPDATE's new row must pass the read policy). The lines follow their pedido (0139).
--   * M-3: sales.lock_orders_for_invoice (0094, definer) locks and answers only the pedidos the caller may read under the same rule, so
--     «Emitir» of a Borrador that bills another salesperson's pedido neither names its number or stage nor locks it. A consumer (system user
--     with the company's admin role) passes through kernel.can_run_process as before.

drop policy owner_scope on sales.orders;
create policy owner_scope on sales.orders as restrictive for select to authenticated
  using (
    owner_id = (select kernel.current_user_id())
    or (select kernel.can_run_process('sales.order.reassign'))
    or (requires_approval and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))
  );

-- Body as in 0094, with the owner rule of owner_scope in the where clause (a definer reads past RLS, so the rule is repeated here).
create or replace function sales.lock_orders_for_invoice(p_orders uuid[])
returns table (id uuid, number text, status text, stage text, party_id uuid, currency text, exchange_rate numeric)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_user uuid := kernel.current_user_id();
  v_all boolean := kernel.can_run_process('sales.order.reassign');
  v_approver boolean := kernel.can_run_process('sales.order.approve') or kernel.can_run_process('sales.order.reject');
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'invoicing.%' then
    raise exception 'sales.lock_orders_for_invoice is called only inside an invoicing process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select o.id, o.number, o.status, o.stage, o.party_id, o.currency, o.exchange_rate
    from sales.orders o
    where o.company_id = v_company and o.id = any (p_orders)
      and (v_all or o.owner_id = v_user or (o.requires_approval and v_approver))
    order by o.id
    for share;
end;
$$;
revoke execute on function sales.lock_orders_for_invoice(uuid[]) from public, anon;
grant execute on function sales.lock_orders_for_invoice(uuid[]) to authenticated, service_role;
