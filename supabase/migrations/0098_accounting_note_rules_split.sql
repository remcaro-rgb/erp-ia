-- 0098_accounting_note_rules_split
-- Forward-only migration (rule 34), plan 2B Task 18 fix round 1. Covered by packages/modules/invoicing/src/__tests__/note.integration.test.ts
-- («migration 0098 …»: an unmodified old copy is split, a modified one is left posting and the split rules arrive disabled, a second run
-- changes nothing). Re-runnable: every statement keys on what it has not done yet.
--
-- The one default rule "Nota crédito o débito de venta" (event invoicing.note.issued) reversed the revenue of every note through note_reason:<concept>, i.e. the
-- revenue role's default 413595, not the accounts the invoice credited (revenue by category:<id>). It is split by the note's kind with the
-- rule-level "when" (Task 7): "Nota crédito de anulación de venta" (annulment) and "Nota débito de venta" (debit) post revenue by category, the exact mirror of the
-- invoice; "Nota crédito de venta" (a partial credit) posts to sales_returns by its concept (417505 in the Colombian chart). The templates are the
-- module's JSON files verbatim (accounting/src/rules/defaults/note-*-issued.json; the invoicing module ships identical copies, so the sync
-- keeps one rule per company).
--
-- A company whose old copy is unmodified: the two new rules are added beside it (its journal, module, priority and state) and the old copy
-- becomes the annulment rule (renamed, new template): one copy of each rule. A company whose admin modified the old rule: it keeps posting
-- every note as the admin wrote it; the three new rules are added disabled and marked modified (as an admin's disable: the sync never
-- enables them), for the admin to review and switch over. Companies without the old rule get the new ones from the sync.

insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default, is_active, is_modified)
select o.company_id, o.event, 'Nota crédito de venta', o.module, o.journal_id, $tpl${"date":"$.date","description":"Nota {{number}} · {{customer.legalName}}","party":"$.customer.partyId","costCenter":"$.costCenterId","source":{"entity":"invoicing.note","id":"$.noteId"},"when":[{"path":"$.kind","equals":"credit"},{"path":"$.annulment","equals":false}],"lines":[{"role":"receivable","side":"debit","amount":"$.totals.total","dueDate":"$.dueDate"},{"role":"sales_returns","side":"credit","forEach":"$.lines[*]","amount":"$.subtotal","dimension":"note_reason:{{$$.reasonCode}}","costCenter":"$.costCenterId"},{"role":"vat_out","side":"credit","forEach":"$.taxes[*]","amount":"$.amount","dimension":"tax:{{code}}","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"}],"reverseOf":null}$tpl$::jsonb, o.priority, true,
       o.is_active and not o.is_modified, o.is_modified
from accounting.posting_rules o
where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta'
  and not exists (select 1 from accounting.posting_rules x where x.company_id = o.company_id and x.event = o.event and x.name = 'Nota crédito de venta');

insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default, is_active, is_modified)
select o.company_id, o.event, 'Nota débito de venta', o.module, o.journal_id, $tpl${"date":"$.date","description":"Nota {{number}} · {{customer.legalName}}","party":"$.customer.partyId","costCenter":"$.costCenterId","source":{"entity":"invoicing.note","id":"$.noteId"},"when":[{"path":"$.kind","equals":"debit"}],"lines":[{"role":"receivable","side":"debit","amount":"$.totals.total","dueDate":"$.dueDate"},{"role":"revenue","side":"credit","forEach":"$.lines[*]","amount":"$.subtotal","dimension":"category:{{categoryId}}","costCenter":"$.costCenterId"},{"role":"vat_out","side":"credit","forEach":"$.taxes[*]","amount":"$.amount","dimension":"tax:{{code}}","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"}],"reverseOf":null}$tpl$::jsonb, o.priority, true,
       o.is_active and not o.is_modified, o.is_modified
from accounting.posting_rules o
where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta'
  and not exists (select 1 from accounting.posting_rules x where x.company_id = o.company_id and x.event = o.event and x.name = 'Nota débito de venta');

insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default, is_active, is_modified)
select o.company_id, o.event, 'Nota crédito de anulación de venta', o.module, o.journal_id, $tpl${"date":"$.date","description":"Nota {{number}} · {{customer.legalName}}","party":"$.customer.partyId","costCenter":"$.costCenterId","source":{"entity":"invoicing.note","id":"$.noteId"},"when":[{"path":"$.annulment","equals":true}],"lines":[{"role":"receivable","side":"debit","amount":"$.totals.total","dueDate":"$.dueDate"},{"role":"revenue","side":"credit","forEach":"$.lines[*]","amount":"$.subtotal","dimension":"category:{{categoryId}}","costCenter":"$.costCenterId"},{"role":"vat_out","side":"credit","forEach":"$.taxes[*]","amount":"$.amount","dimension":"tax:{{code}}","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"}],"reverseOf":null}$tpl$::jsonb, o.priority, true,
       o.is_active and not o.is_modified, o.is_modified
from accounting.posting_rules o
where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta' and o.is_modified
  and not exists (select 1 from accounting.posting_rules x where x.company_id = o.company_id and x.event = o.event and x.name = 'Nota crédito de anulación de venta');

update accounting.posting_rules o
   set name = 'Nota crédito de anulación de venta', template = $tpl${"date":"$.date","description":"Nota {{number}} · {{customer.legalName}}","party":"$.customer.partyId","costCenter":"$.costCenterId","source":{"entity":"invoicing.note","id":"$.noteId"},"when":[{"path":"$.annulment","equals":true}],"lines":[{"role":"receivable","side":"debit","amount":"$.totals.total","dueDate":"$.dueDate"},{"role":"revenue","side":"credit","forEach":"$.lines[*]","amount":"$.subtotal","dimension":"category:{{categoryId}}","costCenter":"$.costCenterId"},{"role":"vat_out","side":"credit","forEach":"$.taxes[*]","amount":"$.amount","dimension":"tax:{{code}}","taxCode":"$.code","taxRate":"$.rate","taxBase":"$.base"}],"reverseOf":null}$tpl$::jsonb
 where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta' and o.is_default and not o.is_modified
   and not exists (select 1 from accounting.posting_rules x where x.company_id = o.company_id and x.event = o.event and x.name = 'Nota crédito de anulación de venta');
