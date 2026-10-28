-- 0020_kernel_agent_hardening
-- Forward-only migration (rule 34). Covered by packages/agent/src/__tests__/schema.integration.test.ts ("the
-- confirmation token is not published in the read view, nor readable from the table").
-- Task 17 review round 1: the confirmation token is a bearer secret for the card. Signed-in users keep reading their
-- cards (company RLS, own or admin) but never the token column: select is granted column by column without it. The
-- card is looked up by token only server-side (the confirm route, service role) with the caller's user and company.

revoke select on kernel.agent_confirmations from authenticated;
grant select (id, company_id, conversation_id, user_id, process_id, input, preview, status, result, expires_at, decided_at,
              created_at, updated_at, created_by, updated_by)
  on kernel.agent_confirmations to authenticated;
