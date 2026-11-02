-- Accounts that take only invoice-ready parties (rule 10, design §5.17). The country pack sets the flag on a new chart; this
-- backfills companies whose chart already exists: the accounts the company maps to the receivable and payable roles. A
-- company may change the flag later; it is not synced with the role mappings after this migration.

alter table accounting.accounts add column requires_invoice_ready boolean not null default false;

update accounting.accounts a
set requires_invoice_ready = true
from accounting.account_role_mappings m
where m.account_id = a.id and m.role in ('receivable', 'payable');
