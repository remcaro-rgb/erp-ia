-- 0108_invoicing_payment_facts
-- Forward-only migration (rule 34). Covered by packages/modules/payments/src/__tests__/receipt.integration.test.ts (an allocation within what
-- is open, the customer, the DIAN acceptance, the annulment in progress, two receipts of one invoice at once, no deadlock in opposite orders).
-- What invoicing publishes to payments (plan 2B Task 21; rule 3: views and functions each module publishes, like sales.v_invoice_order_lines
-- for invoicing in 0093):
--   * invoicing.v_receivable_invoices: the issued invoices a recibo de caja may settle, with what they owe before payments (total + debit
--     notes − credit notes), their DIAN status and whether an annulment is in progress. Unmasked (a receipt names the invoice and its balance
--     whatever the user's role sees of an invoice), security_invoker: invoicing's RLS and record rules as the caller.
--   * invoicing.lock_invoices_for_payment: «Registrar pago» takes each invoice it settles FOR UPDATE in id order (one lock order: two receipts
--     of one invoice queue, and wait for a note or an Anular in flight, which lock the invoice too) and answers them as they stand under the
--     lock (a second statement, so a row that changed while waiting is read again).

create or replace view invoicing.v_receivable_invoices with (security_invoker = true) as
select i.id, i.company_id, i.party_id, i.number, i.issue_date, i.due_date, i.currency, i.exchange_rate, i.total, i.total_company,
       i.credited_amount, i.debited_amount, i.total + i.debited_amount - i.credited_amount as receivable, i.stage, i.status, i.dian_status,
       (i.annulment_note_id is null and exists (
          select 1 from invoicing.notes n where n.invoice_id = i.id and n.annulment and n.status <> 'voided')) as annulment_pending
from invoicing.invoices i
where i.stage in ('issued', 'paid', 'voided');
grant select on invoicing.v_receivable_invoices to authenticated;
comment on view invoicing.v_receivable_invoices is
  'Published for payments (rule 3): issued invoices with what they owe before payments, their DIAN status and an annulment in progress. Unmasked, security_invoker.';

create or replace function invoicing.lock_invoices_for_payment(p_invoices uuid[])
returns table (id uuid, party_id uuid, number text, issue_date date, currency text, total numeric, credited_amount numeric,
               debited_amount numeric, stage text, status text, dian_status text, annulment_pending boolean)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'payments.%' then
    raise exception 'invoicing.lock_invoices_for_payment is called only inside a payments process' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from invoicing.invoices i where i.company_id = v_company and i.id = any (p_invoices) order by i.id for update;
  return query
    select i.id, i.party_id, i.number, i.issue_date, i.currency, i.total, i.credited_amount, i.debited_amount, i.stage, i.status, i.dian_status,
           (i.annulment_note_id is null and exists (
              select 1 from invoicing.notes n where n.invoice_id = i.id and n.annulment and n.status <> 'voided'))
    from invoicing.invoices i
    where i.company_id = v_company and i.id = any (p_invoices)
    order by i.id;
end;
$$;
revoke execute on function invoicing.lock_invoices_for_payment(uuid[]) from public, anon;
grant execute on function invoicing.lock_invoices_for_payment(uuid[]) to authenticated, service_role;
comment on function invoicing.lock_invoices_for_payment(uuid[]) is
  'Published for payments (rule 3): the invoices a receipt settles, locked FOR UPDATE in id order and read again under the lock.';
