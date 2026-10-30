-- 0034_accounting_entry_reversal
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/entry-post.integration.test.ts.
-- Auto-reversing accruals (accounting design §5.12.2): at post, an entry with `reverse_on` leaves exactly one mirrored draft
-- (`is_auto_reversal`, `reversal_of_id` = the original). The unique partial index makes that exact when `entry.post` is replayed.

create unique index if not exists entries_auto_reversal_key on accounting.entries (reversal_of_id) where is_auto_reversal;
create index if not exists entries_reversal_of_idx on accounting.entries (reversal_of_id) where reversal_of_id is not null;
