-- 0110_accounting_payment_rules
-- Forward-only migration (rule 34), plan 2B Task 21. Covered by packages/modules/payments/src/__tests__/receipt.integration.test.ts (one copy
-- of each rule, with the advance line and the receipt as its source; the cash line by medio de pago) and entities.test.ts (the shipped rules
-- equal accounting's defaults). Re-runnable: every statement keys on what it has not done yet.
--
-- The default rule "Recibo de caja" (payments.received, 2A) gains the line of a customer advance (Cr customer_advances, one per item of
-- `advances`: the money received not applied to any invoice) and links its entry to the recibo de caja (source payments.receipt, the entity
-- the payments module defines; it said payments.payment before the module existed). The template is the module's JSON verbatim
-- (accounting/src/rules/defaults/payment-received.json; the payments module ships an identical copy, so the sync keeps one rule per company).
-- A company whose copy is unmodified gets the new template; one whose admin modified it keeps it (the admin reviews the change).
update accounting.posting_rules
   set template = $tpl${"date":"$.date","description":"Recibo de caja {{number}} · {{customer.legalName}}","party":"$.customer.partyId","source":{"entity":"payments.receipt","id":"$.paymentId"},"lines":[{"role":"cash","side":"debit","amount":"$.amount","dimension":"payment_method:{{method}}"},{"role":"withholding_income_suffered","side":"debit","forEach":"$.withholdings.income[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_vat_suffered","side":"debit","forEach":"$.withholdings.vat[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_ica_suffered","side":"debit","forEach":"$.withholdings.ica[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"receivable","side":"credit","amount":"$.applied"},{"role":"customer_advances","side":"credit","forEach":"$.advances[*]","amount":"$.amount"}],"reverseOf":null}$tpl$::jsonb
 where event = 'payments.received' and name = 'Recibo de caja' and is_default and not is_modified
   and template = $tpl${"date":"$.date","description":"Recibo de caja {{number}} · {{customer.legalName}}","party":"$.customer.partyId","source":{"entity":"payments.payment","id":"$.paymentId"},"lines":[{"role":"cash","side":"debit","amount":"$.amount","dimension":"payment_method:{{method}}"},{"role":"withholding_income_suffered","side":"debit","forEach":"$.withholdings.income[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_vat_suffered","side":"debit","forEach":"$.withholdings.vat[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"withholding_ica_suffered","side":"debit","forEach":"$.withholdings.ica[*]","amount":"$.amount","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"},{"role":"receivable","side":"credit","amount":"$.applied"}],"reverseOf":null}$tpl$::jsonb;

-- The cash line of a receipt resolves by its medio de pago (payment_method:<code>): cash and cheques to the caja (110505), transfers and
-- cards to the bank (111005). The pack's role mappings now carry them (packages/localization/co/src/accounting/role-mappings.ts); this
-- backfills the companies whose chart is already seeded (accounting.chart.seed adds only what is missing). To confirm with the owner's
-- accountant.
insert into accounting.account_role_mappings (company_id, role, dimension, account_id)
select a.company_id, 'cash', 'payment_method:' || m.method, a.id
from (values ('cash', '110505'), ('transfer', '111005'), ('card', '111005'), ('check', '110505')) as m(method, code)
join accounting.accounts a on a.code = m.code
where exists (select 1 from accounting.account_role_mappings x where x.company_id = a.company_id)
  and not exists (
    select 1 from accounting.account_role_mappings x
    where x.company_id = a.company_id and x.role = 'cash' and x.dimension = 'payment_method:' || m.method);
