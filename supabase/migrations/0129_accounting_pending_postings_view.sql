-- Task 33 stage B (R33-8, R33-9): the web layer reads module data through views only (rule 14: no direct read of a function or table).
-- `v_pending_postings` wraps the definer function `accounting.pending_postings()` (0128), which answers for the active company of a member only
-- (it reads the session's claims) and reveals no ledger data, only that a posting is pending. Like the other accounting.v_* views it is
-- security_invoker: the caller needs execute on the function (authenticated has it, anon does not) and the function keeps the company scoping.
-- `v_posting_mode` publishes the one column the mode card shows to whoever reads the mapping, without unmasking any other setting: the posting
-- mode is not sensitive (the warning about the asynchronous mode is for everyone); the base table's company RLS applies to the caller.
-- Forward-only.
create or replace view accounting.v_pending_postings with (security_invoker = true) as
select source_id, event, state, since, failure_id from accounting.pending_postings();
revoke all on accounting.v_pending_postings from public, anon;
grant select on accounting.v_pending_postings to authenticated, service_role;

create or replace view accounting.v_posting_mode with (security_invoker = true) as
select company_id, posting_mode from accounting.settings;
revoke all on accounting.v_posting_mode from public, anon;
grant select on accounting.v_posting_mode to authenticated, service_role;
