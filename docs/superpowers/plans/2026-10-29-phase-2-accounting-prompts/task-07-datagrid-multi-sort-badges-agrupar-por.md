# Prompt · Phase 2A Task 7 of 32 · DataGrid multi-sort badges, Agrupar por, Agregados, group rows and grouped exports

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 7** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part A · Kernel extensions). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: main design §9, §19a; accounting design §5.14, §10b.19; prototype page Movimientos. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–6 are merged on the branch. Interfaces this task consumes come from Task 6: read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

- None pinned to this task. The five lines of the plan's Review Focus still apply when your code touches posting, periods, account security, four-eyes or close.

## The task, verbatim from the plan

### Task 7: DataGrid multi-sort badges, Agrupar por, Agregados, group rows and grouped exports

**Files:**
- Modify: `packages/ui/src/grid/DataGrid.tsx`, `packages/ui/src/grid/grid-model.ts` (`GridView.groupBy: string[]`, `GridView.aggregateFns: AggregateFn[]`, `toGridState` sends `groupBy` and one aggregate per money column per chosen fn), `packages/ui/src/grid/types.ts`, `packages/ui/src/grid/saved-views.ts` (`SavedGridState.groupBy`, `aggregateFns`), `packages/ui/src/grid/use-grid.ts`, `packages/ui/src/styles/components.css`
- Create: `packages/ui/src/grid/GroupControls.tsx` (chips `1. Cuenta ×`, select `+ campo…` of groupable columns (not money / number), toggles `Σ Suma · ⌀ Promedio · Mín · Máx · # Conteo`, `Contraer todo / Expandir todo`), `packages/ui/src/grid/GroupRow.tsx`
- Modify: `packages/kernel/src/exports/columns.ts`, `csv.ts`, `xlsx.ts`, `pdf.ts`, `plan.ts` (when the state has `groupBy`: a group path column `Grupo` first, subtotal rows after each group with the aggregates, grand total last; Excel outline levels per group)
- Test: `packages/ui/src/grid/__tests__/DataGrid.test.tsx`, `packages/ui/src/grid/__tests__/grid-model.test.ts`, `packages/kernel/src/__tests__/exports.test.ts`

**Interfaces:**
- Consumes: `GridResult.groups` (Task 6).
- Produces: header click sets a single sort, shift-click appends a level (max 5, toast `grid.sort.max_levels`), the header shows `▲` / `▼` with a superscript level number when more than one; `Agrupar por` up to 3 fields; group rows (`erp-grid__group erp-grid__group--l1…`) with `▾ <label>: <value> (n)` and one cell per aggregated column listing the chosen functions; click collapses the group (client state, `hidden n en grupos contraídos` in the footer); the footer keeps the grand totals; a group row's action `Ver líneas` applies the group keys as conditions. Saved views keep `groupBy` and `aggregateFns`.

- [ ] **Step 1: Write the failing tests**

```ts
it("shift-click appends a sort level and shows its number", async () => { ... });
it("Agrupar por sends groupBy and renders group rows with subtotals that equal the sum of their page lines", async () => { ... });
it("toGridState sends one aggregate per money column and chosen function", () => { expect(toGridState(cols, { ...view, groupBy: ["a"], aggregateFns: ["sum", "avg"] }).aggregates).toEqual([{ field: "debit", fn: "sum" }, { field: "debit", fn: "avg" }, { field: "credit", fn: "sum" }, { field: "credit", fn: "avg" }]); });
it("xlsx export with groupBy writes a Grupo column, subtotal rows and a grand total", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/ui test -t "DataGrid|grid-model" && pnpm -F @erp/kernel test -t "grouped export"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/grid packages/ui/src/styles packages/kernel/src/exports
git commit -m "feat(grid): multi-sort levels, group by up to three fields with aggregates, grouped exports"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
