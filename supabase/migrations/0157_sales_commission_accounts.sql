-- 0157_sales_commission_accounts
-- Forward-only migration (rule 34), plan 2B.2 Task 30.2 (Part G design PG §5.4; ruling RG-13; owner items 159–161, provisional: the
-- accountant confirms or corrects the codes; precedent 0151:39-52). Covered by packages/modules/sales/src/__tests__/commission-accrual.integration.test.ts
-- («migration 0157 …»: the file run twice on a company seeded before it) and packages/localization/co/src/__tests__/accounting.test.ts (the
-- pack's accounts and mappings this file copies). Re-runnable: it inserts only what is missing and flags only what is not flagged yet.
--
-- The sales module now declares the account roles commission_expense and commissions_payable (a commission's provision: Dr the expense on the
-- invoice line's cost center / Cr the payable for the payee, by payee kind). The Colombia pack maps them (role-mappings.ts) and adds the two
-- expense subcuentas the PUC seed lacks (chart.ts extraAccounts); accounting.chart.seed only adds what is missing, so a chart seeded before
-- this file gets them here, as 0151 did for the exchange difference:
--   * 520518 Comisiones (under 5205 Gastos de personal: an employee's) and 523595 Otros servicios (comisiones) (under 5235 Servicios: an
--     external agent's), for every company whose chart has the parent; both ask for a cost center (class 5), neither for a party;
--   * the payables 250505 Salarios por pagar (an employee's) and 233520 Comisiones (an agent's) are in the seed; the pack now flags them
--     requires_invoice_ready (rule 10, §22.22: the provision names the payee), so every company's copy is flagged too. A posted line is not
--     touched; the flag gates the lines posted from now on;
--   * the six mappings (each role alone → the agent's account; payee_kind:employee and payee_kind:agent) for every company that already has
--     mappings (a company that maps the role and dimension keeps its own account);
--   * the two rules the sales module ships (rules/commission-accrued.json and commission-reversed.json, verbatim) for every company with sales
--     enabled and a seeded ledger (the NC journal), so a company that had sales on before this file posts its commissions without waiting for
--     the next accounting.posting_rule.sync (which would add them; it matches (event, name) and never adds one twice). Enabled reads as
--     kernel.admin's module state does (modules-state.ts): the tenant holds the module:sales entitlement and the company has not switched it off.

insert into accounting.accounts (company_id, code, name, nature, allows_movement, requires_party, requires_invoice_ready, requires_cost_center, statement_section, is_opening_result)
select p.company_id, a.code, a.name, 'debit', true, false, false, true, 'operating_expenses', false
from (values ('520518', '5205', 'Comisiones'), ('523595', '5235', 'Otros servicios (comisiones)')) as a(code, parent, name)
join accounting.accounts p on p.code = a.parent
where not exists (select 1 from accounting.accounts x where x.company_id = p.company_id and x.code = a.code);

update accounting.accounts set requires_invoice_ready = true
where code in ('250505', '233520') and not requires_invoice_ready;

insert into accounting.account_role_mappings (company_id, role, dimension, account_id)
select a.company_id, m.role, m.dimension, a.id
from (values
    ('commission_expense', null, '523595'), ('commission_expense', 'payee_kind:employee', '520518'), ('commission_expense', 'payee_kind:agent', '523595'),
    ('commissions_payable', null, '233520'), ('commissions_payable', 'payee_kind:employee', '250505'), ('commissions_payable', 'payee_kind:agent', '233520')
  ) as m(role, dimension, code)
join accounting.accounts a on a.code = m.code
where exists (select 1 from accounting.account_role_mappings x where x.company_id = a.company_id)
  and not exists (
    select 1 from accounting.account_role_mappings x
    where x.company_id = a.company_id and x.role = m.role and x.dimension is not distinct from m.dimension);

insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
select j.company_id, r.event, r.name, 'sales', j.id, r.template, 100, true
from (values
    ('sales.commission.accrued', 'Provisión de comisiones', $tpl${"date": "$.date", "description": "Provisión de la comisión {{number}}", "source": {"entity": "sales.commission", "id": "$.commissionId"}, "lines": [{"role": "commission_expense", "side": "debit", "forEach": "$.lines[*]", "amount": "$.amount", "costCenter": "$.costCenterId", "dimension": "payee_kind:{{$$.payeeKind}}"}, {"role": "commissions_payable", "side": "credit", "amount": "$.total", "party": "$.payeePartyId", "dueDate": "$.dueDate", "dimension": "payee_kind:{{payeeKind}}"}], "reverseOf": null}$tpl$::jsonb),
    ('sales.commission.reversed', 'Reversión de comisiones', $tpl${"date": "$.date", "description": "Reversión de la comisión {{number}}", "lines": [], "reverseOf": {"event": "sales.commission.accrued", "sourceId": "$.commissionId"}}$tpl$::jsonb)
  ) as r(event, name, template)
join accounting.journals j on j.code = 'NC'
join kernel.companies c on c.id = j.company_id
where kernel.entitlement_decision(c.tenant_id, c.id, array['module:sales'])
  and not exists (select 1 from kernel.company_modules cm where cm.company_id = c.id and cm.module_id = 'sales' and not cm.enabled)
  and not exists (select 1 from accounting.posting_rules x where x.company_id = j.company_id and x.event = r.event and x.name = r.name);
