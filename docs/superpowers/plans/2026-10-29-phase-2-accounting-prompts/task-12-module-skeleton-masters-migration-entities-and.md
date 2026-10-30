# Prompt · Phase 2A Task 12 of 32 · Module skeleton, masters migration, entities and masked views

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 12** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part C · Accounting module: schema and masters). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §3, §4.1–4.5, §4.11, §4.13, §4.15, §5.13, §8, §9, §10a.10; main design §5.2, §5.3, §6, §15. Sections the task text cites: §4, §4.1, §4.3, §4.4, §4.5, §4.11, §4.13, §4.15, §6, §8. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–11 are merged on the branch. Interfaces this task consumes come from Task 1, Task 3, Task 4, Task 9, Task 10: read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

### Task 12: Module skeleton, masters migration, entities and masked views

**Files:**
- Create: `packages/modules/accounting/package.json` (`@erp/module-accounting`), `tsconfig.json`, `vitest.config.ts`, `vitest.integration.config.ts`, `src/index.ts` (manifest), `src/entities.ts`, `src/features.ts` (features `accounting.ledger`, `accounting.periods`, `accounting.posting`; `NAVIGATION` with the six items and the Maestros group of §8), `src/__tests__/helpers.ts` (`accountingHarness()` modelled on `coreHarness`: entitlements `["module:core", "module:accounting"]`, grants every accounting process to the admin role, a `contador` and an `auxiliar` member role with the consult and entry processes, cleanup of every accounting table), `src/__tests__/module.test.ts`, `src/__tests__/views.test.ts`
- Create: `supabase/migrations/0025_accounting_masters.sql`: schema, `accounting.setup_table(tbl, entity)` (as `core.setup_table` but in schema `accounting`, reusing `core.next_seq`), tables `accounts` (§4.1 columns, `unique (company_id, code)`, `check (code ~ '^[0-9]+$')`, `access text not null default 'open'`), `account_role_mappings` (`unique (company_id, role, coalesce(dimension, ''))`), `account_permissions` (§4.15, `unique (company_id, account_id, subject_kind, subject_id)`), `journals` (§4.3, `next_number bigint not null default 1`), `fiscal_years`, `periods` (§4.4, `unique (company_id, fiscal_year_id, number)`), `cost_centers`, `open_auxiliaries`, `items`, `business_units` (§4.5, `unique (company_id, code)`, `kind text check (kind in ('group','leaf'))`), `settings` (§4.11, `unique (company_id)`), `fiscal_concept_mappings` (§4.13, `unique (company_id, format, account_id)`); functions `accounting.can_view_account(uuid)` and `accounting.can_post_account(uuid)` (`security definer`, §4.15 resolution: nearest ancestor-or-self with `access` set; admin → true; user grant wins over role grants; engine exemption is the process's, not SQL's), trigger `accounts_set_parent_level` (parent and level from the code), masked views `accounting.v_<table>` from `maskedViewSql` (the accounts view adds `where accounting.can_view_account(id)`), grants.
- Modify: `packages/kernel/src/registry/entities.ts` (`EntityDef.kind?: "table" | "query"`, default `table`; a `query` entity has no create process and its grid consult is `<entity>.list`), `apps/web/src/lib/server/runtime.ts` and `scripts/seed.ts` (load `accounting`), `apps/web/package.json`, `package.json` devDependencies, `pnpm-workspace.yaml` if needed.

**Interfaces:**
- Produces: `export const accounting: ModuleDef` with `id: "accounting"`, `dependsOn: ["core"]`, `events.emits` of §6, `events.consumes: { "*": POSTING_CONSUMER }` (Task 20 fills the provider), `recordTabs` (Task 29), `reports` (Tasks 22–24), `homeKpis` (Task 29). `ACCOUNTING_ENTITIES`: the 20 entities of §4 (field names = column names; `ref` fields point at `accounting.account` display `code`, `core.party` display `legal_name`, the dimensions display `name`); `accounting.ledger_line` with `kind: "query"`, `table: "ledger_lines"` so its masked view is `v_ledger_lines` (Task 17 creates it as a view over the join, not a table). `DIMENSIONS = ["cost_center", "open_auxiliary", "item", "business_unit"] as const` with their table, entity and settings flag.

- [ ] **Step 1: Write the failing tests**

```ts
it("defineModule accepts the manifest: six bar items, the Maestros group with six children, three features, 20 entities", () => { ... });
it("every accounting masked view in 0025 is the generated one", () => { /* as core views.test.ts, for the 0025 entities */ });
it("can_view_account resolves nearest ancestor, user over role, admin always", async () => { /* restrict 5105 with role grant view to contador; as auxiliar: v_accounts hides 510506; as contador: shows; user grant deny→? (grants only allow): a user grant on 5105 can_view false for contador user → hidden */ });
```

- [ ] **Step 2: Run to verify they fail, write the migration, entities and manifest, run to verify they pass**

Run: `supabase db reset && pnpm -F @erp/module-accounting test && pnpm -F @erp/module-accounting test:integration -t "views|can_view"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting supabase/migrations/0025_accounting_masters.sql apps/web/src/lib/server/runtime.ts scripts/seed.ts package.json pnpm-lock.yaml
git commit -m "feat(accounting): module skeleton, masters schema with account security functions, entities and views"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
