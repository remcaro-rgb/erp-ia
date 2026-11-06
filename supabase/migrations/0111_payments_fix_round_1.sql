-- 0111_payments_fix_round_1
-- Forward-only migration (rule 34), plan 2B Task 21 review fix round 1. Covered by packages/modules/payments/src/__tests__/
-- receipt.integration.test.ts («migrations 0110 and 0111 …», «fix round 1 …»). Re-runnable: every statement keys on what it has not done yet.
--
--   * The "Recibo de caja" patch of 0110 matched the stored copy by its exact old template, so an unmodified copy that differed from it in
--     any way kept the old rule. Every unmodified default copy now gets the module's template (accounting/src/rules/defaults/
--     payment-received.json, verbatim). A copy an admin modified keeps its rule: it has no advance line, so a receipt with an advance is
--     refused as unbalanced until the admin adds it (Contabilidad › Reglas contables).
--   * The cash line's dimension is the medio de pago's KIND (payment_method:<kind>, controller ruling): the mappings 0110 backfilled are keyed
--     by the kind names already (cash, transfer, card, check), so nothing changes in them.
--   * invoicing.v_receivable_invoices shows Borradores too, so a receipt naming one says it is a Borrador (invoice_not_issued) instead of
--     "not found". Same columns.
--   * payments.allocated_amounts answers only inside a payments process, like invoicing.lock_invoices_for_payment.

update accounting.posting_rules
   set template = $tpl${"date":"$.date","description":"Recibo de caja {{number}} · {{customer.legalName}}","party":"$.customer.partyId","source":{"entity":"payments.receipt","id":"$.paymentId"},"lines":[{"role":"cash","side":"debit","amount":"$.amount","dimension":"payment_method:{{method}}"},{"role":"withholding_income_suffered","side":"debit","forEach":"$.withholdings.income[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_vat_suffered","side":"debit","forEach":"$.withholdings.vat[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_ica_suffered","side":"debit","forEach":"$.withholdings.ica[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"receivable","side":"credit","amount":"$.applied"},{"role":"customer_advances","side":"credit","forEach":"$.advances[*]","amount":"$.amount"}],"reverseOf":null}$tpl$::jsonb
 where event = 'payments.received' and name = 'Recibo de caja' and is_default and not is_modified
   and template is distinct from $tpl${"date":"$.date","description":"Recibo de caja {{number}} · {{customer.legalName}}","party":"$.customer.partyId","source":{"entity":"payments.receipt","id":"$.paymentId"},"lines":[{"role":"cash","side":"debit","amount":"$.amount","dimension":"payment_method:{{method}}"},{"role":"withholding_income_suffered","side":"debit","forEach":"$.withholdings.income[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_vat_suffered","side":"debit","forEach":"$.withholdings.vat[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_ica_suffered","side":"debit","forEach":"$.withholdings.ica[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"receivable","side":"credit","amount":"$.applied"},{"role":"customer_advances","side":"credit","forEach":"$.advances[*]","amount":"$.amount"}],"reverseOf":null}$tpl$::jsonb;

create or replace view invoicing.v_receivable_invoices with (security_invoker = true) as
select i.id, i.company_id, i.party_id, i.number, i.issue_date, i.due_date, i.currency, i.exchange_rate, i.total, i.total_company,
       i.credited_amount, i.debited_amount, i.total + i.debited_amount - i.credited_amount as receivable, i.stage, i.status, i.dian_status,
       (i.annulment_note_id is null and exists (
          select 1 from invoicing.notes n where n.invoice_id = i.id and n.annulment and n.status <> 'voided')) as annulment_pending
from invoicing.invoices i;
comment on view invoicing.v_receivable_invoices is
  'Published for payments (rule 3): invoices (Borradores included) with what they owe before payments, their DIAN status and an annulment in progress. Unmasked, security_invoker.';

create or replace function payments.allocated_amounts(p_invoices uuid[])
returns table (invoice_id uuid, allocated numeric)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'payments.%' then
    raise exception 'payments.allocated_amounts is called only inside a payments process' using errcode = 'insufficient_privilege';
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
