-- 0142_accounting_retire_invoice_voided_rule
-- Forward-only migration (rule 34), Task 52.5 (owner decision of 2026-11-08, item 48). Covered by
-- packages/modules/accounting/src/__tests__/posting-rules-sync.integration.test.ts («retired default rule invoice-voided»: the file run twice).
-- Re-runnable: every statement keys on what it has not done yet.
--
-- An invoice is annulled by its credit note of annulment (OD-7); invoicing.invoice.voided is never emitted, so the default rule
-- «Anulación de factura de venta» (event invoicing.invoice.voided) has nothing to post. Accounting's manifest no longer ships it.
-- For each company holding the copy nobody touched (is_default, not is_modified) it is retired as 0115 retired the combined note rule:
-- inactive and marked modified, as an admin's disable, so the sync never activates it again. It is never deleted (entries may reference
-- it) and entries it already posted are untouched. A copy the admin modified stays as the admin left it; its company ids are reported
-- with a notice. accounting.posting_rule.sync applies the same retirement (posting-rule.ts, RETIRED_RULES), so the order of the sync and
-- this migration does not matter.

update accounting.posting_rules
   set is_active = false, is_modified = true
 where event = 'invoicing.invoice.voided' and name = 'Anulación de factura de venta'
   and is_default and not is_modified;

do $$
declare
  kept text;
begin
  select string_agg(company_id::text, ', ' order by company_id) into kept
    from accounting.posting_rules
   where event = 'invoicing.invoice.voided' and name = 'Anulación de factura de venta' and is_modified and is_active;
  if kept is not null then
    raise notice 'invoice-voided rule left active (modified by the admin) for companies: %', kept;
  end if;
end $$;
