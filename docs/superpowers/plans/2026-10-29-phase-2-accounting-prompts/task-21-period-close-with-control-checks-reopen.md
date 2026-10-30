# Prompt · Phase 2A Task 21 of 32 · Period close with control checks, reopen, year close and reopen

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 21** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part D · Entries, engine integration and periods). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §4.4, §4.14, §5.7, §5.12 (close tie-out, suspense), §6; main design §5.5. Sections the task text cites: §4.14. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–20 are merged on the branch. Interfaces this task consumes come from Task 17, Task 19, Task 20: read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

**How to work.**
- Test first (rule 31): write the failing tests of Step 1 exactly as named, run them and show they fail, implement, run them and show they pass, then run the suites the task's Step names. Use `superpowers:test-driven-development`.
- Work on the current phase 2A branch; do not create another branch unless the owner's session asks.
- Environment: the local Supabase stack (Docker via OrbStack); check Docker is up before `supabase db reset` or `pnpm db:reset`. The app's dev server is `:3100` through `.claude/launch.json`; stop or start only that one (`lsof -ti:3100` or the preview tools), never `pkill next-server` (another project runs on `:3000`). Never run the full integration suites against the hosted project.
- If the task would break a rule or deviate from the design, stop and report; the fix is an owner decision recorded in the main design §22, never a workaround.
- Before the commit: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the task touches against `:3100`, and `pnpm build`. The full suites run in GitHub Actions on the push; the task is complete only when that run is green.
- The owner starting this session with this prompt authorises the commit the task's last step names, with the message given there and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push, tag or open a PR unless the owner says so in the session.
- Spanish Latam copy only through `packages/i18n` with an `en` mirror; the journal master is **Fuente / Fuentes**; Libro diario keeps its name; money renders `$ 1.234.567,00`. No PUC code in `packages/kernel` or `packages/modules/accounting` source.

## Global constraints (from the plan; every task inherits them)

- One schema `accounting`; every table carries `id uuid default kernel.uuid_v7()`, `company_id uuid not null`, `seq bigint` from `core.next_seq`, `created_at`, `updated_at`, `created_by`, `updated_by`, `extra jsonb`, `extra_free jsonb` (rule 7, §4); money `numeric(18,4)` (rule 8); RLS through `kernel.enable_company_rls`, row audit through `kernel.enable_row_audit` (rules 12, 16).
- Cross-module reads only through published views: `core.v_parties`, `accounting.v_account_balances`, `v_entries_for_source`, `v_tax_lines`, `v_open_items`, `v_ledger_lines` (rule 3, §4.12, §4.16); no foreign key across schemas (§10a.10).
- Every state change is a `defineProcess` run through `runProcess`; the engine's writes go through `accounting.entry.post_from_event` and `accounting.posting_failure.record`, both `origins: ["event"]` and never raisable to step-up (rule 1, §5.1, §10a.3).
- Fiscal data only in `packages/localization/co` (rule 5): PUC seed, role mapping codes, account code validation, fiscal calendar, statement and 2516 layouts, journals, tax codes, exógena catalogue, thresholds and XML writer. No PUC code appears in `packages/kernel` or `packages/modules/accounting` source (the `check:rules` task adds the check).
- Step-up processes (§6): `chart.seed`, `account_role_mapping.update`, `account_permission.update`, `fiscal_concept_mapping.update`, `period.close / reopen`, `year.close / reopen`, `posting_rule.create / update / disable`, `opening.post`, `settings.update`. Admin may raise `entry.post`, `entry.reverse`, `account.update`.
- Copy in Spanish (es-419) through `packages/i18n`, `en` mirror of every key (rule 24); the journal master is **Fuente / Fuentes** everywhere; Libro diario keeps its name (§10b.18). Money renders `$ 1.234.567,00` through `formatMoney` (rule 23).
- Defaults pinned by the spec: journals `NC, VT, CP, RC, CE, AP, CI` (§4.3); `rounding_tolerance = 1.0000` COP; `manual_journal = NC`; `require_attachment_on_manual = false`; `niif_group = '2'`; `require_approval_on_manual = false`; `use_open_auxiliaries = use_items = use_business_units = false` (§4.11); aging buckets `por vencer · 1–30 · 31–60 · 61–90 · > 90` (§5.11); round-amount flag `1 000 000` COP (§5.12.5); `GridState.groupBy` max 3 levels, `sort` max 5 (§5.14); Movimientos defaults: open period, `status = posted`, sort `date asc, number asc, line_no asc` (§5.14).
- Entry status enum `draft | pending | posted | reversed | voided`; origin `manual | auto | import | template`; failure codes exactly those of §4.9; close checks exactly those of §4.14; account roles exactly the catalogue of §5.3 plus `suspense`.
- Menu: six bar items in this order, `Comprobantes · Movimientos · Maestros ▾ (Plan de cuentas, Centros de costo, Auxiliares abiertos, Ítems, Unidades de negocio, Fuentes) · Períodos · Informes · Reglas contables` (§8, §10b.19); the three optional masters hidden while their `use_*` setting is off.
- Tests first (rule 31): unit with Vitest, integration against the Supabase CLI stack (`supabase start`, `pnpm test:integration`), end to end with Playwright on the demo company. Migrations forward-only, `NNNN_<module>_<topic>.sql`, each covered by an integration test (rule 34).
- Commits: conventional, one per task step that says Commit, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; no commit or push without the owner asking (rule 33). A feature without its user guide is not finished (rule 35).

## Review focus pinned to this task

- 2. **Closed periods never move an entry.** A document dated in a closed period is a `closed_period` failure from engine, UI, assistant, import (`opening.create` + `opening.post`) and template; after `period.reopen` with `date`, only an entry dated that day posts; a credit note dated in an open month against an older invoice posts without touching the old month. Tests in Task 19 (`post refuses closed period`), Task 21 (`reopened_for admits only that day`), Task 20 (`reverseOf rule posts in the note's own period`).
- 5. **Close is a gate, balances are computed.** `period.close` refuses on drafts, pending approvals, pending failures, undispatched events, a control difference above tolerance, suspense ≠ 0 or a contra-nature balance, records every check it ran with the figures, and closes in order; `year.close` zeroes classes 4–7 through 5905 into 3605 / 3610 and `year.reopen` undoes it; an entry posted into a reopened period changes later periods' opening balances with no recalculation. Tests in Task 21 (`close refuses and records checks`, `year close lands on 3605 or 3610 by sign`, `reopened post moves later opening balances`).

## The task, verbatim from the plan

### Task 21: Period close with control checks, reopen, year close and reopen

**Files:**
- Create: `packages/modules/accounting/src/processes/period.ts` (`period.close / reopen`), `src/processes/year.ts` (`year.close / reopen`), `src/processes/close-checks.ts` (`runCloseChecks(ctx, periodId): Promise<CloseCheck[]>` — the ten checks of §4.14 with their figures), `src/reports/control-reconciliation.ts` (the SQL shared with the report of Task 24: receivable / payable by party vs open items, inventory vs `inventory.v_stock_value` when that view exists, suspense balance, rounding sum of the period)
- Test: `src/__tests__/period.integration.test.ts`, `year.integration.test.ts`

**Interfaces:**
- Produces:
  - `accounting.period.close` (step-up) input `{ periodId }`: refuses unless period N−1 is closed; runs the checks and inserts every check row (the sign-off); output `{ closed: boolean; checks: CloseCheck[] }`: with any `passed = false` the period stays open and the handler returns `closed: false` with the failed checks' notes (Spanish, with figures) instead of throwing, so the rows commit and the attempt is kept (the UI and the assistant show the list as a refusal); on success sets `status closed`, `closed_at/by`, clears `reopened_for`, emits `accounting.period.closed`.
  - `accounting.period.reopen` (step-up) input `{ periodId, date? }`: year must be open; sets `status open`, `reopened_count + 1`, `reopened_for = date`; emits `accounting.period.reopened`.
  - `accounting.year.close` (step-up) input `{ fiscalYearId }`: 12 periods closed; computes class 4–7 balances excluding `is_opening`; posts two `is_closing` entries in CI dated `ends_on` (zeroing against `income_summary`; then `income_summary` to `current_year_profit` or `current_year_loss` by sign); closes the year; opens the next (`fiscal_year.open`) if missing; emits `accounting.year.closed`. `year.reopen` reverses both closing entries (`entry.reverse` dated `ends_on`), reopens the year and its period 12.

- [ ] **Step 1: Write the failing tests**

```ts
it("close refuses and records checks: a draft, a pending approval, a pending failure, suspense ≠ 0 and a receivable difference above tolerance each fail their check with figures; closed is false, the period stays open and the rows exist after the refusal", async () => { ... });
it("close succeeds in order (N−1 first), records ten passed checks with user and time, clears reopened_for; closing N+1 before N is refused", async () => { ... });
it("reopened_for admits only that day: a post dated another day of the period is closed_period; the right day posts; close again clears it", async () => { ... });
it("year close lands on 3605 or 3610 by sign: profit → two CI entries, 5905 zero, 360505 credit = result; loss → 361005 debit; reopen reverses both and reopens December", async () => { ... });
it("reopened post moves later opening balances: an October entry posted after November closed changes November's opening in v_account_balances with no other write", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "period|year"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): period close behind control checks with sign-off rows, reopen by day, year close and reopen"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
