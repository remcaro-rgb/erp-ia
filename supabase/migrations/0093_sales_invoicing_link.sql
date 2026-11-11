-- 0093_sales_invoicing_link
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/creation.integration.test.ts (por facturar, the three
-- ways of creating invoices, the race between «Emitir» and Anular una entrega), issue.integration.test.ts and
-- concurrency.integration.test.ts (the credit exposure is in creation.integration.test.ts).
-- What sales publishes to invoicing, and what sales now reads of it (plan 2B Task 16; rule 3: views and functions each module publishes,
-- like crm.v_quote_offers for sales in 0084):
--   * sales.v_invoice_order_lines / sales.v_invoice_delivery_lines: the pedido lines (price, discount, taxes, currency) and the shipped entrega
--     lines invoicing bills. Unmasked (an invoice carries the price whatever the issuer's role sees of a pedido), security_invoker.
--   * sales.lock_deliveries_for_invoice: «Emitir» takes each entrega it bills FOR SHARE, so it waits for an Anular in flight (which takes the
--     entrega FOR UPDATE) and an Anular waits for it; under that lock it re-reads the entrega (a voided one is refused).
--   * invoicing.v_pending_to_invoice («Por facturar»): what shipped and is not yet on an invoice (Borradores included), per entrega line.
--   * sales.credit_exposure, replaced (its INTERIM version of 0085 said so): firm pedidos not yet invoiced + issued invoices still owed, the
--     same per-customer advisory lock and signature.

create or replace view sales.v_invoice_order_lines with (security_invoker = true) as
select l.id, l.company_id, l.order_id, o.number as order_number, o.party_id, o.stage as order_stage, o.status as order_status,
       o.currency, o.exchange_rate, l.line_no, l.product_id, l.description, l.qty, l.unit_price, l.discount_pct, l.discount, l.base,
       l.iva_rate, l.iva, l.inc_rate, l.inc, l.other_taxes, l.total
from sales.order_lines l join sales.orders o on o.id = l.order_id;
grant select on sales.v_invoice_order_lines to authenticated;
comment on view sales.v_invoice_order_lines is
  'Published for invoicing (rule 3): the pedido lines an invoice bills, with their price, discount and taxes. Unmasked, security_invoker.';

create or replace view sales.v_invoice_delivery_lines with (security_invoker = true) as
select l.id, l.company_id, l.delivery_id, d.number as delivery_number, d.status as delivery_status, d.stage as delivery_stage,
       d.date as delivery_date, d.cost_center_id, d.order_id, d.party_id, l.line_no, l.order_line_id, l.product_id, l.description, l.qty
from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id;
grant select on sales.v_invoice_delivery_lines to authenticated;
comment on view sales.v_invoice_delivery_lines is
  'Published for invoicing (rule 3): the entrega lines an invoice bills (what shipped). Unmasked, security_invoker.';

-- The entregas an invoice bills, locked FOR SHARE in id order (one lock order) and answered as they stand under the lock. Definer: the lock
-- covers the entrega whoever may read it. Only inside an invoicing process run, only the caller's active company.
create or replace function sales.lock_deliveries_for_invoice(p_deliveries uuid[])
returns table (id uuid, number text, status text, stage text, order_id uuid, party_id uuid)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'invoicing.%' then
    raise exception 'sales.lock_deliveries_for_invoice is called only inside an invoicing process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select d.id, d.number, d.status, d.stage, d.order_id, d.party_id
    from sales.deliveries d
    where d.company_id = v_company and d.id = any (p_deliveries)
    order by d.id
    for share;
end;
$$;
revoke execute on function sales.lock_deliveries_for_invoice(uuid[]) from public, anon;
grant execute on function sales.lock_deliveries_for_invoice(uuid[]) to authenticated, service_role;

-- «Por facturar» (OD-2 manual): per shipped entrega line (entrega not voided), what is left to invoice once every invoice that is not voided
-- (Borradores included) is counted, on the entrega line and on its pedido line (a pedido invoiced whole at confirmation leaves nothing of its
-- entregas to invoice). security_invoker: sales' and invoicing's RLS as the caller.
create or replace view invoicing.v_pending_to_invoice with (security_invoker = true) as
with billed as (
  select il.delivery_line_id, sum(il.qty) as qty
  from invoicing.invoice_lines il join invoicing.invoices i on i.id = il.invoice_id
  where il.delivery_line_id is not null and i.stage <> 'voided'
  group by il.delivery_line_id
), billed_order as (
  select il.order_line_id, sum(il.qty) as qty
  from invoicing.invoice_lines il join invoicing.invoices i on i.id = il.invoice_id
  where il.order_line_id is not null and i.stage <> 'voided'
  group by il.order_line_id
)
select d.company_id, d.party_id, d.order_id, ol.order_number, d.delivery_id, d.delivery_number, d.delivery_date, d.id as delivery_line_id,
       d.order_line_id, d.product_id, d.description, d.qty as delivered_qty, coalesce(b.qty, 0) as invoiced_qty,
       least(d.qty - coalesce(b.qty, 0), ol.qty - coalesce(bo.qty, 0)) as pending_qty, ol.unit_price, ol.discount_pct, ol.currency
from sales.v_invoice_delivery_lines d
join sales.v_invoice_order_lines ol on ol.id = d.order_line_id
left join billed b on b.delivery_line_id = d.id
left join billed_order bo on bo.order_line_id = d.order_line_id
where d.delivery_stage = 'shipped' and d.delivery_status <> 'voided'
  and least(d.qty - coalesce(b.qty, 0), ol.qty - coalesce(bo.qty, 0)) > 0;
grant select on invoicing.v_pending_to_invoice to authenticated;
comment on view invoicing.v_pending_to_invoice is
  'Por facturar: shipped entrega lines not yet on an invoice (OD-2 manual). security_invoker.';

-- The customer's credit (0084, 0085), final semantics: what the firm pedidos still owe until invoiced (their total in the company currency
-- less what issued invoices billed of them, never below zero) plus what issued invoices still owe (total less paid and credited).
create or replace function sales.credit_exposure(p_party uuid, p_except uuid)
returns table (credit_limit numeric, exposure numeric)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sales.credit:' || v_company::text || ':' || p_party::text, 0));
  return query
    select (select t.credit_limit from sales.customer_terms t where t.company_id = v_company and t.party_id = p_party),
           coalesce((select sum(greatest(o.total_company - coalesce(v.invoiced_company, 0), 0))
                     from sales.orders o
                     left join invoicing.v_order_invoiced v on v.company_id = v_company and v.order_id = o.id
                     where o.company_id = v_company and o.party_id = p_party and o.stage in ('confirmed', 'partially_delivered', 'delivered')
                       and o.status <> 'voided' and o.id is distinct from p_except), 0)
         + coalesce((select sum(x.open_company) from invoicing.v_open_invoices x where x.company_id = v_company and x.party_id = p_party), 0);
end;
$$;
