-- 0143_accounting_posting_alert_minutes
-- Forward-only migration (rule 34), plan 2B.2 Task 52.7 (owner item 74). Covered by
-- packages/modules/accounting/src/__tests__/posting-age.integration.test.ts and settings.integration.test.ts.
--
-- Minutes a document may wait for its entry (queued, dead-lettered or failed in the retry queue, accounting.pending_postings of 0128/0129)
-- before accounting.posting.age_check raises the kernel recommendation `posting_age` to whoever may retry postings. Whole minutes, 5 to
-- 10080 (one week); existing company rows take the default of 60. The settings row audit already records its changes.

alter table accounting.settings
  add column if not exists posting_alert_minutes integer not null default 60;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_posting_alert_minutes_check' and conrelid = 'accounting.settings'::regclass) then
    alter table accounting.settings add constraint settings_posting_alert_minutes_check check (posting_alert_minutes between 5 and 10080);
  end if;
end $$;
