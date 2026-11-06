-- 0115_accounting_note_rules_retire_combined
-- Forward-only migration (rule 34), Phase 2B.1 final review I-1. Covered by packages/modules/invoicing/src/__tests__/note.integration.test.ts
-- («sync before 0098 …»: the old copy beside the three split rules, unmodified and modified, the file run twice, one note posting once).
-- Re-runnable: every statement keys on what it has not done yet.
--
-- 0098 split the one default rule «Nota crédito o débito de venta» (event invoicing.note.issued, no `when`) into three rules keyed by the
-- note's kind. When accounting.posting_rule.sync ran BEFORE 0098 (the new code deployed before the migration, or a migration applied by
-- hand later), the sync had already inserted the three new rules beside the old copy, so every guard of 0098 skipped it: four active
-- rules, the old one without `when` posting every note on top of the matching new one (every note's entry doubled).
--
-- For each company that has the three new rules and still has the old combined copy, exactly one effective set stays active:
--   - an UNMODIFIED old copy (is_default, not is_modified, no `when`) is retired: inactive and marked modified, as an admin's disable
--     (accounting.posting_rule.disable), so the sync never activates it again. It is never deleted (entries may reference it).
--   - an old copy the ADMIN MODIFIED keeps posting every note as the admin wrote it (as 0098 leaves it); the three new rules the sync added
--     untouched (is_default, not is_modified) are set inactive and marked modified, exactly as 0098 adds them for a modified copy, for the
--     admin to review and switch over. An old copy the admin modified AND disabled posts nothing: the new rules stay as they are.
-- accounting.posting_rule.sync applies the same retirement whenever it installs the note rules (posting-rule.ts, `retireSupersededRules`),
-- so the order of the sync and the migrations no longer matters.

with companies as (
  select o.company_id
  from accounting.posting_rules o
  where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta'
    and (select count(distinct n.name) from accounting.posting_rules n
          where n.company_id = o.company_id and n.event = o.event
            and n.name in ('Nota crédito de anulación de venta', 'Nota crédito de venta', 'Nota débito de venta')) = 3
)
update accounting.posting_rules n
   set is_active = false, is_modified = true
 where n.event = 'invoicing.note.issued'
   and n.name in ('Nota crédito de anulación de venta', 'Nota crédito de venta', 'Nota débito de venta')
   and n.is_default and not n.is_modified
   and n.company_id in (select company_id from companies)
   and exists (select 1 from accounting.posting_rules o
                where o.company_id = n.company_id and o.event = n.event and o.name = 'Nota crédito o débito de venta'
                  and o.is_modified and o.is_active);

with companies as (
  select o.company_id
  from accounting.posting_rules o
  where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta'
    and (select count(distinct n.name) from accounting.posting_rules n
          where n.company_id = o.company_id and n.event = o.event
            and n.name in ('Nota crédito de anulación de venta', 'Nota crédito de venta', 'Nota débito de venta')) = 3
)
update accounting.posting_rules o
   set is_active = false, is_modified = true
 where o.event = 'invoicing.note.issued' and o.name = 'Nota crédito o débito de venta'
   and o.is_default and not o.is_modified and not (o.template ? 'when')
   and o.company_id in (select company_id from companies);
