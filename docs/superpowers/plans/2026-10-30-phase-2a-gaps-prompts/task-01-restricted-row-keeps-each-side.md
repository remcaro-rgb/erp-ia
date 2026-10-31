# Prompt · Phase 2A gaps · Task 1 of 10 · Trial balance and libro mayor keep each side of the restricted row

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 1** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part A · Independent fixes). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §5.13, §6 (statement reports), §8 (Informes); main design §22.17. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** It may start at once: it runs in wave 1, in parallel with Tasks 2 and 3. Interfaces this task consumes come from: phase 2A code only; read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

2. **Totals equal to the admin's on every column.** A trial balance or libro mayor with restricted accounts of both natures, with and without opening balances, at levels 2 and 4: each of the six money totals equals the admin's. Tests in Task 1 (`restricted accounts of both natures keep each side`, `libro mayor keeps each side`).

## The task, verbatim from the plan

### Task 1: Trial balance and libro mayor keep each side of the restricted row


**Files:**
- Modify: `packages/modules/accounting/src/reports/trial-balance.ts` (the `Folded` accumulator and `toRow`)
- Modify: `apps/web/e2e/accounting-smoke.spec.ts:140-144` (Laura's and Marcela's six totals are equal)
- Modify: `docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md:32` (drop "las columnas de cierre … pueden diferir"; say the totals are the same for every person), `docs/user-guide/es-419/contabilidad/informes.md` (one sentence: the restricted line shows the debit and the credit balances of its accounts, each on its side)
- Test: `packages/modules/accounting/src/__tests__/reports-statements.integration.test.ts`

**Interfaces:**
- Consumes: `balanceRows`, `foldRestricted`, `BalanceRow` (`reports/common.ts`), unchanged.
- Produces: the restricted row of `accounting.trial_balance` and `accounting.ledger` carries `opening_debit = Σ max(openingNet_i, 0)`, `opening_credit = Σ max(-openingNet_i, 0)`, `debit = Σ debit_i`, `credit = Σ credit_i`, `closing_debit = Σ max(closingNet_i, 0)`, `closing_credit = Σ max(-closingNet_i, 0)` over the folded rows `i` at the report's level; every visible row unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it("trial balance with restricted accounts of both natures keeps each side: six totals equal to the admin's, opening and closing", async () => {
  // restrict 5105 (debit, with movement) and 3105 (credit, with an opening entry); auxiliar has no grant
  // as admin and as auxiliar at level 4: expect(aux.aggregates).toMatchObject(pick(admin.aggregates, MONEY));
  // the '🔒' row: n = 2, opening_credit = 3105's opening, closing_debit = 5105's closing, closing_credit = 3105's closing
});
it("libro mayor keeps each side of the restricted row at level 2", async () => { /* same assertion on accounting.ledger, level 2 */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/module-accounting test:integration -t "keeps each side"`
Expected: FAIL (the auxiliar's `opening_credit` and `closing_*` totals are lower than the admin's by the netted amount).

- [ ] **Step 3: Implement** in `trial-balance.ts`: `Folded` accumulates the six split columns per folded row (split each row's `openingNet` and closing net into debit / credit before adding); `toRow(folded, n)` writes those sums instead of splitting a net. Visible rows still split their own net.

- [ ] **Step 4: Update the smoke assertion** to `expect(lauraCells).toEqual(cells)` (all six), and the two guides.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "reports-statements" && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-smoke`
Expected: PASS (the smoke needs `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` first).

- [ ] **Step 6: Commit**

```bash
git add packages/modules/accounting/src/reports/trial-balance.ts packages/modules/accounting/src/__tests__/reports-statements.integration.test.ts apps/web/e2e/accounting-smoke.spec.ts docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md docs/user-guide/es-419/contabilidad/informes.md
git commit -m "fix(accounting): restricted-accounts row keeps each side so every statement total equals the admin's"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
