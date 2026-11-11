-- 0113_invoicing_paid_status
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/chain.integration.test.ts (the quote-to-ledger chain:
-- the invoice paid by its receipt, the CRM told with the oportunidad of its pedido; a partial payment, a payment void, a credit note on a
-- paid invoice, an annulment refused while a receipt settles the invoice).
-- What the paid status of an invoice reads (plan 2B Task 23; rule 3: views and functions each module publishes):
--   * payments.allocated_amounts (0109, 0111): what the posted receipts settled of some invoices, whoever may read them. It answered only
--     inside a payments process; invoicing now asks it too, under the same invoice lock «Registrar pago» takes (invoicing's consumer of
--     payments.received / payments.payment.voided recomputes paid_amount from it, never adding up; Anular refuses an invoice that a posted
--     receipt settles, even before that consumer ran; a note recomputes the paid status when it changes what is owed).
--   * sales.v_invoice_order_lines gains the pedido's oportunidad (opportunity_id, appended): invoicing.invoice.paid carries it to the CRM,
--     which logs the payment on the deal (Task 11's payload contract).

create or replace function payments.allocated_amounts(p_invoices uuid[])
returns table (invoice_id uuid, allocated numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if v_process not like 'payments.%' and v_process not like 'invoicing.%' then
    raise exception 'payments.allocated_amounts is called only inside a payments or invoicing process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.invoice_id, sum(a.amount)::numeric
    from payments.receipt_allocations a join payments.receipts r on r.id = a.receipt_id
    where a.company_id = v_company and a.invoice_id = any (p_invoices) and r.status = 'posted'
    group by a.invoice_id;
end;
$$;
revoke execute on function payments.allocated_amounts(uuid[]) from public, anon;
grant execute on function payments.allocated_amounts(uuid[]) to authenticated, service_role;
comment on function payments.allocated_amounts(uuid[]) is
  'Published for invoicing (rule 3): what the posted receipts settled of each invoice, every receipt of the active company. Payments and invoicing processes only.';

create or replace view sales.v_invoice_order_lines with (security_invoker = true) as
select l.id, l.company_id, l.order_id, o.number as order_number, o.party_id, o.stage as order_stage, o.status as order_status,
       o.currency, o.exchange_rate, l.line_no, l.product_id, l.description, l.qty, l.unit_price, l.discount_pct, l.discount, l.base,
       l.iva_rate, l.iva, l.inc_rate, l.inc, l.other_taxes, l.total, o.issue_date as order_date, o.opportunity_id
from sales.order_lines l join sales.orders o on o.id = l.order_id;
comment on view sales.v_invoice_order_lines is
  'Published for invoicing (rule 3): the pedido lines an invoice bills, with their price, discount and taxes, and the pedido''s oportunidad. Unmasked, security_invoker.';
