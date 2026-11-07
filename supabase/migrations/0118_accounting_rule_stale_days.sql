-- 0118_accounting_rule_stale_days
-- Forward-only migration (rule 34), plan 2B.2 Task 50.6 (owner item 6). Covered by
-- packages/modules/accounting/src/__tests__/settings.integration.test.ts and rule-stale.integration.test.ts.
--
-- Days without a matching event after which a posting rule that has a `when` is flagged «Sin coincidencias en N días» (posting_rule.consult).
-- Whole days, 1 to 3650; existing company rows take the default of 30.

alter table accounting.settings
  add column if not exists rule_stale_days int not null default 30;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_rule_stale_days_check' and conrelid = 'accounting.settings'::regclass) then
    alter table accounting.settings add constraint settings_rule_stale_days_check check (rule_stale_days > 0 and rule_stale_days <= 3650);
  end if;
end $$;
