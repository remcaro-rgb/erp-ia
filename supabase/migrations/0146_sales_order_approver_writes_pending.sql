-- 0146_sales_order_approver_writes_pending
-- Forward-only migration (rule 34; 0139 and 0140 are applied and are not edited). Covered by
-- packages/modules/sales/src/__tests__/order-owner.integration.test.ts. Owner item 119(b) (F-4.6), decided 2026-11-09 as recommended:
-- the approver branch of owner_scope (0140, item 98) opened every kind of access on each pedido that ever required approval, because a
-- FOR UPDATE / DELETE target row must pass the read policy. Reads stay as they are (the approver still opens the pedido after deciding it);
-- the write side is narrowed: whoever approves or rejects pedidos writes (cancel, void, deliver ...) only a pedido that is still pending
-- approval (status 'pending'), besides the owner and who may run sales.order.reassign. The row an UPDATE leaves (WITH CHECK) keeps the read
-- rule, so approving or rejecting a pending pedido (it stops being pending) still passes. The lines follow their pedido.

drop policy if exists owner_scope_write on sales.orders;
create policy owner_scope_write on sales.orders as restrictive for update to authenticated
  using (
    owner_id = (select kernel.current_user_id())
    or (select kernel.can_run_process('sales.order.reassign'))
    or (requires_approval and status = 'pending' and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))
  )
  with check (
    owner_id = (select kernel.current_user_id())
    or (select kernel.can_run_process('sales.order.reassign'))
    or (requires_approval and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))
  );

drop policy if exists owner_scope_delete on sales.orders;
create policy owner_scope_delete on sales.orders as restrictive for delete to authenticated
  using (
    owner_id = (select kernel.current_user_id())
    or (select kernel.can_run_process('sales.order.reassign'))
    or (requires_approval and status = 'pending' and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))
  );

drop policy if exists owner_scope_write on sales.order_lines;
create policy owner_scope_write on sales.order_lines as restrictive for update to authenticated
  using (exists (
    select 1 from sales.orders o where o.id = order_id and (
      o.owner_id = (select kernel.current_user_id())
      or (select kernel.can_run_process('sales.order.reassign'))
      or (o.requires_approval and o.status = 'pending' and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))
    )))
  with check (exists (select 1 from sales.orders o where o.id = order_id));

drop policy if exists owner_scope_delete on sales.order_lines;
create policy owner_scope_delete on sales.order_lines as restrictive for delete to authenticated
  using (exists (
    select 1 from sales.orders o where o.id = order_id and (
      o.owner_id = (select kernel.current_user_id())
      or (select kernel.can_run_process('sales.order.reassign'))
      or (o.requires_approval and o.status = 'pending' and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))
    )));
