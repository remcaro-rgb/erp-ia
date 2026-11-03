# ERP-IA · Full code review · 2026-11-01

Scope: working tree on `main` (1,249 tracked files; 70 tables in 3 schemas plus accounting; 37 migrations). Reviewed against `docs/project-rules.md` and design §5, §6, §19a, §22.

## Verdict

The core is sound. The process pipeline, the tenant isolation helpers, the file and zip handling and the rules enforcement are carefully built. Two gaps need the owner's attention: the invoice-readiness gate (rule 10) is not enforced where accounting uses parties, and `pnpm lint` fails at the root because of stale worktrees.

## Checks run

| Check | Result |
|---|---|
| `pnpm check:rules` | Passed |
| `pnpm typecheck` (11 tasks) | Passed |
| `pnpm test` (unit) | 188 files, 1,349 tests passed |
| `pnpm lint` | **Fails**: 60 errors, all under `.claude/worktrees/` (see F2). Source tree clean |
| i18n key parity es-419 / en | 2,477 / 2,477, no gaps |
| Integration and e2e suites | Not run (need the Docker Supabase stack) |

## Findings

### F1 · High · Invoice readiness not enforced on accounting party lines (rule 10)
- Rule 10 says a record that is not `invoice_ready` cannot be used on any document line. Design §5.17 says the sales module rejects such parties.
- `packages/modules/accounting/src/processes/entry-validate.ts:166-187` checks only that a party exists and is visible (`core.v_parties`). It never reads `invoice_ready`, so a journal entry can post against a party with `dian_status ≠ complete` or a missing RUT.
- Gate is currently UI-only (`packages/ui/src/lookup/lookup-model.ts`). Sales is not built yet, so this is latent, but any posting engine path from documents would bypass it.
- **Decision for owner:** is an accounting entry line a "document line" under rule 10? If yes, add the check to `entry-validate` and to the DB posting path, with a test.

### F2 · Medium · `pnpm lint` fails from stale worktrees
- `.claude/` is untracked and not in `.gitignore`. It holds 10 worktrees (`.claude/worktrees/*`) with copies of the app.
- `eslint.config.*` ignores do not cover `.claude/**`, so each copy is linted and fails on rules whose plugins are not loaded there.
- Fix: add `**/.claude/**` to the eslint `ignores`, add `.claude/` to `.gitignore`, and remove worktrees already merged.

### F3 · Medium · No automated RLS-coverage check
- `scripts/check-rules.ts` covers migration names, Spanish literals, cross-schema writes, masked-view reads and PUC codes. It does not check RLS.
- RLS is applied through helpers (`kernel.enable_company_rls`, `kernel.enable_row_audit`, a loop in `core` migration 0006). A grep of migrations cannot confirm coverage; my static pass was inconclusive.
- Only two integration files reference `rowsecurity`.
- Fix: an integration test that lists every table in `kernel`, `core`, `accounting`, `support` and fails when `relrowsecurity` is false, except an explicit allow-list (for example `auth_attempts` if it is service-only).

### F4 · Low · Permission not re-checked inside the run transaction
- `packages/kernel/src/process/run.ts`: the gate (`can_run_process`, membership, step-up `verified`) is read in one transaction, and the handler runs in another. Step-up is re-checked atomically by `consumeStepUp`, so that path is safe. A role revoked in the gap still passes.
- Impact is a sub-second window. Fix if cheap: move the `can_run_process` check into the write transaction.

### F5 · Low · Duplicate-name check is check-then-insert
- `packages/kernel/src/attachments/precheck.ts:31-37` looks for a file with the same name, then the process inserts later. Two concurrent uploads can both pass.
- Fix: a unique partial index on `(company_id, entity, record_id, lower(file_name)) where removed_at is null`.

### F6 · Info · Housekeeping
- Three `console.log` calls outside tests and scripts (`grep` in `apps`, `packages`). Use the logger or remove.
- `GridCell` tests print jsdom "Not implemented: navigation" warnings. Stub `window.location` or the link handler.
- Zod issues are returned in `details` to the client (`process/run.ts`). Acceptable for the UI; confirm it does not expose masked field values.

## What was checked and found sound

- **`runProcess`** (`packages/kernel/src/process/run.ts`): order is resolve, entitlement, origins, membership, permission, step-up, input, idempotency, one transaction with handler, audit, outbox and idempotency row. Denials are audited in their own transaction. Dry runs roll back fully.
- **Identifiers**: registry identifiers are matched against `^[a-z][a-z0-9_]*$` and quoted before reaching `unsafe` SQL (`query/build-query.ts`, `process/run.ts:262`). Values are parameterised.
- **Service role** is confined to server modules (`lib/supabase/env.ts`, `packages/infra`, `packages/kernel/src/admin`, `files/store.ts`). No browser code reads it.
- **Attachments route** (`apps/web/src/app/api/attachments/route.ts`): size checked before reading the body, precheck authorises before any byte is stored, content sniffed against the tag kind, storage key generated server-side, orphan bytes removed on refusal, signed downloads only after a list check.
- **Zip import** (`packages/kernel/src/import/zip.ts`): entry count, total size, record walk, local/central header agreement, CRC and inflate caps are all enforced.
- **Agent** (`packages/agent`): writes become confirmation cards; cards are compare-and-set; the bearer token is never stored in the conversation.
- **Errors**: `processFailure` maps typed codes to HTTP status and hides unknown errors behind `handler_failed`.
- **Rules**: rule 5 (no PUC codes in accounting source) and rule 24 (no Spanish literals in web TSX) pass mechanically.

## Not covered

- Integration and e2e suites were not run; they need the Docker Supabase stack. Their results are needed before the commit gate.
- No dynamic test of RLS policies or of the audit trigger.
- Review was sampled, not exhaustive, across the 1,249 files. Areas read in depth: process pipeline, attachments, file store, zip import, agent confirmation design, RLS helpers, accounting validation. Not read in depth: UI components, grid query builder beyond identifier handling, phase 2 accounting reports, support module, localization pack.

## Suggested order

1. F1 (owner decision first, then code).
2. F2 (quick config fix; unblocks the lint gate).
3. F3 (test that makes RLS coverage explicit).
4. F4 and F5 when touching those files.
