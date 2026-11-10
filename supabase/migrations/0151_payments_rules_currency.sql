-- 0151_payments_rules_currency
-- Forward-only migration (rule 34), plan 2B.2 Task 34.5 (FX §4, §5, §11; ruling R34-5; owner item 126 (a), provisional; precedents 0110,
-- 0149). Covered by packages/modules/payments/src/__tests__/receipt-fx.integration.test.ts («migration 0151 brings the fx accounts…», «0151
-- rewrites an unedited copy…»: the file run twice) and packages/modules/accounting/src/__tests__/rules-equal.test.ts (the shipped JSON this
-- file copies). Re-runnable: it rewrites only copies that still have no currency path and inserts only what is missing.
--
-- The receipt rule «Recibo de caja» now posts both amounts (R34-4) and the realized exchange difference (FX §5): the entry takes the
-- receipt's currency and rate, each line's `amount` reads the document twin (`*Doc`) and `amountCompany` the field that always held company
-- amounts, and one fx_loss debit and one fx_gain credit per allocation carry pesos only (`amount` 0; a line whose company amount is 0 is
-- dropped, so a peso receipt posts exactly as before). accounting.posting_rule.sync only adds missing rules, so the copies a company already
-- holds are rewritten here: those nobody touched (is_default, not is_modified) and still without a `currency` key take the shipped template.
-- A copy the admin edited keeps posting company amounts at rate 1 and the sync raises «La regla X no lleva moneda…» to the accounting role
-- (posting-rule.ts, R34-5); a receipt with an exchange difference is then refused as unbalanced until the admin adds the fx lines. The
-- template below is packages/modules/payments/src/rules/payment-received.json (and its twin in accounting/src/rules/defaults/), verbatim.
-- «Anulación de recibo de caja» reverses the entry (reverseOf): it has no lines and does not change.

update accounting.posting_rules
   set template = $tpl${"date": "$.date", "description": "Recibo de caja {{number}} · {{customer.legalName}}", "party": "$.customer.partyId", "currency": "$.currency", "exchangeRate": "$.exchangeRate", "source": {"entity": "payments.receipt", "id": "$.paymentId"}, "lines": [{"role": "cash", "side": "debit", "amount": "$.amountDoc", "amountCompany": "$.amount", "dimension": "payment_method:{{method}}"}, {"role": "withholding_income_suffered", "side": "debit", "forEach": "$.withholdings.income[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}, {"role": "withholding_vat_suffered", "side": "debit", "forEach": "$.withholdings.vat[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}, {"role": "withholding_ica_suffered", "side": "debit", "forEach": "$.withholdings.ica[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}, {"role": "fx_loss", "side": "debit", "forEach": "$.allocations[*]", "amount": "0", "amountCompany": "$.fx.loss", "dimension": "fx_kind:realized"}, {"role": "receivable", "side": "credit", "amount": "$.appliedDoc", "amountCompany": "$.applied"}, {"role": "customer_advances", "side": "credit", "forEach": "$.advances[*]", "amount": "$.amountDoc", "amountCompany": "$.amount"}, {"role": "fx_gain", "side": "credit", "forEach": "$.allocations[*]", "amount": "0", "amountCompany": "$.fx.gain", "dimension": "fx_kind:realized"}], "reverseOf": null}$tpl$::jsonb
 where event = 'payments.received' and name = 'Recibo de caja'
   and is_default and not is_modified and not (template ? 'currency');

do $$
declare
  kept text;
begin
  select string_agg(distinct company_id::text, ', ') into kept
    from accounting.posting_rules
   where event = 'payments.received' and name = 'Recibo de caja' and is_modified and not (template ? 'currency');
  if kept is not null then
    raise notice 'receipt rules without a currency path left as the admin edited them, for companies: %', kept;
  end if;
end $$;

-- The accounts of the exchange difference and their role mappings (the Colombia pack's extraAccounts and defaultRoleMappings, packages/
-- localization/co/src/accounting/; provisional, owner item 126 (a): the accountant confirms the codes). accounting.chart.seed adds only what
-- is missing, so a chart seeded before this file gets them here: a company whose chart has the PUC parents (4210, 5305). Neither asks for a
-- cost center (a receipt has none); the parent and the level come from the account trigger (0031). A company that already maps the role keeps
-- its own account.
insert into accounting.accounts (company_id, code, name, nature, allows_movement, requires_party, requires_invoice_ready, requires_cost_center, statement_section, is_opening_result)
select p.company_id, a.code, 'Diferencia en cambio', a.nature, true, false, false, false, a.section, false
from (values ('421020', '4210', 'credit', 'other_income'), ('530525', '5305', 'debit', 'other_expenses')) as a(code, parent, nature, section)
join accounting.accounts p on p.code = a.parent
where not exists (select 1 from accounting.accounts x where x.company_id = p.company_id and x.code = a.code);

insert into accounting.account_role_mappings (company_id, role, dimension, account_id)
select a.company_id, m.role, null, a.id
from (values ('fx_gain', '421020'), ('fx_loss', '530525')) as m(role, code)
join accounting.accounts a on a.code = m.code
where exists (select 1 from accounting.account_role_mappings x where x.company_id = a.company_id)
  and not exists (
    select 1 from accounting.account_role_mappings x
    where x.company_id = a.company_id and x.role = m.role and x.dimension is null);
