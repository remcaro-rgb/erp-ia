-- 0149_invoicing_rules_currency
-- Forward-only migration (rule 34), plan 2B.2 Task 34.4 (FX §4, §11; ruling R34-5; precedents 0098, 0115, 0142). Covered by
-- packages/modules/invoicing/src/__tests__/company-amounts.integration.test.ts («0149 rewrites every unedited invoicing copy…»: the file run
-- twice) and packages/modules/accounting/src/__tests__/rules-equal.test.ts (the shipped JSON this file copies). Re-runnable: it rewrites
-- only copies that still have no currency path.
--
-- The invoicing rules now post both amounts (R34-4): the entry takes the payload's currency and exchangeRate, each line's `amount` reads the
-- document twin (`*Doc`) and `amountCompany` the field that always held company amounts. accounting.posting_rule.sync only adds missing
-- rules, so the copies a company already holds are rewritten here: those nobody touched (is_default, not is_modified) and still without a
-- `currency` key take the shipped template. A copy the admin edited keeps posting company amounts at rate 1 (correct pesos; debit_doc =
-- debit) and the sync raises the recommendation «La regla X no lleva moneda…» to the accounting role (posting-rule.ts, R34-5). The
-- templates below are the JSON files of packages/modules/invoicing/src/rules/ (and their twins in accounting/src/rules/defaults/), verbatim.

-- invoice-issued.json
update accounting.posting_rules
   set template = $tpl${"date": "$.date", "description": "Factura {{number}} · {{customer.legalName}}", "party": "$.customer.partyId", "costCenter": "$.costCenterId", "businessUnit": "$.businessUnitId", "currency": "$.currency", "exchangeRate": "$.exchangeRate", "source": {"entity": "invoicing.invoice", "id": "$.invoiceId"}, "lines": [{"role": "receivable", "side": "debit", "amount": "$.totals.totalDoc", "amountCompany": "$.totals.total", "dueDate": "$.dueDate"}, {"role": "revenue", "side": "credit", "forEach": "$.lines[*]", "amount": "$.subtotalDoc", "amountCompany": "$.subtotal", "dimension": "category:{{categoryId}}", "costCenter": "$.costCenterId"}, {"role": "vat_out", "side": "credit", "forEach": "$.taxes[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "dimension": "tax:{{code}}", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}], "reverseOf": null}$tpl$::jsonb
 where event = 'invoicing.invoice.issued' and name = 'Factura de venta emitida'
   and is_default and not is_modified and not (template ? 'currency');

-- note-annulment-issued.json
update accounting.posting_rules
   set template = $tpl${"date": "$.date", "description": "Nota {{number}} · {{customer.legalName}}", "party": "$.customer.partyId", "costCenter": "$.costCenterId", "currency": "$.currency", "exchangeRate": "$.exchangeRate", "source": {"entity": "invoicing.note", "id": "$.noteId"}, "when": [{"path": "$.annulment", "equals": true}], "lines": [{"role": "receivable", "side": "debit", "amount": "$.totals.totalDoc", "amountCompany": "$.totals.total", "dueDate": "$.dueDate"}, {"role": "revenue", "side": "credit", "forEach": "$.lines[*]", "amount": "$.subtotalDoc", "amountCompany": "$.subtotal", "dimension": "category:{{categoryId}}", "costCenter": "$.costCenterId"}, {"role": "vat_out", "side": "credit", "forEach": "$.taxes[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "dimension": "tax:{{code}}", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}], "reverseOf": null}$tpl$::jsonb
 where event = 'invoicing.note.issued' and name = 'Nota crédito de anulación de venta'
   and is_default and not is_modified and not (template ? 'currency');

-- note-credit-issued.json
update accounting.posting_rules
   set template = $tpl${"date": "$.date", "description": "Nota {{number}} · {{customer.legalName}}", "party": "$.customer.partyId", "costCenter": "$.costCenterId", "currency": "$.currency", "exchangeRate": "$.exchangeRate", "source": {"entity": "invoicing.note", "id": "$.noteId"}, "when": [{"path": "$.kind", "equals": "credit"}, {"path": "$.annulment", "equals": false}], "lines": [{"role": "receivable", "side": "debit", "amount": "$.totals.totalDoc", "amountCompany": "$.totals.total", "dueDate": "$.dueDate"}, {"role": "sales_returns", "side": "credit", "forEach": "$.lines[*]", "amount": "$.subtotalDoc", "amountCompany": "$.subtotal", "dimension": "note_reason:{{$$.reasonCode}}", "costCenter": "$.costCenterId"}, {"role": "vat_out", "side": "credit", "forEach": "$.taxes[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "dimension": "tax:{{code}}", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}], "reverseOf": null}$tpl$::jsonb
 where event = 'invoicing.note.issued' and name = 'Nota crédito de venta'
   and is_default and not is_modified and not (template ? 'currency');

-- note-debit-issued.json
update accounting.posting_rules
   set template = $tpl${"date": "$.date", "description": "Nota {{number}} · {{customer.legalName}}", "party": "$.customer.partyId", "costCenter": "$.costCenterId", "currency": "$.currency", "exchangeRate": "$.exchangeRate", "source": {"entity": "invoicing.note", "id": "$.noteId"}, "when": [{"path": "$.kind", "equals": "debit"}], "lines": [{"role": "receivable", "side": "debit", "amount": "$.totals.totalDoc", "amountCompany": "$.totals.total", "dueDate": "$.dueDate"}, {"role": "revenue", "side": "credit", "forEach": "$.lines[*]", "amount": "$.subtotalDoc", "amountCompany": "$.subtotal", "dimension": "category:{{categoryId}}", "costCenter": "$.costCenterId"}, {"role": "vat_out", "side": "credit", "forEach": "$.taxes[*]", "amount": "$.amountDoc", "amountCompany": "$.amount", "dimension": "tax:{{code}}", "taxCode": "$.code", "taxRate": "$.rate", "taxBase": "$.base"}], "reverseOf": null}$tpl$::jsonb
 where event = 'invoicing.note.issued' and name = 'Nota débito de venta'
   and is_default and not is_modified and not (template ? 'currency');

do $$
declare
  kept text;
begin
  select string_agg(distinct company_id::text, ', ') into kept
    from accounting.posting_rules
   where event in ('invoicing.invoice.issued', 'invoicing.note.issued') and is_modified and not (template ? 'currency')
     and name in ('Factura de venta emitida', 'Nota crédito de anulación de venta', 'Nota crédito de venta', 'Nota débito de venta');
  if kept is not null then
    raise notice 'invoicing rules without a currency path left as the admin edited them, for companies: %', kept;
  end if;
end $$;
