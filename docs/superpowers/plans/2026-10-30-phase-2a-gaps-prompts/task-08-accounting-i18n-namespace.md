# Prompt · Phase 2A gaps · Task 8 of 10 · Accounting copy under a module namespace — OD-3 decided 2026-10-30 (option A)

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 8** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part C · Planned on the owner's decisions). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: main design §22.4 (i18n), the phase 1 plan's i18n interface (`docs/superpowers/plans/2026-10-27-phase-1-foundation.md`, the `packages/i18n` task); rule 24. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** Tasks 1–7 and 9 are merged (OD-3 decided 2026-10-30: option A, main design §22.20). It may run in parallel with Task 10 only. Interfaces this task consumes come from: every earlier task (Tasks 1–7, 9); read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

**How to work.**
- Test first (rule 31): write the failing tests of Step 1 exactly as named, run them and show they fail, implement, run them and show they pass, then run the suites the task's steps name. Use `superpowers:test-driven-development`.
- Work on the branch the owner's session names; do not create another one unless asked. When this task runs in parallel with another, it runs in its own worktree.
- Environment: the local Supabase stack (Docker via OrbStack); check Docker is up before `supabase db reset` or `pnpm db:reset`. The app's dev server is `:3100` through `.claude/launch.json`; stop or start only that one (`lsof -ti:3100` or the preview tools), never `pkill next-server` (another project runs on `:3000`). Run touched e2e specs against it with `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`; specs on the demo company need `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` first. Never run the full integration suites against the hosted project.
- If the task would break a rule or deviate from the design, stop and report; the fix is an owner decision recorded in the main design §22, never a workaround. A task blocked by an owner decision that is not recorded yet does not start.
- Before the commit: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the task touches against `:3100`, and `pnpm build`. The full suites run in GitHub Actions on the push; the task is complete only when that run is green.
- The owner starting this session with this prompt authorises the commit the task's last step names, with the message given there and the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, tag or open a PR unless the owner says so in the session.
- Spanish Latam copy only through `packages/i18n` with an `en` mirror; the journal master is **Fuente / Fuentes**; money renders `$ 1.234.567,00`. No PUC code in `packages/kernel` or `packages/modules/accounting` source. A feature without its user guide is not finished (rule 35): the task's guide edits are part of it.

## Global constraints (from the plan; every task inherits them)

- Every state change is a registered process run through `runProcess` (rule 1); the UI, the assistant and the API call the same processes.
- Account security lives in SQL (`accounting.can_view_account`, the masked views); no fix filters restricted data in TypeScript after reading it (rule 14, §5.13).
- Restricted accounts: statements keep the admin's totals on **every** money column with one line "Cuentas restringidas (n)"; line reports omit lines and count them; an Auxiliar asked for a restricted account answers "Sin acceso" and says nothing more about the account (§5.13).
- Files: generated files are downloaded through a signed link of the kernel `exportsStore()` (`FileStore.signedUrl`, TTL `EXPORT_URL_TTL_SECONDS = 600`), never streamed from a public path (rule 22).
- Fiscal logic only in `packages/localization/co` (rule 5): the XML is written by `pack.exogenaXml`; no PUC code in `packages/kernel` or `packages/modules/accounting` source (`check:rules` `puc-code-outside-pack`).
- Models only through `kernel.model_policies` and the AI SDK; no model id in code; every LLM call metered through `recordUsage` (rules 26, 27).
- Copy in Spanish (es-419) through `packages/i18n` with an `en` mirror of every key (rule 24); money `$ 1.234.567,00` (rule 23); the journal master is **Fuente**.
- Tests first (rule 31); migrations forward-only, next number `0036_<module>_<topic>.sql`, each covered by an integration test (rule 34); a feature without its guide in `docs/user-guide/es-419/contabilidad/` is not finished (rule 35).
- Pre-commit gate of every task: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the task touches against the dev server on `:3100` (`E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`), `pnpm build`. The full suites run in GitHub Actions on the push.
- Commits: conventional, one per task, ending `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; no commit, push, tag or PR without the owner asking (rule 33).
- Environment: local Supabase via OrbStack; dev server only on `:3100` (never `pkill next-server`, another project runs on `:3000`); never run full integration suites against the hosted project.

## Review focus pinned to this task

- None pinned to this task. The plan's Review Focus still applies where your code touches account security, step-up or transactions.

## The task, verbatim from the plan

### Task 8: Accounting copy under a module namespace — OD-3 decided 2026-10-30 (option A)


**Files:**
- Create: `scripts/i18n-move.ts` (moves keys between paths in both catalogues and rewrites the literal keys in `apps/web/src`, `packages/ui/src`, `packages/modules/accounting/src`; dry run by default), `packages/i18n/src/__tests__/orphans.test.ts`
- Modify: `packages/i18n/messages/es-419.json` / `en.json`: `common.entry` → `accounting.entry`, `common.acc_record` → `accounting.record`, `common.acc_pages` → `accounting.pages`, the accounting-only `grid.*` keys (`grid.master.*`, `grid.values.accounting.*`) → `accounting.master.*`, `accounting.values.*`; registry keys stay where the kernel resolves them (`entity.*`, `field.*`, `nav.*`, `feature.*`, `process.*`, `report.*`)
- Modify: `packages/i18n/src/__tests__/catalogue.test.ts:40-43` (namespaces = the twelve kind namespaces plus one per registered module that ships page copy: `accounting`)
- Modify: every file the script rewrites (expected under `apps/web/src/app/(app)/accounting`, `apps/web/src/app/(app)/r/[entity]/[id]`, `apps/web/src/lib/accounting`, `packages/ui/src/accounting`, `packages/ui/src/grid` for `grid.master`)
- Already done with the decision (2026-10-30): rule 24 and the main design §22.20 state the convention; nothing to edit there.

**Interfaces:**
- Produces: the `accounting.*` namespace; `orphans.test.ts` fails on any key under `accounting.*` that no source file names (literal key, or a template prefix the test lists) and on any literal `t("accounting.…")` without a key in both catalogues.

- [ ] **Step 1: Write the failing tests** (`catalogue.test.ts` expects the `accounting` namespace; `orphans.test.ts`), run them: FAIL.
- [ ] **Step 2: Run `pnpm tsx scripts/i18n-move.ts --write`**, then `pnpm -F @erp/i18n test && pnpm typecheck && pnpm -F @erp/ui test && pnpm -F web test`: PASS; `git grep -n "common\.\(entry\|acc_record\|acc_pages\)"` returns nothing.
- [ ] **Step 3: Run every accounting e2e spec** against `:3100`: PASS (copy unchanged on screen).
- [ ] **Step 4: Commit**

```bash
git add packages/i18n scripts/i18n-move.ts apps/web/src packages/ui/src packages/modules/accounting/src
git commit -m "refactor(i18n): accounting page copy under the accounting namespace, no orphan keys"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
