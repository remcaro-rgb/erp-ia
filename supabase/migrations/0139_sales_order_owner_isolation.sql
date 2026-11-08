-- 0139_sales_order_owner_isolation
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/order-owner.integration.test.ts (and entities.test.ts
-- for the regenerated entrega view).
-- Order owner isolation (owner item 29, 2026-11-06, design §6 and §22.28, plan 2B.2 Task 39). A salesperson sees the pedidos they own;
-- whoever may run sales.order.reassign (the «all orders» permission, the analogue of crm.opportunity.reassign; a company admin always may)
-- sees every pedido of the company. Unlike the cotizaciones, a pedido without owner is visible only to them (owner order of 2026-11-06).
--   * sales.orders.owner_source: how the owner was set (direct, quote, reassigned, or one of the backfill's guesses). Internal provenance,
--     not in sales.v_orders; the row audit records its changes.
--   * The backfill of the existing pedidos (R39-6): the cotización's owner, else the creator in the row audit (never the system user),
--     else none (visible only to the holders). It runs as the migration owner, so the row audit records origin db; it ends with a notice
--     of the count per source.
--   * sales.is_company_member: sales.order.reassign validates the new owner through this definer helper (a copy of crm's: a module never
--     calls another module's function, rule 3). sales.order_hand_over: sales.order.from_quote gives the pedido to the cotización's owner
--     when the converter will not see it (R39-4); only inside a run of that process.
--   * The restrictive owner_scope read policies on sales.orders and sales.order_lines (a line is visible exactly when its pedido is). A
--     FOR UPDATE lock follows the read policy, so a salesperson who does not own the pedido finds no row to update, confirm, cancel or
--     deliver (not_found).
--   * sales.v_order_owners: the owner of each pedido the caller reads, masked like v_orders, published for the other modules (R39-8).
--   * sales.v_deliveries gains order_owner_id at its end (the pedido's owner, null when the caller cannot read the pedido; entity field
--     sales.delivery.order_owner_id).
--   * The roles of the existing companies that reassign deals, deliver or invoice keep seeing the pedidos they work on (R39-7).

alter table sales.orders add column if not exists owner_source text not null default 'direct'
  constraint orders_owner_source_check check (owner_source in ('direct', 'quote', 'reassigned', 'backfill_quote', 'backfill_audit', 'backfill_none'));
create index if not exists orders_owner_idx on sales.orders (company_id, owner_id);

-- backfill: begin
-- Every existing pedido took owner_id = whoever ran its process (the converter, the creator) and has owner_source 'direct' from the
-- column's default. In this order: the cotización's owner; else the actor of the pedido's insert row in the audit when it is a person; else
-- none. crm's cotización is read through its published view (rule 3; as the migration owner, no RLS applies).
do $$
declare
  v_quote integer;
  v_audit integer;
  v_none integer;
begin
  update sales.orders o set owner_id = q.owner_id, owner_source = 'backfill_quote'
  from crm.v_quote_offers q
  where q.id = o.quote_id and q.company_id = o.company_id and q.owner_id is not null and o.owner_source = 'direct';
  get diagnostics v_quote = row_count;

  with creators as (
    select o.id,
           (select a.actor_user_id from kernel.audit_log a
            where a.row_id = o.id and a.entity = 'sales.orders' and a.action = 'insert'
            order by a.occurred_at limit 1) as actor
    from sales.orders o
    where o.owner_source = 'direct'
  )
  update sales.orders o set owner_id = c.actor, owner_source = 'backfill_audit'
  from creators c
  where c.id = o.id and c.actor is not null and c.actor <> '00000000-0000-0000-0000-000000000000'::uuid;
  get diagnostics v_audit = row_count;

  update sales.orders set owner_id = null, owner_source = 'backfill_none' where owner_source = 'direct';
  get diagnostics v_none = row_count;

  raise notice 'sales.orders owner backfill: % from the cotización, % from the audit, % without owner (visible only to sales.order.reassign)', v_quote, v_audit, v_none;
end;
$$;
-- backfill: end

-- The new owner of sales.order.reassign must be a member of the caller's active company (as crm.is_company_member, 0080).
create or replace function sales.is_company_member(p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from kernel.memberships m
    where m.user_id = p_user
      and m.company_id = kernel.current_company_id()
      and array[m.company_id] <@ kernel.current_company_ids()
  );
$$;
revoke execute on function sales.is_company_member(uuid) from public, anon;
grant execute on function sales.is_company_member(uuid) to authenticated, service_role;

-- R39-4: a converter who sees the cotización (its approver, a crm.opportunity.reassign holder) but neither owns the resulting pedido nor
-- holds sales.order.reassign. The pedido is written as the converter's (so the run can number, link and save it under the caller's RLS)
-- and handed to the cotización's owner as the run's last step: an update the caller's own policies would refuse, since the new row is one
-- they may not read. Only inside a run of sales.order.from_quote, only the converter's own pedido of that cotización, and only to the
-- cotización's owner; the row audit records the owner's diff with the process id.
create or replace function sales.order_hand_over(p_order uuid, p_owner uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') <> 'sales.order.from_quote' then
    raise exception 'a pedido is handed over only inside a process run of sales.order.from_quote' using errcode = 'insufficient_privilege';
  end if;
  update sales.orders o set owner_id = p_owner, owner_source = 'quote'
  where o.id = p_order
    and o.company_id = kernel.current_company_id()
    and array[o.company_id] <@ kernel.current_company_ids()
    and o.owner_id = kernel.current_user_id()
    and o.created_by = kernel.current_user_id()
    and exists (select 1 from crm.v_quote_offers q where q.id = o.quote_id and q.company_id = o.company_id and q.owner_id = p_owner);
  if not found then
    raise exception 'pedido % cannot be handed over to %', p_order, p_owner using errcode = 'insufficient_privilege';
  end if;
end;
$$;
revoke execute on function sales.order_hand_over(uuid, uuid) from public, anon;
grant execute on function sales.order_hand_over(uuid, uuid) to authenticated, service_role;

-- Row isolation (design §6). Insert, update and delete keep their via_process policies (0084).
create policy owner_scope on sales.orders as restrictive for select to authenticated
  using (owner_id = (select kernel.current_user_id()) or (select kernel.can_run_process('sales.order.reassign')));
create policy owner_scope on sales.order_lines as restrictive for select to authenticated
  using (exists (select 1 from sales.orders o where o.id = order_id));

-- Published for other modules (rule 3, R39-8): the owner of each pedido the caller reads (owner_scope applies, security invoker), masked by
-- the pedido's own field visibility (rule 14), so it is no unmasked module view.
create or replace view sales.v_order_owners with (security_invoker = true) as
select o.company_id, o.id as order_id,
       case when (select kernel.field_visible('sales.order', 'owner_id')) then o.owner_id else null end as owner_id
from sales.orders o;
grant select on sales.v_order_owners to authenticated;
comment on view sales.v_order_owners is
  'Published (rule 3): the salesperson of each pedido the caller may read (owner_scope applies, security_invoker), masked by sales.order.owner_id.';

-- The entrega's masked view (as 0134) with order_owner_id appended: the pedido's owner read through sales.v_order_owners as the caller, so
-- it is null when the caller cannot read the pedido or the pedido's owner is masked for them, then masked by the entrega's own field.
-- Generated by maskedViewSql from packages/modules/sales/src/entities.ts (entities.test.ts keeps them in sync).
create or replace view sales.v_deliveries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.delivery', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.delivery', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('sales.delivery', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('sales.delivery', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('sales.delivery', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('sales.delivery', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('sales.delivery', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('sales.delivery', 'shipped_at')) then "shipped_at" else null end as "shipped_at",
  case when (select kernel.field_visible('sales.delivery', 'stock_refusal')) then "stock_refusal" else null end as "stock_refusal",
  case when (select kernel.field_visible('sales.delivery', 'stock_refused_at')) then "stock_refused_at" else null end as "stock_refused_at",
  case when (select kernel.field_visible('sales.delivery', 're_reserve_requested')) then "re_reserve_requested" else null end as "re_reserve_requested",
  case when (select kernel.field_visible('sales.delivery', 're_reserve_result')) then "re_reserve_result" else null end as "re_reserve_result",
  case when (select kernel.field_visible('sales.delivery', 're_reserve_note')) then "re_reserve_note" else null end as "re_reserve_note",
  case when (select kernel.field_visible('sales.delivery', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('sales.delivery', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.delivery', 'extra')) then kernel.mask_extra('sales.delivery', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.delivery', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.delivery', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.delivery', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('sales.delivery', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('sales.delivery', 'void_reason')) then "void_reason" else null end as "void_reason",
  case when (select kernel.field_visible('sales.delivery', 'order_owner_id')) then (select oo.owner_id from sales.v_order_owners oo where oo.order_id = deliveries.order_id) else null end as "order_owner_id"
from sales.deliveries;
grant select on sales.v_deliveries to authenticated;

-- grant: begin
-- R39-7: a role of an existing company that reassigns deals, creates or ships entregas, or creates or issues invoices keeps seeing every
-- pedido it works on (in the form 0124 used for the trail). Roles that only sell keep their own; companies and roles created later get
-- nothing by default (the admin grants it; a company admin always holds it).
insert into kernel.process_permissions (company_id, role_id, process_id)
select distinct pp.company_id, pp.role_id, 'sales.order.reassign'
from kernel.process_permissions pp
where pp.process_id in ('crm.opportunity.reassign', 'sales.delivery.create', 'sales.delivery.ship', 'invoicing.invoice.from_orders', 'invoicing.invoice.issue')
  and pp.allowed
on conflict (company_id, role_id, process_id) do nothing;
-- grant: end
