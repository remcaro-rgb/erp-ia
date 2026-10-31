# Prompt · Phase 2A gaps · Task 2 of 10 · "Cerrar año" end to end on its own company

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 2** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part A · Independent fixes). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §5.7, §7 workflow 6 (Cierre de año), §8 (Períodos); main design §6 (step-up). The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** It may start at once: it runs in wave 1, in parallel with Tasks 1 and 3. Interfaces this task consumes come from: phase 2A code only; read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

4. **Idempotent, order-independent end-to-end runs.** The year close spec creates and removes its own company, never touches the demo company, and passes when run alone, first, last or twice; the smoke keeps its preconditions. Test in Task 2 (run the spec twice in a row and with the smoke after it).

## The task, verbatim from the plan

### Task 2: "Cerrar año" end to end on its own company


**Files:**
- Create: `apps/web/e2e/accounting-year-close.spec.ts`
- Modify: `apps/web/test-support/accounting-fixture.ts` (add `seedYearLedger`)
- Modify: `docs/user-guide/es-419/contabilidad/periodos-y-cierre.md` (the "Cerrar año" section names what the preview shows: Ingresos del año, Gastos del año, Utilidad / Pérdida del ejercicio, and the two closing comprobantes; "Reabrir año" reverses them)

**Interfaces:**
- Consumes: `seedAuthUser`, `enrolTotp` (`auth-fixtures.ts`); `grantAccounting`, `seedSmallLedger`, `postEntry`, `cleanupAccounting`, `signInWithCode`, `confirmStepUp` (`accounting-fixture.ts`); the Períodos page copy `common.acc_pages.periods.*` (`close_year`, `reopen_year`, `close_year_title`, `preview_income`, `preview_expense`, `preview_profit`).
- Produces: `seedYearLedger(fixture: AuthFixture): Promise<SmallLedger & { periods: string[]; closingJournal: string }>` — `seedSmallLedger` plus periods 1–12 of 2026 (October reused), a `kind = 'closing'` Fuente `CI` "Cierre", and the role mapping already there; leaves every period open.

Call made: the brief asked for the demo company; the spec uses its own fixture company because a year close on Café del Norte closes October under Andrés's pending provision (refused) and changes the shared demo and the smoke's preconditions. The fixture mirrors the demo ledger's shape (income 4135, expense 5105, capital 3105, closing roles 5905 / 3605 / 3610).

- [ ] **Step 1: Write the failing spec**

```ts
test("Períodos: Cerrar año 2026 shows the preview (ingresos 10.000.000, gastos 6.000.000, utilidad 4.000.000), TOTP → two closing comprobantes dated 31/12/2026, 2026 closed and 2027 open; Reabrir año → TOTP → the closing comprobantes reversed, 2026 and its December open", async ({ page }) => {
  // postEntry: 413595 credit 10_000_000 (March), 510506 debit 6_000_000 (June); periods 1–12 set closed in setup (status 'closed')
  // UI: "Cerrar año" on the 2026 card → dialog "Cerrar el año 2026" lists the three preview figures as $ 10.000.000,00 · $ 6.000.000,00 · $ 4.000.000,00
  // confirm → confirmStepUp → dialog hidden; DB: two entries is_closing, date 2026-12-31, journal CI, second one credits 360505 4_000_000; fiscal_years 2026 closed, 2027 open with 12 periods
  // card shows "Reabrir año" → dialog lists "Comprobantes de cierre por revertir" with both numbers → confirmStepUp → both closing entries status reversed, 2026 open, period 12 open
});
test("Cerrar año is disabled while a period is open, with 'Falta cerrar 1 período del año.'", async ({ page }) => { /* reopen November in setup */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-year-close`
Expected: FAIL (`seedYearLedger` is not exported).

- [ ] **Step 3: Implement `seedYearLedger`** with the same direct-insert style as `seedSmallLedger` (fixture setup, not product code); `test.afterAll` runs `cleanupAccounting` and `fixture.cleanup()`, so 2027's year and periods go with the company.

- [ ] **Step 4: Run it to verify it passes, twice, and with the smoke after it**

Run: `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-year-close --repeat-each=2 && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-year-close accounting-smoke accounting-periods`
Expected: PASS, every run.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/accounting-year-close.spec.ts apps/web/test-support/accounting-fixture.ts docs/user-guide/es-419/contabilidad/periodos-y-cierre.md
git commit -m "test(accounting): year close and reopen end to end with the preview and step-up"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
