# Prompt · Phase 2A Task 25 of 32 · Movimientos: the ledger-line query entity, its list process and data.query

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 25** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part E · Reports and the ledger-line query). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §4.16, §5.14, §8 (Movimientos page), §9 (assistant data.query); main design §9, §7.1. Sections the task text cites: §5.14. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–24 are merged on the branch. Interfaces this task consumes come from Task 6, Task 12, Task 17: read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

- 3. **Restricted accounts leak nothing and lose no money.** For a user without view: statements show one "Cuentas restringidas (n)" line with the aggregated figures and totals equal to the admin's; line reports, `v_ledger_lines`, Movimientos groups, exports and `data.query` return no line and no amount of the account; the comprobante record masks the line; a forbidden account on a line is refused by name. Tests in Task 17 (`v_ledger_lines hides restricted lines`), Task 18 (`entry.create refuses account_forbidden`), Task 22 (`trial balance aggregates restricted accounts, totals equal`), Task 25 (`grouped query excludes restricted lines for every level`).

## The task, verbatim from the plan

### Task 25: Movimientos: the ledger-line query entity, its list process and `data.query`

**Files:**
- Create: `packages/modules/accounting/src/processes/ledger-line.ts` (`accounting.ledger_line.list` consult input `{ state: GridState }` → `gridQueryInTx(ctx.tx, entity, state)`; `accounting.ledger_line.consult` input `{ entryId, lineNo }`), `apps/web/src/app/(app)/accounting/movements/page.tsx` (`GridRoute entity="accounting.ledger_line"` with `initialState` from `defaultMovementsState(openPeriod)`: filters `date between`, `status eq posted`; sort `date, number, line_no`; columns of §5.14; dimension columns hidden by default while `use_*` is off)
- Modify: `apps/web/src/lib/grid/load.ts` (per-entity default state hook), `packages/kernel/src/query/access.ts` (a `kind: "query"` entity's consult is its `.list` process)
- Test: `src/__tests__/ledger-line.integration.test.ts`, `apps/web/src/lib/grid/movements.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("grouped query excludes restricted lines for every level: groupBy [account_code, cost_center_name] as auxiliar has no 5105 group and the grand total equals the visible lines; as admin every group subtotal equals the sum of its lines", async () => { ... });
it("a query with three group levels, five sort levels and mixed and/or conditions returns the same rows as the equivalent SQL on v_ledger_lines", async () => { ... });
it("data.query on accounting.ledger_line returns groups and the same totals as the grid route", async () => { ... });
it("the Movimientos default state is the open period, posted, sorted date/number/line_no", () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t ledger-line && pnpm -F web test -t movements`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting "apps/web/src/app/(app)/accounting/movements" apps/web/src/lib/grid packages/kernel/src/query
git commit -m "feat(accounting): Movimientos ledger-line query with grouped aggregates, in the grid and the assistant"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
