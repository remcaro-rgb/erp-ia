# ERP-IA Phase 2A: Posting engine and accounting module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Enforcement (owner order, 2026-10-28):** every implementer and reviewer, whatever model runs it, reads `docs/project-rules.md` and the design sections the task touches before starting, and the brief given to any subagent says: "Read `docs/project-rules.md` and the design sections for X before starting; follow the plan task verbatim." Work that passes its tests but breaks a rule or deviates from the design is rejected. A task that would need a deviation stops and reports; the fix is an owner decision in the main design §22, never a workaround.
>
> **Owner order (2026-10-28, 2026-10-29):** this plan is written for review. Do not execute it until the owner says so.

**Goal:** A Colombian company that enables Contabilidad gets a PUC chart, journals (fuentes), periods and four analytic dimensions seeded by the pack; every domain event with a posting rule becomes one balanced, idempotent, audited comprobante; accountants create, approve, post, reverse and query entries, close periods behind control checks, restrict accounts per role and user, and pull the fiscal reports, exógena, aging and a general ledger-line query, all from the grid, the assistant and the exports alike.

**Architecture:** The posting engine is kernel code (`packages/kernel/src/posting`) that composes entries from declarative JSON templates and reaches the ledger only through a `PostingProvider` the accounting manifest registers; the accounting module (`packages/modules/accounting`, schema `accounting`) is that provider and owns every table, process, view, report and page. Account security, field masking and RLS live in SQL views and functions so grids, reports, exports, `data.query` and the assistant behave identically. Reports are kernel infrastructure (`ReportDef`, a report route and report exports) whose first consumers are the accounting reports; the Movimientos page is a plain grid over a query view, powered by a kernel extension of `GridState.groupBy` to grouped aggregates.

**Tech Stack:** TypeScript 5.x, Next.js 16 App Router, React 19, Supabase Postgres 15+ (RLS, `security_invoker` views, `security definer` functions), `postgres` (porsager), Zod 4, Workflow DevKit (outbox dispatch), shadcn/ui + Tailwind v4, TanStack Table v8, next-intl, exceljs, `@react-pdf/renderer`, Vitest (unit + integration against the CLI / Docker stack), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-accounting-module-design.md` (approved 2026-10-29; every section) and `docs/superpowers/specs/2026-10-26-erp-ia-design.md` §5.2–5.6, §5.12, §6, §9, §15, §16, §19a, §22.17. Visual contract: `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html` (phase 2 prototype, Version 6) over the phase 1 prototype's shell. Rules: `docs/project-rules.md` (37 rules). Section references below are to the accounting design unless marked "main".

## Scope of this plan and the plans that follow

Phase 2 of the roadmap is "order to cash". It is several independent subsystems and gets several plans, each producing working software on its own:

| Plan | Content | Depends on |
|---|---|---|
| **2A (this)** | kernel extensions (origins, wildcard consumers, nav groups, record-tab contributions, reports, grouped aggregates), posting engine, Colombia pack accounting extension, accounting module (schema, masters, entries, periods, controls, security by account, reports, exógena, aging, Movimientos, UI, guides, demo) | phase 1 |
| 2B | CRM, sales, invoicing with DIAN (port Serena `src/lib/dian`), costing, inventory, warehouse, payments; each ships its `postingRules` for the §5.4 events and its "Contabilidad" integration | 2A |
| 2C | onboarding: import framework over `accounting.opening.create` and the masters, Siigo / Alegra connectors, posting window per role (roadmap 2b) | 2A, 2B |

What 2A builds for 2B without 2B existing: the engine is tested with synthetic outbox events of the §5.4 shapes and the default rule templates of §5.4 ship in the accounting module as **fixtures** (`packages/modules/accounting/src/rules/defaults/*.json`) and as the per-company rules `chart.seed` installs, so an accountant can read them and the 2B modules move each template into their own manifest `postingRules` unchanged (call made here: the templates live where they can be tested now and are relocated by 2B, which must not change their content).

## Global Constraints

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

## Review Focus

1. **Redelivery and retry post once.** The same outbox row dispatched twice, a `posting.retry` of a resolved failure, and two rules on one event must leave exactly one entry per `(source_event_id, posting_rule_id)`. Tests in Task 20 (`post_from_event: redelivered event answers the first entry`, `two rules on one event make two entries, one each`).
2. **Closed periods never move an entry.** A document dated in a closed period is a `closed_period` failure from engine, UI, assistant, import (`opening.create` + `opening.post`) and template; after `period.reopen` with `date`, only an entry dated that day posts; a credit note dated in an open month against an older invoice posts without touching the old month. Tests in Task 19 (`post refuses closed period`), Task 21 (`reopened_for admits only that day`), Task 20 (`reverseOf rule posts in the note's own period`).
3. **Restricted accounts leak nothing and lose no money.** For a user without view: statements show one "Cuentas restringidas (n)" line with the aggregated figures and totals equal to the admin's; line reports, `v_ledger_lines`, Movimientos groups, exports and `data.query` return no line and no amount of the account; the comprobante record masks the line; a forbidden account on a line is refused by name. Tests in Task 17 (`v_ledger_lines hides restricted lines`), Task 18 (`entry.create refuses account_forbidden`), Task 22 (`trial balance aggregates restricted accounts, totals equal`), Task 25 (`grouped query excludes restricted lines for every level`).
4. **Four-eyes and auto-reversal are exact.** With `require_approval_on_manual` on, the creator cannot post their own manual entry from UI or assistant while another user can, and engine postings are unaffected; a `reverse_on` entry leaves exactly one auto-reversal draft, also when `entry.post` is retried. Tests in Task 19 (`same_user_approval`, `engine posting ignores four-eyes`, `reverse_on creates one mirrored draft, idempotent`).
5. **Close is a gate, balances are computed.** `period.close` refuses on drafts, pending approvals, pending failures, undispatched events, a control difference above tolerance, suspense ≠ 0 or a contra-nature balance, records every check it ran with the figures, and closes in order; `year.close` zeroes classes 4–7 through 5905 into 3605 / 3610 and `year.reopen` undoes it; an entry posted into a reopened period changes later periods' opening balances with no recalculation. Tests in Task 21 (`close refuses and records checks`, `year close lands on 3605 or 3610 by sign`, `reopened post moves later opening balances`).

---

## Part A · Kernel extensions

### Task 1: Process origins and wildcard event consumers

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (`ProcessDef.origins?: Origin[]`), `packages/kernel/src/process/run.ts`, `packages/kernel/src/events/consumers.ts`, `packages/kernel/src/events/drain.ts`, `packages/kernel/src/module/define.ts`, `packages/kernel/src/admin/permissions.ts` and `common.ts` (the sensitive-processes listing), `packages/agent/src/tools/from-registry.ts`
- Test: `packages/kernel/src/__tests__/run-process.integration.test.ts`, `packages/kernel/src/__tests__/dispatch.integration.test.ts`, `packages/kernel/src/__tests__/module-loader.test.ts`, `packages/agent/src/__tests__/tools.test.ts`

**Interfaces:**
- Produces: `ProcessDef.origins?: Origin[]` — when set, `runProcess` refuses any other `caller.origin` with `ProcessError("forbidden", …, { stage: "gate" })` before the role check, the admin's sensitive-processes page leaves the process out, and the assistant never gets a tool for it. `consumers.register(moduleId, "*", fn)`; `consumers.for(event)` returns the event's consumers first, then the `"*"` consumers, one per module; `consumers.pairs()` lists `{ event: "*", module_id }` rows, and the drain's parked-row gate matches `c.event = o.event or c.event = '*'`. `defineModule` accepts `"*"` as a key of `events.consumes`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a process with origins ['event'] is refused from ui with forbidden before the role check", async () => { /* register a test process with origins: ["event"]; runProcess as admin origin ui → rejects code forbidden, stage gate; as buildConsumerContext(...).runProcess → resolves */ });
it("sensitive process list omits processes with origins", async () => { /* kernel.admin.sensitive_process.list (or the loader the page uses) does not include the test process */ });
it("agent tool descriptors omit processes with origins", async () => { /* processToolDescriptors lacks test__event__only */ });
it("wildcard consumer runs after the specific one and is parked while its module is disabled", async () => { /* module A consumes 'x.happened', module B consumes '*'; dispatch → order [A, B]; disable B → row parked module_disabled, drain skips it, enable → delivered */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/kernel test -t "origins|wildcard" && pnpm -F @erp/kernel test:integration -t "origins|wildcard" && pnpm -F @erp/agent test -t origins`
Expected: FAIL (`origins` unknown, `*` consumers not returned).

- [ ] **Step 3: Implement** `origins` in `ProcessDef`, the gate in `execute()` (`if (def.origins && !def.origins.includes(caller.origin)) throw new ProcessError("forbidden", \`${def.id} runs only from ${def.origins.join(", ")}\`, GATE)`), the filter in the sensitive-processes loader and in `permittedProcesses`, `"*"` in `ConsumerRegistry.for` / `pairs`, and the drain gate predicate.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same commands. Expected: PASS, and the whole kernel suite still green (`pnpm -F @erp/kernel test && pnpm -F @erp/kernel test:integration`).

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src packages/agent/src
git commit -m "feat(kernel): process origins and wildcard event consumers for the posting engine"
```

### Task 2: Navigation groups (`NavItem.children`)

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (`NavItem.children?: NavItem[]`), `packages/kernel/src/module/define.ts` (a child never has children; a parent has no `href` requirement: `href` of the group is `"#"`), `apps/web/src/lib/shell/nav.ts`, `packages/ui/src/shell/ModuleBar.tsx`, `packages/ui/src/shell/types.ts`, `packages/ui/src/styles/components.css`
- Test: `apps/web/src/lib/shell/nav.test.ts`, `packages/ui/src/shell/__tests__/module-bar.test.tsx`

**Interfaces:**
- Produces: a `NavItem` with `children` renders as a dropdown button in the items bar (prototype: `Maestros ▾`, 36 px row, items with icon and label, keyboard: Enter / Space opens, arrows move, Escape closes); the group is active when any child's href is active; `buildShellNav` keeps a group only with the children that pass their `feature` / `process` gates and drops an empty group; ⌘K lists the children, never the group.

- [ ] **Step 1: Write the failing tests**

```ts
it("drops children the caller may not open and the group when none is left", () => { /* buildShellNav with a module whose group has two children, one feature not entitled → one child; none entitled → no group */ });
it("renders a group as a dropdown that is active when a child route is active", () => { /* render ModuleBar with activeHref '/accounting/accounts' → button 'Maestros' has aria-current, menu closed; click → 6 items; Escape closes */ });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F web test -t nav && pnpm -F @erp/ui test -t module-bar`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/registry packages/kernel/src/module apps/web/src/lib/shell packages/ui/src/shell packages/ui/src/styles
git commit -m "feat(shell): navigation groups rendered as dropdowns in the items bar"
```

### Task 3: Record-tab contributions from manifests

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (`ModuleDef.recordTabs?: RecordTabContribution[]`), `packages/kernel/src/module/define.ts`, `packages/kernel/src/registry/index.ts` (`registry.recordTabsFor(entityId)`), `packages/ui/src/record/record-model.ts` (`RecordTabId` becomes `string`; `recordTabIds(entity, contributed)`), `apps/web/src/app/(app)/r/[entity]/[id]/page.tsx`, `apps/web/src/lib/records/load.ts`
- Create: `apps/web/src/app/(app)/r/[entity]/[id]/contributed-tab.tsx` (`kind: "grid"` renders a `DataGrid` over the contribution's `source` view filtered by `source_entity = <entity>` and `source_record_id = <id>`, read through `POST /api/grid/<view entity>`; `kind: "mapping"` renders one `EntityLookup` per role in `roles` bound to the entity named by `lookupEntity`, saving through `saveProcess` with the step-up prompt)
- Test: `packages/kernel/src/__tests__/module-loader.test.ts`, `apps/web/src/lib/records/__tests__/contributed-tabs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RecordTabContribution {
    id: string;                       // `<module>.<name>`
    label: string;                    // i18n key
    forEntities: "*" | string[];
    kind: "grid" | "mapping";
    feature: string;                  // entitlement gate
    /** grid: a registered query entity whose view has source_entity + source_record_id columns; shown only when it has rows for the record. */
    source?: string;
    /** mapping: the dimension template, `category:{id}` ({id} = the record id), the roles to map, the lookup entity and the save process. */
    dimension?: string; roles?: string[]; lookupEntity?: string; saveProcess?: string; consultProcess?: string;
  }
  registry.recordTabsFor(entityId: string): RecordTabContribution[]   // only modules the company has enabled are resolved by the page (entitlement check per contribution.feature)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("registers recordTabs and resolves them for '*' and for named entities", () => { /* registry.recordTabsFor('core.product_category') has both kinds; 'core.party' only the '*' one */ });
it("refuses a mapping contribution without roles or saveProcess", () => { expect(() => defineModule({ ...mod, recordTabs: [{ id: "m.x", label: "k", forEntities: ["core.party"], kind: "mapping", feature: "m.f" }] })).toThrow(/mapping contribution/); });
it("the record page lists a grid contribution only when the source view has rows for the record", async () => { /* loadRecord with a fake view: 0 rows → tab absent; 1 row → tab present with count */ });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test -t recordTabs && pnpm -F web test -t contributed`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src packages/ui/src/record "apps/web/src/app/(app)/r" apps/web/src/lib/records
git commit -m "feat(kernel): record-tab contributions (grid and mapping) declared by module manifests"
```

### Task 4: Report definitions, report route and report exports

**Files:**
- Create: `packages/kernel/src/reports/types.ts`, `packages/kernel/src/reports/define.ts`, `packages/kernel/src/reports/run.ts`, `packages/kernel/src/reports/index.ts`
- Modify: `packages/kernel/src/registry/index.ts` (`registerReport`, `report(id)`, `reports(module?)`), `packages/kernel/src/registry/types.ts` (`ModuleDef.reports?: ReportDef[]`), `packages/kernel/src/module/loader.ts`, `packages/kernel/src/exports/plan.ts` and `export.process.ts` (`source: { kind: "report"; id; params }`), `packages/kernel/src/saved-views/processes.ts` (entity may be `report:<id>`; state may carry `params`), `packages/kernel/src/index.ts`
- Create: `apps/web/src/app/api/report/[id]/route.ts` (`POST` body `{ params, state: GridState }` → `{ rows, total, aggregates? }`; 404 unknown, 403 not entitled or consult not runnable, 400 bad params)
- Test: `packages/kernel/src/__tests__/reports.test.ts` (unit), `apps/web/src/app/api/report/__tests__/report-route.test.ts` (integration), `packages/kernel/src/__tests__/exports.test.ts` (report export)

**Interfaces:**
- Produces:
  ```ts
  interface ReportColumn { field: string; label: string; type: FieldType; total?: "sum"; mono?: boolean; link?: { entity: string; idField: string } }
  interface ReportDef<P extends z.ZodObject = z.ZodObject> {
    id: string;              // `<module>.<name>`, e.g. accounting.trial_balance
    module: string; feature: string; label: string;   // i18n key report.<id>
    params: P;               // the parameter bar is generated from it (date, enum, ref, boolean, number)
    consult: string;         // consult process id, input { params: z.infer<P>; state: GridState }, output { rows, total, aggregates? }
    columns: ReportColumn[];
    /** Columns the footer totals (sum over the whole filter, from `aggregates`). */
    totals?: string[];
    /** PDF header: libro name; the company, NIT, parameters and "página x de y" are added by the writer. */
    pdfTitle?: string;
  }
  defineReport(def): ReportDef
  runReport(deps, caller, id, params, state): Promise<{ rows; total; aggregates? }>   // runProcess(def.consult, { params, state })
  // export: kernel.export.run input gains `source?: { kind: "report"; id: string; params: unknown }`; with it the plan reads rows by calling the consult in windows of EXPORT_PAGE_SIZE and the PDF carries pdfTitle, company, NIT, params, page x of y.
  ```
  Saved parameter sets: `kernel.saved_view.save` accepts `entity: "report:<id>"` and a state `{ params, filters?, sort?, columns?, pageSize? }`; role promotion as for grids.

- [ ] **Step 1: Write the failing tests**

```ts
it("defineReport refuses a consult that is not a consult process and a totals field that is not a column", () => { ... });
it("POST /api/report/:id runs the consult as the caller and refuses a caller without the consult", async () => { /* test module report over a fixed view; member role without consult → 403; admin → rows + total */ });
it("export of a report reads every window and writes the pdf header with company, NIT and params", async () => { /* 2500 rows → 3 consult calls; xlsx row count 2500; pdf first page text contains the NIT */ });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test -t reports && pnpm -F web test:integration -t report-route && pnpm -F @erp/kernel test -t "report export"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src apps/web/src/app/api/report
git commit -m "feat(kernel): report definitions with a report route, saved parameter sets and report exports"
```

### Task 5: Report page component (parameter bar, grid, totals, drill)

**Files:**
- Create: `packages/ui/src/report/ReportPage.tsx`, `packages/ui/src/report/ParamBar.tsx`, `packages/ui/src/report/report-model.ts`, `packages/ui/src/report/index.ts`
- Create: `apps/web/src/app/(app)/_components/report-route.tsx`, `apps/web/src/lib/reports/load.ts` (report def, columns translated, the caller's saved parameter sets, the default params)
- Test: `packages/ui/src/report/__tests__/ReportPage.test.tsx`, `packages/ui/src/report/__tests__/report-model.test.ts`

**Interfaces:**
- Consumes: `ReportDef`, `POST /api/report/:id`, `DataGrid` (phase 1) with `fetcher`, `GridFooter` sums, `SavedViewsMenu`.
- Produces: `<ReportPage report={ReportDefClient} initialParams onRowOpen />`: the parameter bar from `params` (quick ranges `Hoy · Este período · Este año` when the schema has `from`/`to` dates; the `level` select 1–8; dimension selects only when their `use_*` flag is on, passed in `report.hiddenParams`), the grid with the footer totals of `totals`, the export buttons calling `kernel.export.run` with `source: { kind: "report" }`, Guardar vista saving `{ params, ... }` under `report:<id>`; a column with `link` opens the record tab; `paramsToSearch(params)` / `paramsFromSearch(search)` keep the state in the URL (`?p=`).

- [ ] **Step 1: Write the failing tests**

```ts
it("builds the parameter bar from the schema and sends params with the grid state", async () => { /* schema { from: date, to: date, level: enum } → 3 controls; change level → fetcher called with params.level */ });
it("totals footer shows the aggregates of the columns in totals", () => { ... });
it("params round-trip through the URL", () => { expect(paramsFromSearch(paramsToSearch({ from: "2026-10-01", level: 4 }))).toEqual({ from: "2026-10-01", level: 4 }); });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/ui test -t "ReportPage|report-model"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/report "apps/web/src/app/(app)/_components/report-route.tsx" apps/web/src/lib/reports
git commit -m "feat(ui): report page with generated parameter bar, totals footer and saved parameter sets"
```

### Task 6: Grouped aggregates in the query builder and the grid route

**Files:**
- Modify: `packages/kernel/src/query/grid-state.ts` (`groupBy: z.union([z.string(), z.array(z.string().min(1).max(80)).max(3)]).optional()` normalised to `string[]` in `GridState`), `packages/kernel/src/query/build-query.ts` (`BuiltQuery.groupAggregateSql?: string`), `packages/kernel/src/query/run.ts` (`GridResult.groups?: GroupRow[]`), `apps/web/src/app/api/grid/[entity]/route.ts`, `packages/kernel/src/query/data-query.process.ts` (output gains `groups`)
- Test: `packages/kernel/src/__tests__/build-query.test.ts`, `apps/web/src/app/api/grid/__tests__/grid-route.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface GroupRow { level: number; keys: Record<string, unknown>; count: number; aggregates: Record<string, unknown> }  // level 1..n, keys of the first `level` groupBy fields; `<fn>:<field>` keys
  // groupAggregateSql: select g1, g2, g3, grouping(g1, g2, g3) as "grouping", count(*)::int as "count", <fn>(<expr>) as "<fn>:<field>"... from <view><where> group by rollup(g1, g2, g3) order by g1 nulls last, g2 nulls last, g3 nulls last
  // The grand total row (grouping = all) is dropped from `groups`: the footer keeps using `aggregates`. Rows of the page stay ordered by the group fields first (already so).
  ```
  `aggregates` may list several functions for one field; `aggregateApplies` unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it("groupBy as an array orders by the group fields and emits a rollup aggregate query", () => { const q = buildQuery(lineEntity, { filters: [], sort: [{ field: "date", dir: "asc" }], page: 1, pageSize: 50, groupBy: ["account_code", "cost_center_name"], aggregates: [{ field: "debit", fn: "sum" }, { field: "debit", fn: "avg" }] }, () => true); expect(q.sql).toMatch(/order by "account_code" asc nulls last, "cost_center_name" asc nulls last, "date" asc/); expect(q.groupAggregateSql).toMatch(/group by rollup\("account_code", "cost_center_name"\)/); expect(q.groupAggregateSql).toMatch(/sum\("debit"\) as "sum:debit", avg\("debit"\) as "avg:debit"/); });
it("refuses a fourth group level and a group on a masked field", () => { ... /bad_value/ ... /field_hidden/ });
it("a string groupBy still works as one level", () => { ... });
it("POST /api/grid returns groups with level, keys, count and aggregates, without the grand total row", async () => { /* 3 rows in two groups → groups length 2, each count, sum:amount */ });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test -t build-query && pnpm -F web test:integration -t grid-route`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/query "apps/web/src/app/api/grid"
git commit -m "feat(grid): grouped aggregates with up to three group levels in the query builder"
```

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

### Task 8: Posting engine core: roles, template schema, path resolver, composition

**Files:**
- Create: `packages/kernel/src/posting/roles.ts`, `packages/kernel/src/posting/template.ts`, `packages/kernel/src/posting/path.ts`, `packages/kernel/src/posting/compose.ts`, `packages/kernel/src/posting/provider.ts`, `packages/kernel/src/posting/index.ts`
- Modify: `packages/kernel/src/index.ts` (re-exports), `packages/kernel/src/registry/types.ts` (`ModuleDef.postingProvider?: PostingProvider`, `ModuleDef.postingRules?: DefaultPostingRule[]`, `ModuleDef.accountRoles?: string[]`), `packages/kernel/src/module/define.ts` (a default rule's template must parse; every role a template names is in the catalogue or in `accountRoles`)
- Test: `packages/kernel/src/posting/__tests__/path.test.ts`, `template.test.ts`, `compose.test.ts` (property tests with fast-check on balance and determinism)

**Interfaces:**
- Produces:
  ```ts
  export const ACCOUNT_ROLES = ["cash","bank","receivable","customer_advances","revenue","sales_returns","sales_discounts","vat_out","inc_out","vat_in","withholding_income_suffered","withholding_vat_suffered","withholding_ica_suffered","withholding_income_payable","withholding_vat_payable","withholding_ica_payable","inventory","inventory_adjustment","cogs","payable","supplier_advances","rounding","suspense","income_summary","current_year_profit","current_year_loss","retained_earnings","accumulated_losses","opening_equity"] as const;
  export type AccountRole = (typeof ACCOUNT_ROLES)[number];
  // template.ts (Zod, exported as RuleTemplate / RuleLine; exactly §5.2)
  RuleLine = { role?: string; account?: string; side: "debit"|"credit"; amount: string; amountCompany?: string; forEach?: string; dimension?: string; party?: string; costCenter?: string; openAuxiliary?: string; item?: string; businessUnit?: string; description?: string; taxCode?: string; taxRate?: string; taxBase?: string; reference?: string; dueDate?: string }  // role xor account
  RuleTemplate = { date?: string; description: string; party?: string; costCenter?: string; openAuxiliary?: string; item?: string; businessUnit?: string; currency?: string; exchangeRate?: string; source?: { entity: string; id: string }; lines: RuleLine[]; reverseOf?: { event: string; sourceId: string } | null }
  // path.ts: JSONPath subset — `$.a.b`, `$.a[*]` once per path, `$$.x` root inside forEach, literal strings without `$` pass through
  resolvePath(payload: unknown, path: string, item?: unknown): unknown      // throws PathError("invalid_path" | "multiple_wildcards")
  interpolate(text: string, payload: unknown, item?: unknown): string       // {{a.b}} relative to item, {{$$.a}} root; missing → ""
  // compose.ts
  interface EventRef { id: string; event: string; payload: unknown; createdAt: Date; chainId: string }
  interface ComposedLine { role?: string; accountCode?: string; dimension?: string; side: "debit"|"credit"; amountDoc: number; amountCompany: number; partyId?: string; costCenterId?: string; openAuxiliaryId?: string; itemId?: string; businessUnitId?: string; description?: string; taxCode?: string; taxRate?: number; taxBase?: number; reference?: string; dueDate?: string }
  interface ComposedEntry { date: string; description: string; currency: string; exchangeRate: number; partyId?: string; costCenterId?: string; openAuxiliaryId?: string; itemId?: string; businessUnitId?: string; source?: { entity: string; id: string }; lines: ComposedLine[]; roundingLine?: ComposedLine; sourceEventId: string; chainId: string }
  type ComposeResult = { ok: true; entry: ComposedEntry } | { ok: false; code: "invalid_template" | "unbalanced"; detail: string }
  composeEntry(template: RuleTemplate, event: EventRef, options: { tolerance: number; companyCurrency: string }): ComposeResult
  //   amounts half-up to 2 decimals in company currency (§10a.8); zero lines dropped; negative amount flips side; difference ≤ tolerance → roundingLine with role "rounding"; above → unbalanced
  // provider.ts: PostingProvider exactly §5.1 plus
  interface PostingRule { id: string; event: string; journalId: string; template: RuleTemplate; priority: number }
  interface ResolvedAccount { accountId: string; code: string }
  interface PostingFailure { eventId: string; event: string; eventDate: string; ruleId?: string; payload: unknown; code: PostingFailureCode; detail: string }
  type PostingFailureCode = "unbalanced"|"missing_account_mapping"|"closed_period"|"inactive_account"|"missing_party"|"missing_cost_center"|"missing_open_auxiliary"|"missing_item"|"missing_business_unit"|"inactive_dimension"|"invalid_template"|"no_journal"
  interface DefaultPostingRule { event: string; name: string; journalCode: string; template: RuleTemplate; priority?: number }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves dot paths, one wildcard and root access inside forEach", () => { expect(resolvePath(p, "$.totals.total")).toBe(119000); expect(resolvePath(p, "$.lines[*]")).toHaveLength(2); expect(resolvePath(p, "$$.number", p.lines[0])).toBe("FE-1"); expect(() => resolvePath(p, "$.a[*].b[*]")).toThrow(/multiple_wildcards/); });
it("interpolates {{path}} and leaves missing values empty", () => { expect(interpolate("Factura {{number}} · {{customer.legalName}}", p)).toBe("Factura FE-1 · Tiendas D1 S.A.S."); });
it("template schema refuses a line with both role and account, and forEach with a second wildcard", () => { ... });
it("composes the §5.4 invoice template into a balanced entry with one revenue line per invoice line and one tax line per tax", () => { const r = composeEntry(invoiceTemplate, invoiceEvent, { tolerance: 1, companyCurrency: "COP" }); expect(r.ok && r.entry.lines.map(l => [l.role, l.side, l.amountCompany])).toEqual([["receivable","debit",119000],["revenue","credit",50000],["revenue","credit",50000],["vat_out","credit",19000]]); });
it("balances a 0.5 COP difference through a rounding line and refuses 2 COP", () => { ... });
it.prop([entryArb])("every ok composition has sum debit = sum credit and is deterministic", (e) => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test -t "posting"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/posting packages/kernel/src/registry packages/kernel/src/module packages/kernel/src/index.ts
git commit -m "feat(kernel): posting engine core: role catalogue, rule template schema, path resolver, composition"
```

### Task 9: Posting engine consumer and confirmation-card effects

**Files:**
- Create: `packages/kernel/src/posting/engine.ts` (`postingConsumer(provider)`), `packages/kernel/src/posting/__tests__/engine.integration.test.ts` (fake provider recording calls)
- Modify: `packages/kernel/src/module/loader.ts` (a module with `postingProvider` must consume `"*"`; the loader wraps its `"*"` consumer with `postingConsumer(provider)` when the manifest's `consumes["*"]` is the exported `POSTING_CONSUMER` marker), `packages/agent/src/runtime/preview.ts` (`buildPreview` gains `effects` lines from `provider.effectsFor` for the events the process declares in `emits`; `ProcessDef.emits?: string[]` added to the registry type), `packages/kernel/src/registry/types.ts`

**Interfaces:**
- Consumes: Task 8 types; `ConsumerContext`.
- Produces: `kernel.admin.module.enable` refuses (`invalid_input`, "El pack del país no mapea los roles contables: …") a module whose `accountRoles` has a role the company pack's `defaultRoleMappings()` does not cover (§5.3; `packages/kernel/src/admin/modules.ts`). `postingConsumer(provider: PostingProvider): EventConsumer` — per event: `ledgerStartsOn` null or after the event date → acknowledge and `provider.countSkipped(ctx, eventId)` (added to the interface: increments the "eventos anteriores al inicio del libro" counter); else `rulesFor(event)` sorted by priority; per rule: `reverseOf` → `provider.reverse`, else `composeEntry` → resolve roles via `provider.resolveAccount(role, dimension)` with the §4.2 order → `provider.post(entry)`; a composition or resolution failure, or a `ProcessError` thrown by `provider.post` (the ledger's validation refusal, Task 20) → `provider.recordFailure` and continue with the next rule (the consumer resolves); any other thrown error propagates (retry). `ProcessDef.emits` lists the events a process writes to the outbox; the confirmation card shows `Contabilidad: asiento en <journal name>` lines from `effectsFor`.

- [ ] **Step 1: Write the failing tests**

```ts
it("acknowledges events dated before ledgerStartsOn without posting and counts them", async () => { ... });
it("posts one entry per matching rule in priority order and records a failure for a rule with a missing mapping without stopping the others", async () => { ... });
it("a reverseOf rule calls provider.reverse with the referenced event and source id", async () => { ... });
it("a connection error from provider.post propagates so the outbox retries; a ProcessError from provider.post is recorded as a failure", async () => { ... });
it("module.enable refuses a module whose accountRoles the pack does not map", async () => { ... });
it("the confirmation card of a process that emits invoicing.invoice.issued lists 'Contabilidad: asiento en Ventas'", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test:integration -t "posting engine" && pnpm -F @erp/agent test -t effects`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/posting packages/kernel/src/module packages/kernel/src/registry packages/agent/src/runtime
git commit -m "feat(kernel): posting consumer over the provider interface and accounting effects on confirmation cards"
```

---

## Part B · Colombia pack: accounting extension

### Task 10: `CountryPack.accounting`: chart, mappings, journals, layouts, validation, tax codes

**Files:**
- Modify: `packages/kernel/src/localization/country-pack.ts` (`CountryPack.accounting: AccountingPack`), `packages/kernel/src/localization/__tests__/country-pack.test.ts`
- Create: `packages/localization/co/data/puc.json` (PUC Decreto 2650 through subcuenta, generated once from the official list; header comment with the source), `packages/localization/co/src/accounting/chart.ts`, `role-mappings.ts`, `journals.ts`, `layouts.ts` (balance sheet, income statement, 2516 H2 / H3 line codes by prefix), `account-code.ts`, `fiscal-year.ts`, `tax-codes.ts`, `index.ts`
- Modify: `packages/localization/co/src/index.ts` (`co.accounting`)
- Test: `packages/localization/co/src/__tests__/accounting.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AccountSeed { code: string; name: string; nature: "debit"|"credit"; requiresParty: boolean; requiresCostCenter: boolean; statementSection?: string; isOpeningResult: boolean }
  interface AccountingPack {
    chartOfAccounts(): AccountSeed[];                                  // classes 1–9 to subcuenta; requiresParty on 13, 22, 23, 24, 25, 28; requiresCostCenter on classes 4–7; isOpeningResult on 3605, 3705, 3710
    defaultRoleMappings(): { role: string; dimension?: string; code: string }[];   // §5.9 list, plus suspense → 238095 and rounding → 530595 (call: 238095 "Partidas por aclarar" is an auxiliary the seed creates under 2380)
    extraAccounts(): AccountSeed[];                                    // auxiliaries the mappings need and the PUC does not list (238095, 530595)
    validateAccountCode(code: string, parentCode?: string): { ok: true; level: "class"|"group"|"account"|"subaccount"|"auxiliary" } | { ok: false; reason: string }
    fiscalYearFor(date: string): { year: number; startsOn: string; endsOn: string }
    statementLayouts(): { balanceSheet: StatementSection[]; incomeStatement: StatementSection[]; f2516: { esf: LineCode[]; eri: LineCode[] } }
    defaultJournals(): { code: string; name: string; kind: JournalKind; manualEntries: boolean }[]   // NC, VT, CP, RC, CE, AP, CI
    taxCodes(): { code: string; family: "IVA"|"INC"|"RTEFTE"|"RTEIVA"|"RTEICA"; rate: number | null; label: string }[]
    defaultConceptMappings(): { format: string; concept: string; code: string }[]   // Task 11 fills it
    exogenaFormats(year: number): ExogenaFormat[]                                    // Task 11
    exogenaXml(format: ExogenaFormat, rows: ExogenaRow[], company: ExogenaCompany): string   // Task 11
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("the chart has every class, group and account of the PUC and flags parties and cost centers per §10.3", () => { const c = co.accounting.chartOfAccounts(); expect(c.find(a => a.code === "130505")).toMatchObject({ nature: "debit", requiresParty: true, requiresCostCenter: false }); expect(c.find(a => a.code === "510506")).toMatchObject({ requiresCostCenter: true }); expect(c.find(a => a.code === "3605")?.isOpeningResult).toBe(true); });
it("every account role of the kernel catalogue has a default mapping and every mapped code exists in the chart or in extraAccounts", () => { ... });
it("validateAccountCode accepts 13050501 under 130505 and refuses 1306 under 1305, letters, and a child not prefixed by its parent", () => { ... });
it("fiscalYearFor is the calendar year and the journals are the seven of §4.3", () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/loc-co test -t accounting && pnpm -F @erp/kernel test -t country-pack`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/localization packages/localization/co
git commit -m "feat(loc-co): accounting pack: PUC chart, role mappings, journals, layouts, code validation, tax codes"
```

### Task 11: Exógena catalogue, concept mappings and XML writer

**Files:**
- Create: `packages/localization/co/data/exogena-2026.json` (formats 1001, 1003, 1005, 1006, 1007, 1008, 1009: version, concepts, columns, threshold, cuantías-menores NIT `222222222`), `packages/localization/co/src/accounting/exogena.ts`, `packages/localization/co/src/accounting/exogena-xml.ts`, fixtures `packages/localization/co/src/__tests__/fixtures/exogena/*.xml`
- Test: `packages/localization/co/src/__tests__/exogena.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ExogenaFormat { format: string; version: number; year: number; side: "debit"|"credit"|"balance"; threshold: number; concepts: { code: string; label: string }[]; columns: { id: string; label: string; source: "amount"|"tax:RTEFTE"|"tax:RTEIVA"|"tax:RTEICA"|"base"|"balance" }[] }
  interface ExogenaRow { concept: string; partyDocumentType: string; partyDocument: string; partyDv?: string; partyName: string; departmentCode?: string; municipalityCode?: string; countryCode: string; values: Record<string, number> }
  interface ExogenaCompany { nit: string; dv: string; name: string; year: number }
  defaultConceptMappings(): e.g. { format: "1001", concept: "5001", code: "5105" }, { "1001","5002","5110" }, { "1001","5004","5135" }, { "1001","5005","5120" }, { "1001","5007","1435" }, { "1006","4001","41" }, { "1008","1315","1305" }, { "1009","2201","2205" } …
  exogenaXml(format, rows, company): string   // the prevalidador layout: <mas> header with Ano, CodCpt, Formato, Version, NumEnvio, FecEnvio, FecInicial, FecFinal, ValorTotal, CantReg; one <formato1001> row per line
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("lists the seven formats of 2026 with their side, threshold and the 222222222 NIT", () => { ... });
it("writes the 1001 XML the prevalidador accepts for two rows (fixture byte-equal) and counts CantReg and ValorTotal", () => { ... });
it("every default concept mapping names a format and concept of the catalogue and a code of the chart", () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/loc-co test -t exogena`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/localization/co
git commit -m "feat(loc-co): exógena catalogue 2026, default concept mappings and prevalidador XML writer"
```

---

## Part C · Accounting module: schema and masters

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

### Task 13: Ledger migration: entries, lines, rules, failures, templates, close checks

**Files:**
- Create: `supabase/migrations/0026_accounting_ledger.sql`: `entries` (§4.6; `number text`, `status text check (status in ('draft','pending','posted','reversed','voided'))`, `origin text check (origin in ('manual','auto','import','template'))`, `unique (company_id, source_event_id, posting_rule_id) where source_event_id is not null`, `unique (company_id, journal_id, number) where number is not null`, `is_auto_reversal boolean`), `entry_lines` (§4.7, `unique (entry_id, line_no)`, `check ((debit = 0) <> (credit = 0))`), `posting_rules` (§4.8, template jsonb), `posting_failures` (§4.9), `entry_templates` + `entry_template_lines` (§4.10), `period_close_checks` (§4.14, append-only: `kernel.audit_log_immutable`-style trigger refusing update and delete), `skipped_events` (`company_id, outbox_id unique`, the "eventos anteriores al inicio del libro" counter); function `accounting.next_entry_number(p_journal uuid) returns text` (`select … for update`, returns `<code>-<n>`, security definer, execute granted to authenticated), trigger `entries_totals` (sum of lines into `total_debit / total_credit` on line insert/update/delete while draft), trigger `entry_lines_frozen` (refuses a line change unless the entry is `draft`, `erp:invalid_input:` message), masked views for the five entities; indexes `(company_id, date)`, `(company_id, journal_id, number)`, `(company_id, status)`, `entry_lines (company_id, account_id)`, `(company_id, party_id)`, one per dimension column, `(entry_id)`.
- Test: `packages/modules/accounting/src/__tests__/ledger-schema.integration.test.ts`, `views.test.ts` (extended)

- [ ] **Step 1: Write the failing tests**

```ts
it("next_entry_number is gap-free under 20 concurrent calls on one journal", async () => { /* Promise.all of 20 selects in separate transactions → NC-1 … NC-20, no duplicate */ });
it("a line with both sides or neither is refused; lines of a posted entry cannot change", async () => { ... });
it("entries.total_debit follows the lines; the unique index refuses a second entry for one (event, rule)", async () => { ... });
it("period_close_checks refuses update and delete", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, write the migration, run to verify they pass**

Run: `supabase db reset && pnpm -F @erp/module-accounting test:integration -t "ledger-schema" && pnpm -F @erp/module-accounting test -t views`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0026_accounting_ledger.sql packages/modules/accounting
git commit -m "feat(accounting): ledger schema: entries, lines, posting rules and failures, templates, close checks"
```

### Task 14: Chart seed, accounts, journals, fiscal years and settings processes

**Files:**
- Create: `packages/modules/accounting/src/processes/common.ts` (`companyPack`, `settingsOf(ctx)`, `refuseDuplicate`, `rejectErrors`, `accountByCode`, `requireLeafDimension(ctx, dim, id)`), `src/processes/chart.ts` (`accounting.chart.seed`), `src/processes/account.ts` (`account.create / update / consult`), `src/processes/journal.ts`, `src/processes/fiscal-year.ts` (`fiscal_year.open / consult`, `period.consult`), `src/processes/settings.ts` (`settings.update / consult`)
- Test: `src/__tests__/chart.integration.test.ts`, `account.integration.test.ts`, `settings.integration.test.ts`

**Interfaces:**
- Produces:
  - `accounting.chart.seed` (create, step-up, feature `accounting.posting`, admin only): from `companyPack(ctx).accounting`: inserts missing accounts (chart + extraAccounts), role mappings, journals, concept mappings, `settings` row (`ledger_starts_on = today`), the fiscal year of today with 12 periods, and the default posting rules of every loaded module's `postingRules` plus the accounting fixtures (Task 20); idempotent, never overwrites an existing row; output `{ accounts, mappings, journals, rules, year }` counts.
  - `accounting.account.create` input `{ code, name, nature?, requiresParty?, requiresCostCenter?, requiresOpenAuxiliary?, requiresItem?, requiresBusinessUnit?, statementSection?, extra?, extraFree? }`: parent = longest existing prefix; refused when the parent has lines (`invalid_input`, "La cuenta padre ya tiene movimientos"), when the code fails `validateAccountCode`, or when the level is above `subaccount` for a company-made account (only auxiliaries, `allows_movement = true`, §10.2). `account.update` may change name, flags, `is_active` (refused false while a draft has lines on it), never `code`; `consult` reads `v_accounts`.
  - `accounting.journal.create / update / consult` (§4.3; `kind`, `manual_entries`; `next_number` never editable).
  - `accounting.fiscal_year.open` input `{ year }`: refuses when the previous year is not open or closed (gap), creates 12 periods from `fiscalYearFor`; `period.consult`, `fiscal_year.consult`.
  - `accounting.settings.update` (step-up) input partial of §4.11 (`useOpenAuxiliaries`, `useItems`, `useBusinessUnits`, `requireApprovalOnManual`, `roundingTolerance`, `manualJournalId`, `requireAttachmentOnManual`, `niifGroup`); `settings.consult`.

- [ ] **Step 1: Write the failing tests**

```ts
it("chart.seed installs the PUC, mappings, seven journals, concept mappings, settings and the current year, and a second run adds nothing", async () => { const a = await runProcess(deps, admin, "accounting.chart.seed", {}); const b = await runProcess(...); expect(b).toEqual({ accounts: 0, mappings: 0, journals: 0, rules: 0, year: 0 }); const [s] = await sql`select ledger_starts_on, rounding_tolerance, niif_group from accounting.settings where company_id = ${companyId}`; expect(s).toMatchObject({ rounding_tolerance: "1.0000", niif_group: "2" }); });
it("chart.seed without step-up is refused", async () => { ... step_up_required });
it("account.create 13050501 under 130505 is an active auxiliary; 1306 and a child of an account with lines are refused", async () => { ... });
it("fiscal_year.open 2027 after 2026 creates 12 periods; 2028 is refused while 2027 is missing", async () => { ... });
it("settings.update toggles use_items under step-up and refuses a negative tolerance", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "chart|account|settings|fiscal"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): chart seed from the pack, account, journal, fiscal year and settings processes"
```

### Task 15: Analytic dimension processes (one factory for four masters)

**Files:**
- Create: `packages/modules/accounting/src/processes/dimension.ts` (`dimensionProcesses(dim: DimensionDef)` returning `create / update / consult` for `cost_center`, `open_auxiliary`, `item`, `business_unit`), `src/dimensions.ts` (`DIMENSIONS` table: entity id, table, settings flag, i18n noun)
- Test: `src/__tests__/dimension.integration.test.ts` (runs the same cases against the four)

**Interfaces:**
- Produces: `accounting.<dim>.create` input `{ code, name, parentId?, kind: "group" | "leaf", isActive?, extra?, extraFree? }`: parent must be a `group` of the same dimension; `update` may rename, re-parent (no cycles), deactivate, change `kind` only when the node has no lines (leaf → group) and no children (group → leaf); `consult` reads the masked view. `requireLeafDimension(ctx, dim, id)` (common.ts) throws `invalid_input` `inactive_dimension` or "debe ser una hoja" for groups; used by the entry validation of Tasks 18–19 and by the provider.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(DIMENSIONS)("%s: creates a group and a leaf, refuses a leaf parent, a cycle and a group→leaf with children", async (dim) => { ... });
it("a leaf with posted lines cannot become a group or be deleted, only deactivated; an inactive leaf is refused on a new line", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t dimension`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): analytic dimensions (centro de costo, auxiliar abierto, ítem, unidad de negocio) with one process factory"
```

### Task 16: Account role mappings, account permissions and concept mappings

**Files:**
- Create: `packages/modules/accounting/src/processes/mapping.ts` (`account_role_mapping.update / consult`), `src/processes/permission.ts` (`account_permission.update / consult`), `src/processes/concept-mapping.ts` (`fiscal_concept_mapping.update / consult`)
- Test: `src/__tests__/mapping.integration.test.ts`, `permission.integration.test.ts`

**Interfaces:**
- Produces:
  - `accounting.account_role_mapping.update` (step-up) input `{ mappings: { role, dimension?, accountId | null }[] }` (null removes); every role in `ACCOUNT_ROLES` or a loaded module's `accountRoles`; the account must `allows_movement`; `consult` returns every mapping with the unmapped roles listed (`unmapped: string[]`).
  - `accounting.account_permission.update` (step-up, admin only, `kernel.is_company_admin()`) input `{ accountId, access: "open" | "restricted", grants: { subjectKind: "role" | "user", subjectId, canView, canPost }[] }`, `canPost` implies `canView`; replaces the account's grants; audit diff before/after. `consult` input `{ accountId }` → `{ access, effective: "open" | "restricted", inheritedFrom?: accountId, grants }`; input `{ subjectKind, subjectId }` → the subject's grants (Cuentas tab on roles and users).
  - `accounting.fiscal_concept_mapping.update` (step-up) input `{ mappings: { format, concept, accountId, isActive? }[] }`, one concept per account and format; `consult` input `{ format, year }` → concepts with their accounts and the unmapped accounts with movement in the year.

- [ ] **Step 1: Write the failing tests**

```ts
it("maps revenue category:<id> to 413520 and resolves (role, dimension) before (role, null); an account without movement allowance is refused", async () => { ... });
it("restricting 5105 for contador (view+post) hides 510506 from auxiliar in v_accounts and from the lookup, and a non-admin cannot update permissions", async () => { ... });
it("a user grant on 5105 overrides the role grant; removing the restriction opens the subtree again", async () => { ... });
it("concept mapping refuses two concepts for one account in one format and lists unmapped accounts with movement", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "mapping|permission"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): role mappings, security by account grants and exógena concept mappings"
```

---

## Part D · Entries, engine integration and periods

### Task 17: Published views and the ledger-line query view

**Files:**
- Create: `supabase/migrations/0027_accounting_views.sql`: `accounting.v_entry_lines` (masked view of Task 13 redefined: a restricted line, `not accounting.can_view_account(account_id)`, returns its row with `account_id`, `debit`, `credit`, `tax_base`, `party_id`, the dimension ids and `description` as null and `is_restricted = true`, so the record shows `••••` and totals stay), `v_account_balances` (§4.12, posted lines only, `where accounting.can_view_account(account_id)`), `v_entries_for_source`, `v_tax_lines`, `v_open_items` (FIFO function `accounting.open_items(p_company uuid, p_as_of date)` returning the §4.12 columns; the view calls it for `current_date`; receivable accounts = `requires_party` under the pack's class 13 prefixes, payable under 22 and 23, read from `account_role_mappings` roles `receivable` / `payable` ancestors), `v_ledger_lines` (§4.16 columns, posted and unposted lines, `where accounting.can_view_account(account_id)`, party columns from `core.v_parties`), indexes used by the FIFO.
- Modify: `packages/modules/accounting/src/entities.ts` (`accounting.ledger_line` fields exactly §4.16; `defaultSort { date asc }`; `debit`, `credit`, `net`, `signed_net`, `tax_base` type `money`)
- Test: `src/__tests__/views.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("v_ledger_lines hides restricted lines for a user without view and shows them to one with view; row counts differ by the restricted lines", async () => { ... });
it("v_entry_lines masks a restricted line (nulls + is_restricted) while the entry totals stay", async () => { ... });
it("v_account_balances aggregates posted lines only, per period and dimension", async () => { ... });
it("open_items applies receipts FIFO by due date per party and account", async () => { /* invoices 100 (due d1), 200 (due d2); receipt 150 → open 0 and 150 */ });
it("tenant isolation: company B sees no row of company A in any of the five views", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, write the migration, run to verify they pass**

Run: `supabase db reset && pnpm -F @erp/module-accounting test:integration -t "views"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0027_accounting_views.sql packages/modules/accounting
git commit -m "feat(accounting): published views, FIFO open items and the ledger-line query view with account security"
```

### Task 18: Entry drafts: create, update, void, consult, from_template, templates

**Files:**
- Create: `packages/modules/accounting/src/processes/entry-validate.ts` (`validateLines(ctx, entry, lines, mode: "draft" | "post"): Promise<Refusal[]>` — the §5.5 rules; `Refusal = { code: PostingFailureCode | "account_forbidden" | "same_user_approval" | "manual_journal_only"; lineNo?: number; detail: string }`; Spanish details naming the account code), `src/processes/entry.ts` (`entry.create / update / void / consult`, `entry_line.consult`), `src/processes/template.ts` (`entry_template.create / update / consult`, `entry.from_template`)
- Test: `src/__tests__/entry-draft.integration.test.ts`, `template.integration.test.ts`

**Interfaces:**
- Produces:
  - `EntryInput = { journalId?, date, description, currency?: "COP", exchangeRate?: 1, businessUnitId?, reverseOn?, partyId?, lines: LineInput[], extra?, extraFree? }`, `LineInput = { accountId? | accountCode?, partyId?, costCenterId?, openAuxiliaryId?, itemId?, businessUnitId?, description?, debit, credit, taxCode?, taxRate?, taxBase?, reference?, dueDate? }`.
  - `accounting.entry.create` (create, `origin manual`; the assistant's and the UI's path; `journalId` defaults to `settings.manual_journal_id`; journal must have `manual_entries`; lines validated in `draft` mode: accounts exist, `can_post_account` for every line (`account_forbidden` names the code), dimensions leaves and active, at least one line allowed empty while draft) → `{ id }`. `entry.update` (draft or pending → draft; replaces header and lines). `entry.void` (draft or pending only, records `void_reason` in `extra`), `entry.consult` (header + lines through `v_entries` / `v_entry_lines`, restricted lines masked), `entry_line.consult`.
  - `accounting.entry_template.create / update / consult` (§4.10), `accounting.entry.from_template` input `{ templateId, date, amounts?: Record<lineNo, number>, description? }` → a draft (`origin template`).

- [ ] **Step 1: Write the failing tests**

```ts
it("creates a draft in NC with two lines, no number, totals by trigger; update replaces lines; void keeps the row with status voided", async () => { ... });
it("refuses a line on a forbidden account by name, an inactive leaf, a group node and a journal without manual entries", async () => { await expect(runProcess(deps, auxiliar, "accounting.entry.create", draft({ accountCode: "510506" }))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("510506")] }); });
it("from_template creates a draft with the template's lines, header business unit and the amounts given", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "entry-draft|template"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): entry drafts, voids, templates and the shared line validation"
```

### Task 19: Post, submit, four-eyes, auto-reversal, reverse, opening balances

**Files:**
- Create: `packages/modules/accounting/src/processes/entry-post.ts` (`entry.submit`, `entry.post`, `entry.reverse`, internal `postEntry(ctx, entryId, opts)` shared with Task 20's `post_from_event`), `src/processes/opening.ts` (`opening.create`, `opening.post`)
- Test: `src/__tests__/entry-post.integration.test.ts`, `opening.integration.test.ts`

**Interfaces:**
- Produces:
  - `postEntry(ctx, entryId, { origin: "human" | "event"; skipFourEyes?: boolean })`: locks the entry; `validateLines(mode: "post")` (balanced after the rounding line: difference ≤ `rounding_tolerance` adds a line on role `rounding`, above → `unbalanced`; period open and, when `reopened_for` is set, `date = reopened_for` else `closed_period`; account active and `allows_movement`; party where required; each dimension where required, business unit resolved from the header and **stored on every line**; journal active); four-eyes when `require_approval_on_manual` and origin human and entry origin ≠ `auto`: status must be `pending` and `ctx.userId ≠ created_by` (`same_user_approval`); assigns `number` via `next_entry_number`, `period_id`, `posted_at/by`, status `posted`; when `reverse_on` is set creates the mirrored draft (`is_auto_reversal`, `reversal_of_id`, same journal, dated `reverse_on`) once (unique partial index on `reversal_of_id where is_auto_reversal`); when posting an auto-reversal marks the original `reversed`; emits `accounting.entry.posted`.
  - `accounting.entry.submit` (manual drafts only → `pending`, `submitted_by/at`, emits `accounting.entry.submitted`); `accounting.entry.post` input `{ id }` (humans and assistant; `pending` or, with four-eyes off, `draft`); `accounting.entry.reverse` input `{ id, date?, reason }` → new posted entry mirroring the lines, links both ways, original `reversed`, emits `accounting.entry.reversed`; idempotency key `reverse:<id>`.
  - `accounting.opening.create` input `{ date?, lines: { accountCode, partyDocument?, costCenterCode?, openAuxiliaryCode?, itemCode?, businessUnitCode?, debit, credit }[] }` → draft in AP with `is_opening`, dated `ledger_starts_on`; `accounting.opening.post` (step-up) = `postEntry` with `skipFourEyes`.

- [ ] **Step 1: Write the failing tests**

```ts
it("posts a balanced draft: NC-1, period set, lines carry the header business unit, event emitted; a second post is refused", async () => { ... });
it("post refuses: unbalanced above tolerance, 0.5 COP rounds to 530595, closed period, missing party on 130505, missing cost center on 510506, group dimension", async () => { ... });
it("four-eyes: creator cannot post own pending entry (same_user_approval); contador can; engine posting (origin event) ignores it", async () => { ... });
it("reverse_on creates exactly one mirrored draft dated reverse_on, also when post is replayed; posting it marks the original reversed", async () => { ... });
it("entry.reverse mirrors lines, links both ways and dates in an open period; reversing a reversed entry is refused", async () => { ... });
it("opening.create resolves codes and documents into a draft in AP with is_opening; opening.post needs step-up", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "entry-post|opening"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): posting with validations, four-eyes approval, auto-reversing accruals, reversals and opening balances"
```

### Task 20: Posting provider, `post_from_event`, failures, rules processes and default rule fixtures

**Files:**
- Create: `packages/modules/accounting/src/posting/provider.ts` (`accountingProvider: PostingProvider`), `src/processes/post-from-event.ts` (`entry.post_from_event`, `posting_failure.record`, both `origins: ["event"]`), `src/processes/posting-rule.ts` (`posting_rule.create / update / disable / test`, `posting_rule.sync_defaults`), `src/processes/posting-failure.ts` (`posting.retry`, `posting_failure.dismiss / consult`), `src/rules/defaults/*.json` (the §5.4 templates: `invoicing.invoice.issued`, `invoicing.note.issued` credit and debit, `invoicing.invoice.voided`, `costing.cogs.posted`, `inventory.movement.posted` adjustment, `payments.received`, `payments.payment.voided`, `kernel.import.opening_balances`) and `src/rules/defaults.ts`, `src/rules/fixtures/*.json` (one sample payload per event, the Café del Norte figures of the prototype)
- Modify: `src/index.ts` (`postingProvider: accountingProvider`, `postingRules: ACCOUNTING_DEFAULT_RULES`)
- Test: `src/__tests__/posting.integration.test.ts` (real outbox rows through `drainOutbox` + `dispatchOutboxRow` with the workflow test world, as `dispatch.integration.test.ts` does)

**Interfaces:**
- Produces:
  - `accountingProvider`: `rulesFor` reads active `posting_rules` of the company for the event; `resolveAccount(role, dimension)` the §4.2 order; `ledgerStartsOn` from `settings`; `post(entry)` → `ctx.runProcess("accounting.entry.post_from_event", { entry, ruleId, eventId })`; `reverse(ref)` finds the posted entry by `(source_entity, source_record_id, event)` and runs `entry.reverse` (origin event); `recordFailure` → `posting_failure.record`; `effectsFor(event)` → `["Contabilidad: asiento en <journal name>"]` per active rule; `countSkipped` inserts into `skipped_events`.
  - `accounting.entry.post_from_event` (update, `origins: ["event"]`, `idempotencyKey: posting:<eventId>:<ruleId>`): creates the entry with `origin auto`, `source_event_id`, `posting_rule_id`, `source_entity/record_id`, `chain_id = ctx.chainId`, then `postEntry(origin: "event")`; a validation refusal throws `ProcessError("invalid_input")` with `details: [code, detail]`, so the transaction rolls back, no idempotency row is stored and `posting.retry` can run the same key again; the engine consumer (Task 9) catches it and records the failure through `posting_failure.record`.
  - `accounting.posting_rule.create / update` (step-up) input `{ event, name, description?, journalId, template, priority?, isActive? }` validated by `RuleTemplate`; `update` sets `is_modified`; `disable`; `posting_rule.test` (consult) input `{ ruleId, outboxId }` → the `ComposedEntry` with resolved codes or the failure; `posting_rule.sync_defaults` (normal, idempotent): copies every loaded module's `postingRules` (and the accounting fixtures) into the company where the `(event, name)` is missing, never touching modified rules; `chart.seed` calls it.
  - `accounting.posting.retry` input `{ failureId }` → re-runs the rule on the stored payload with the same idempotency key, marks `resolved` with `resolved_entry_id`; `posting_failure.dismiss` input `{ failureId, reason }`; `posting_failure.consult`.

- [ ] **Step 1: Write the failing tests**

```ts
it("an invoicing.invoice.issued outbox row posts the Ventas entry with receivable, revenue per category mapping and vat_out per tax, on the event's chain, origin event", async () => { ... });
it("post_from_event: redelivered event answers the first entry (one row for the event and rule); two rules on one event make two entries, one each", async () => { ... });
it("a missing mapping records a posting_failure missing_account_mapping, emits accounting.posting.failed and acknowledges the row; posting.retry after mapping resolves it with the same idempotency key", async () => { ... });
it("an event dated before ledger_starts_on is counted in skipped_events and posts nothing", async () => { ... });
it("reverseOf rule posts in the note's own period: invoice in a closed October, void dated in open November → reversal dated in November, October untouched", async () => { ... });
it("post_from_event from origin ui is forbidden and never appears in the sensitive processes list", async () => { ... });
it("posting_rule.test previews the entry for a past event without writing; update under step-up marks is_modified; sync_defaults restores nothing modified", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t posting`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): posting provider, engine write path with idempotency, failures inbox and default rules"
```

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

---

## Part E · Reports and the ledger-line query

### Task 22: Statement reports: balance de prueba, mayor y balances, situación financiera, resultados, centros de costo

**Files:**
- Create: `packages/modules/accounting/src/reports/common.ts` (`balancesCte(params)`: the SQL over `v_account_balances` + the restricted aggregation: accounts the caller may not view are summed into one row `account_code = '🔒'`, `account_name = report.restricted_accounts` with `n`; `statementTotals`), `src/reports/trial-balance.ts`, `ledger.ts` (mayor y balances), `balance-sheet.ts`, `income-statement.ts`, `cost-center-statement.ts`, `src/reports/index.ts` (`ACCOUNTING_REPORTS: ReportDef[]`)
- Test: `src/__tests__/reports-statements.integration.test.ts`

**Interfaces:**
- Produces (each a `ReportDef` + its consult process, feature `accounting.ledger`):
  - `accounting.trial_balance` params `{ from: periodId, to: periodId, level: 1..8 (default 4), costCenterId?, openAuxiliaryId?, itemId?, businessUnitId?, partyId?, includeOpening: true, includeClosing: false, onlyWithMovement: true }`; columns `account_code, account_name, opening_debit, opening_credit, debit, credit, closing_debit, closing_credit`; totals on the six money columns; row link → `account_detail` with the same params.
  - `accounting.ledger` (Libro mayor y balances) params `{ period, level }`; columns as above; `pdfTitle: "Libro mayor y balances"`.
  - `accounting.balance_sheet` params `{ asOfPeriod, comparePrevious: true, level }`; rows by `statementLayouts().balanceSheet` sections with subtotals; `assets = liabilities + equity` asserted in the footer row `Diferencia`.
  - `accounting.income_statement` params `{ from, to, byCostCenter: false, comparePrevious: false, level }`; `accounting.cost_center_statement` params `{ from, to, nodeId? }` by cost center tree.
  - Dimension parameters are hidden (`hiddenParams`) while their `use_*` flag is off.

- [ ] **Step 1: Write the failing tests**

```ts
it("trial balance equals the ledger: per account, opening + movement = closing; totals debit = credit; level 2 sums level 4", async () => { ... });
it("trial balance aggregates restricted accounts, totals equal: as auxiliar one row '🔒' with n = 1 and the admin's totals; as admin the detail", async () => { ... });
it("balance sheet at October: assets = liabilities + equity + result; comparative column from December previous year", async () => { ... });
it("income statement by cost center: the sum of the cost center columns equals the total column; opening and closing lines excluded", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "reports-statements"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): statement reports with level, dimensions and the aggregated restricted-accounts row"
```

### Task 23: Line reports: libro diario, auxiliar por cuenta, por tercero, por dimensión analítica

**Files:**
- Create: `packages/modules/accounting/src/reports/journal-book.ts`, `account-detail.ts`, `party-detail.ts`, `dimension-detail.ts`
- Test: `src/__tests__/reports-lines.integration.test.ts`

**Interfaces:**
- Produces: `accounting.journal_book` params `{ from: date, to: date, journalId? }` (`pdfTitle "Libro diario"`); `accounting.account_detail` params `{ accountId, from, to, partyId?, costCenterId?, openAuxiliaryId?, itemId?, businessUnitId? }` with a running balance column and the opening balance row; a restricted account answers `ProcessError("forbidden", …, { details: ["Sin acceso"] })`; `accounting.party_detail` params `{ partyId, accountIds?, from, to }`; `accounting.dimension_detail` params `{ dimension: "cost_center"|"open_auxiliary"|"item"|"business_unit", nodeId, from, to, accountId? }` rows by account with debit, credit, net, descendants included. Every line report reads `v_ledger_lines` and returns `omitted` (restricted lines count) in `aggregates`, which the report page shows as `🔒 n movimientos en cuentas restringidas omitidos`.

- [ ] **Step 1: Write the failing tests**

```ts
it("journal book lists every posted line of the range in date, number, line order; totals equal; restricted lines omitted and counted for auxiliar", async () => { ... });
it("account detail running balance ends at the trial balance closing; a restricted account is refused with Sin acceso", async () => { ... });
it("dimension detail for a group node equals the sum of its leaves and the ledger for the same filter", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "reports-lines"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): libro diario and auxiliares por cuenta, tercero y dimensión analítica"
```

### Task 24: Control reconciliation, manual entries audit, aging, exógena and its XML

**Files:**
- Create: `packages/modules/accounting/src/reports/control-reconciliation-report.ts`, `manual-entries-audit.ts`, `aging.ts`, `exogena.ts`, `src/processes/exogena-xml.ts` (`accounting.report.exogena_xml`, consult, returns `{ fileName, xml }` or refuses with the error list)
- Test: `src/__tests__/reports-controls.integration.test.ts`, `exogena.integration.test.ts`

**Interfaces:**
- Produces: `accounting.control_reconciliation` params `{ asOf }` rows `{ control: "receivable"|"payable"|"inventory"|"suspense"|"rounding", subject (party or warehouse), ledger, subledger, difference }`; `accounting.manual_entries_audit` params `{ from, to, roundThreshold: 1000000 }` rows with creator, submitter, poster, timestamps, `posted_after_close`, `round_amount`, attachments, lines, amount; `accounting.aging` params `{ kind: "receivable"|"payable", asOf, buckets: [30, 60, 90] }` rows per party `{ party, not_due, b1, b2, b3, over, total }` from `accounting.open_items(company, asOf)`; `accounting.exogena` params `{ year, format, threshold? }` rows per party and concept with the format's columns, `aggregates.errors: string[]` (unmapped accounts with movement, lines without party, parties missing DANE or document type), parties under the threshold aggregated under `222222222`; movement counted on the format's side only, opposite side only for reversals and credit notes, opening entries excluded from movement formats and included in 1008 / 1009 (§5.11). `accounting.report.exogena_xml` input `{ year, format }` refuses while errors exist.

- [ ] **Step 1: Write the failing tests**

```ts
it("aging totals per party equal the account's balance for that party at as_of; buckets by days after due_date", async () => { ... });
it("control reconciliation shows a difference when a receivable line has no due date party match and zero when tied; suspense row shows the open balance", async () => { ... });
it("manual entries audit lists only non-automatic posted entries with the round flag at 1 000 000 and posted_after_close", async () => { ... });
it("exógena 1001 per-party totals equal the mapped accounts' debit movement, COGS credits to 1435 never count, opening excluded; 1008 includes opening; small parties aggregate under 222222222; XML refuses while an account is unmapped", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "reports-controls|exogena"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting
git commit -m "feat(accounting): control reconciliation, manual entries audit, aging and exógena with XML export"
```

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

---

## Part F · User interface

### Task 26: Tree pane and the analytic master page (Tabla · Árbol) for five masters

**Files:**
- Create: `packages/ui/src/tree/TreePane.tsx` (search, expand by level, figure beside each node, lock icon for restricted nodes, keyboard: arrows, Enter), `packages/ui/src/tree/tree-model.ts` (`buildTree(rows, { idField, parentField })`, `expandToLevel`, `filterTree(query)`), `packages/ui/src/tree/index.ts`
- Create: `apps/web/src/app/(app)/accounting/_components/master-page.tsx` (`<MasterPage entity view="table"|"tree" />`: toggle remembered in `kernel.user_prefs` key `master_view:<entity>`; Tabla = `DataGrid`; Árbol = `TreePane` + `DataGrid` of the selected node's children; period selector feeding the figure: accounts → balance (`v_account_balances`), cost centers → result, other dimensions → net movement), `apps/web/src/app/(app)/accounting/accounts/page.tsx` (toolbar Nueva cuenta auxiliar enabled under a subcuenta, Importar, quick filter Restringidas, Seguridad column), `cost-centers/page.tsx`, `open-auxiliaries/page.tsx`, `items/page.tsx`, `business-units/page.tsx`, `journals/page.tsx` (plain grid)
- Test: `packages/ui/src/tree/__tests__/tree-model.test.ts`, `packages/ui/src/tree/__tests__/TreePane.test.tsx`, `apps/web/e2e/accounting-masters.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("buildTree nests by parent and expandToLevel(2) opens classes and groups only", () => { ... });
it("TreePane shows the figure beside each node, a lock without figure on a restricted node, and filters by code or name", () => { ... });
test("Plan de cuentas: Tabla · Árbol toggle persists per user; selecting 13 shows its children in the grid; Nueva cuenta auxiliar under 130505 creates 13050501", async ({ page }) => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/ui test -t tree && pnpm -F web e2e -g masters`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/tree "apps/web/src/app/(app)/accounting"
git commit -m "feat(accounting-ui): tree pane and the Tabla · Árbol master page for chart, dimensions and fuentes"
```

### Task 27: Comprobante record: header, keyboard-first lines editor, status buttons, Origen

**Files:**
- Create: `packages/ui/src/accounting/EntryForm.tsx`, `LinesEditor.tsx` (TanStack table in edit mode: Enter adds a line, Tab across account → party → cost center → auxiliar abierto → ítem → unidad de negocio → debit → credit; the last three columns only when their `use_*` is on; unidad de negocio cell shows the header value greyed until overridden; account lookup lists only `can_post` accounts; totals and difference footer; restricted lines rendered `••••`), `EntryStatusBar.tsx` (buttons by status and four-eyes: Enviar a aprobación · Aprobar y contabilizar · Devolver a borrador · Contabilizar · Reversar · Anular borrador; the approve button disabled with the hint `accounting.entry.same_user` for the creator), `OriginTab.tsx` (source document link, event, rule link, audit chain timeline from `kernel.audit.consult`), `entry-model.ts` (pure: `lineTotals`, `nextFocus`, `visibleColumns(settings)`, `allowedActions(entry, settings, userId)`), `packages/ui/src/accounting/index.ts`
- Modify: `apps/web/src/lib/records/entities.ts` (`accounting.entry` with consult / create / update, `titleField: "number"`), `apps/web/src/app/(app)/r/[entity]/[id]/record-form.tsx` (entry form), `apps/web/src/lib/records/load.ts`, `apps/web/src/app/(app)/accounting/entries/page.tsx` (grid with Nuevo, Nuevo desde plantilla, quick filters Hoy · Este período · Borradores · Por aprobar · Automáticos · Manuales)
- Test: `packages/ui/src/accounting/__tests__/entry-model.test.ts`, `__tests__/LinesEditor.test.tsx`, `apps/web/e2e/accounting-entry.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("allowedActions: draft+fourEyes → submit, void; pending → approve (not for creator), return; posted → reverse; auto entries never submit", () => { ... });
it("Tab order skips hidden dimension columns; Enter on the last cell adds a line; the difference footer shows 0,00 when balanced", async () => { ... });
test("Nota de contabilidad: create, add two lines with the keyboard, attach, Contabilizar → NC-<n>; as andres with four-eyes on: Enviar a aprobación, laura approves", async ({ page }) => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/ui test -t "entry-model|LinesEditor" && pnpm -F web e2e -g entry`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/accounting apps/web/src/lib/records "apps/web/src/app/(app)/r" "apps/web/src/app/(app)/accounting/entries"
git commit -m "feat(accounting-ui): comprobante record with keyboard lines editor, approval flow and origin timeline"
```

### Task 28: Cuenta, dimension, fuente, plantilla, período and regla contable records

**Files:**
- Create: `packages/ui/src/accounting/AccountSecurityTab.tsx` (Abierta / Restringida switch, grants grid rol o usuario · ver · contabilizar, Agregar, Quitar, step-up prompt), `BalancesTab.tsx` (per period of the selected year), `MovementsTab.tsx` (`DataGrid` of `accounting.ledger_line` filtered by account or dimension node with descendants), `DimensionBalancesTab.tsx` (Saldos por cuenta / Resultados), `PeriodTabs.tsx` (Resumen by fuente, Comprobantes grid, Cierre: checks with figures, user, time, history), `RuleForm.tsx` + `RuleLinesEditor.tsx` (role, side, amount path, dimension, party, cost center, the three dimensions, tax fields), `RuleTestTab.tsx` (pick a past outbox event → `posting_rule.test` preview grid), `RuleHistoryTab.tsx`
- Modify: `apps/web/src/lib/records/entities.ts` (account, cost_center, open_auxiliary, item, business_unit, journal, entry_template, period, posting_rule), `record-form.tsx`, `apps/web/src/lib/records/load.ts` (per-entity tab lists of §8)
- Test: `packages/ui/src/accounting/__tests__/account-security-model.test.ts`, `apps/web/e2e/accounting-records.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("security tab: a grant with contabilizar implies ver; Quitar asks for step-up; a non-admin sees no Seguridad tab", () => { ... });
test("Cuenta 5105 → Seguridad: restrict to contador (ver y contabilizar) with TOTP; as marcela: Saldos and Movimientos answer Sin acceso, the tree shows a lock", async ({ page }) => { ... });
test("Regla contable: edit a line's role, Probar con un evento real shows the preview, Guardar asks TOTP and sets Modificada", async ({ page }) => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/ui test -t account-security && pnpm -F web e2e -g records`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/accounting apps/web/src/lib/records "apps/web/src/app/(app)/r"
git commit -m "feat(accounting-ui): account, dimension, fuente, template, period and posting rule records"
```

### Task 29: Períodos, Informes, Reglas contables pages, setup action, home widgets and contributed tabs

**Files:**
- Create: `apps/web/src/app/(app)/accounting/periods/page.tsx` (years as cards; period grid with status, entries, totals, Cerrar / Reabrir with the TOTP dialog, Reabrir whole period or one day; Cerrar año / Reabrir año with the closing preview), `reports/page.tsx` (cards for the 13 reports) and `reports/[report]/page.tsx` (`ReportRoute`), `posting/page.tsx` (tabs Reglas · Mapeo de cuentas · Conceptos exógena · Pendientes de contabilizar (Reintentar / Reabrir período / Descartar; the bar item carries the pending count badge) · Configuración (settings form under step-up, "eventos anteriores al inicio del libro" counter)), `setup/page.tsx` (**Configurar contabilidad**: the single action running `chart.seed` under TOTP; every accounting page redirects here while `settings` has no row), `apps/web/src/app/(app)/accounting/layout.tsx` (the redirect)
- Modify: `packages/modules/accounting/src/home.ts` (`HOME_KPIS`: Resultado del mes, Pendientes de contabilizar with `tone: "warn"`, Períodos abiertos, Comprobantes en borrador), `src/index.ts` (`recordTabs`: `accounting.entries` grid tab `forEntities: "*"` over `v_entries_for_source`; `accounting.category_revenue` mapping tab for `core.product_category` with `dimension: "category:{id}"`, `roles: ["revenue"]`, `lookupEntity: "accounting.account"`, `saveProcess: "accounting.account_role_mapping.update"`; `accounting.subject_accounts` grid tab for `kernel.role` and `kernel.user` over the grants), `apps/web/src/app/(app)/admin/roles/roles-screen.tsx` and `admin/users/users-screen.tsx` (render the contributed **Cuentas** tab panel of Task 3 for the selected role or user), `apps/web/src/app/(app)/_components/web-shell.tsx` (nav badge from `posting_failure.consult` count)
- Test: `apps/web/e2e/accounting-periods.spec.ts`, `accounting-reports.spec.ts`, `accounting-posting.spec.ts`, `packages/modules/accounting/src/__tests__/home.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("Períodos: Cerrar octubre with a draft open shows the failed check list; after voiding the draft, TOTP → closed; Reabrir solo el día 15 → the period shows 'reabierto para 15/10/2026'", async ({ page }) => { ... });
test("Informes: Balance de prueba with Este período, nivel 4 → totals equal; click 4135 → Auxiliar opens in a new tab; Excel downloads", async ({ page }) => { ... });
test("Reglas contables: Pendientes shows a failure with Reintentar; Mapeo de cuentas shows no unmapped role after setup; category record Contabilidad tab saves the revenue account with TOTP", async ({ page }) => { ... });
it("home KPIs: result of the month equals the income statement; pending count equals posting_failures pending", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F web e2e -g "periods|reports|posting" && pnpm -F @erp/module-accounting test:integration -t home`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/accounting" packages/modules/accounting "apps/web/src/app/(app)/_components"
git commit -m "feat(accounting-ui): periods, reports, posting rules pages, setup action, home widgets and contributed tabs"
```

---

## Part G · Catalogues, assistant, demo, guides

### Task 30: i18n catalogues, rule check for PUC codes, assistant evals

**Files:**
- Modify: `packages/i18n/messages/es-419.json` and `en.json`: `entity.accounting.*` (20), `field.accounting.*` (every field), `nav.accounting.*` (Comprobantes, Movimientos, Maestros, Plan de cuentas, Centros de costo, Auxiliares abiertos, Ítems, Unidades de negocio, Fuentes, Períodos, Informes, Reglas contables), `nav.create.accounting.*`, `feature.accounting.*`, `report.accounting.*` (13 titles, parameter labels, `report.restricted_accounts`, `report.omitted_lines`), `accounting.status.*`, `accounting.origin.*`, `accounting.check.*` (ten checks), `accounting.failure.*` (twelve codes + `account_forbidden`, `same_user_approval`), `accounting.entry.*` (buttons, hints), `grid.group.*`, `grid.sort.max_levels`, `home.kpi.accounting_*`; `scripts/check-rules.ts` gains `puc-code-outside-pack`: a string literal matching `/^[1-9]\d{3,7}$/` in `packages/kernel/src/posting` or `packages/modules/accounting/src` (tests and `rules/fixtures` excluded) is a violation
- Create: `packages/agent/src/__tests__/evals/accounting.json` (Spanish prompts → expected tool calls: "¿cuánto vendimos en septiembre por centro de costo?" → `accounting.income_statement` with `byCostCenter`; "registra la provisión de arriendo de octubre por $ 2.500.000" → `accounting.entry.create` confirmation; "¿qué pasó contablemente con la factura FE-1234?" → `kernel.data.query` on `accounting.entry` by `source_ref`; "¿quién me debe más de 90 días?" → `accounting.aging`; "gastos de octubre por centro de costo" → `kernel.data.query` on `accounting.ledger_line` with `groupBy`)
- Test: `packages/i18n/src/__tests__/catalogue.test.ts` (every registry key, report key and `accounting.*` key exists in both locales), `scripts/__tests__/check-rules.test.ts`, `packages/agent/src/__tests__/evals.test.ts`

- [ ] **Step 1: Write the failing tests, run them, add the keys and the check, run to verify they pass**

Run: `pnpm -F @erp/i18n test && pnpm check:rules && pnpm -F @erp/agent test -t evals`
Expected: PASS; `check:rules` reports no violation (the accounting source names roles, never codes).

- [ ] **Step 2: Commit**

```bash
git add packages/i18n scripts packages/agent/src/__tests__
git commit -m "feat(accounting): Spanish and English catalogues, PUC-code rule check and assistant evals"
```

### Task 31: Demo seed and end-to-end smoke

**Files:**
- Modify: `scripts/seed.ts`, `scripts/demo/accounts.ts` (user `andres@demo.local`, Andrés Rojas, role `contador`), `scripts/demo/accounting.ts` (as Laura: `chart.seed`; cost centers Administración, Tostión, Tiendas → Tienda Chapinero, Tienda Usaquén; auxiliares abiertos Proyectos → Exportación piloto, Vehículos → Camioneta NPR; ítems Café → Café tostado 500 g, Bebidas → Espresso; unidades Consumo → Tiendas, Web; Institucional → Horeca, Distribuidores; `settings.update` turning the three on; `account_permission.update` 5105 restricted to contador view+post and gerencia view, class 3 to contador, Davivienda account postable only by Laura; 2026 opening balances through `opening.create` + `opening.post`; 40 posted entries January–October from the §5.4 fixtures through synthetic outbox rows drained by the worker, plus manual NC entries: "Nómina octubre", the accrual "Acumulación energía octubre" with `reverse_on 2026-11-01`, a suspense deposit, a pending provision by Andrés; periods January–September closed), `supabase/seed.sql` (entitlement `module:accounting`), `docker-compose.test.yml` (seed job env)
- Create: `apps/web/e2e/accounting-smoke.spec.ts`
- Modify: `README.md` (accounting demo walkthrough)

- [ ] **Step 1: Write the failing e2e**

```ts
test("laura: Contabilidad → Balance de prueba Este período shows equal totals; Movimientos grouped by Cuenta then Centro de costo shows subtotals; Cerrar septiembre is already closed; assistant 'gastos de octubre por centro de costo' answers with a table and a link to Movimientos", async ({ page }) => { ... });
test("marcela (ventas): Balance de prueba shows one Cuentas restringidas row with the same totals; Auxiliar 510506 answers Sin acceso; Nómina octubre shows masked lines; a new comprobante offers no 5105", async ({ page }) => { ... });
test("andres: creates a draft, Enviar a aprobación; cannot approve it; laura approves with TOTP → NC-<n>; the auto-reversal draft of the accrual appears in Borradores dated 01/11/2026", async ({ page }) => { ... });
```

- [ ] **Step 2: Run to verify it fails, write the seed, run to verify it passes**

Run: `pnpm db:reset && DEMO_SEED=1 pnpm db:seed && pnpm -F web e2e -g accounting`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts supabase/seed.sql docker-compose.test.yml apps/web/e2e README.md
git commit -m "feat(accounting): demo ledger for Café del Norte and end-to-end smoke"
```

### Task 32: User guides, roadmap and hand-off

**Files:**
- Create in `docs/user-guide/es-419/contabilidad/`: `plan-de-cuentas.md`, `comprobantes.md`, `centros-de-costo.md`, `auxiliares-abiertos-e-items.md`, `unidades-de-negocio.md`, `consulta-de-movimientos.md`, `controles-y-cierre.md`, `seguridad-por-cuenta.md`, `exogena.md`, `cartera-por-edades.md`, `periodos-y-cierre.md`, `reglas-contables.md`, `informes.md`, `pendientes-de-contabilizar.md`; update `docs/user-guide/es-419/README.md` (index) and run `pnpm help:index`
- Modify: `docs/roadmap.md` (phase 2A done: exit criteria checked; 2B / 2C pointers), `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (self-review notes filled at the end)
- Test: `packages/kernel/src/__tests__/help-index.test.ts` (every guide indexed; the assistant answers "¿cómo cierro el mes?" from `periodos-y-cierre.md`)

- [ ] **Step 1: Write the guides (user-guide-writing skill: task-oriented, Spanish Latam, one screenshot placeholder per screen, the exact button labels of the catalogue), run the help index test, commit**

Run: `pnpm help:index && pnpm -F @erp/kernel test:integration -t help-index`
Expected: PASS.

- [ ] **Step 2: Commit and tag**

```bash
git add docs
git commit -m "docs(accounting): user guides for phase 2A, roadmap update"
git tag phase-2a-accounting
```

---

## Self-review notes

- **Spec coverage.** §4.1–4.16 → Tasks 12, 13, 17 (schema, views), 14–16 (masters), 18–19 (entries); §5.1 → Tasks 1, 9, 20; §5.2–5.3 → Task 8; §5.4 → Task 20 fixtures (templates relocated by plan 2B); §5.5 → Tasks 19, 20; §5.6 → Task 20; §5.7 → Task 21; §5.8 → Task 19; §5.9 → Tasks 10, 11; §5.10 → deferred to phase 3 by the design itself (no task); §5.11 → Task 24; §5.12 → Tasks 19, 21, 24; §5.13 → Tasks 12, 16, 17, 18, 22, 23, 28; §5.14 → Tasks 6, 7, 25; §6 → every process named in Tasks 14–25 (`chart.seed`, `account.*`, `account_role_mapping.*`, `account_permission.*`, `journal.*`, four dimensions, `fiscal_year.*`, `period.*`, `year.*`, `entry.*`, `entry_line.consult`, `entry_template.*`, `entry.from_template`, `posting_rule.*`, `posting_failure.*`, `posting.retry`, `opening.*`, `settings.*`, thirteen reports, `ledger_line.*`, `report.exogena_xml` added as the process behind `co.exogena.export_xml`); events → Tasks 19–21; §7 workflows → e2e of Tasks 26–31; §8 → Tasks 2, 3, 25–29; §9 → Tasks 1, 16, 17, 30; §10a.5 reports → Tasks 4, 5; §10b.18 Fuente → catalogues (Task 30) and pages (Task 26); §10b.19 → Tasks 6, 7, 25; §11 → every bullet has a task (DDL 12/13/17, kernel items 1–7, JSONPath 8, `v_ledger_lines` 17, security functions 12, pack 10/11, tree 26, lines editor 27, PDF libro header 4, i18n 30, guides 32, review focus above).
- **Step scan.** Every step names its test, its signature or its command; bodies appear only for the composition rule and the SQL shapes the schema pins.
- **Type consistency.** `PostingProvider`, `ComposedEntry`, `PostingFailureCode`, `RuleTemplate`, `DefaultPostingRule` (Task 8) are the names Tasks 9, 20 use; `ReportDef`, `runReport`, `source: { kind: "report" }` (Task 4) are what Tasks 5, 22–24 use; `GroupRow`, `GridResult.groups` (Task 6) are what Task 7 and 25 use; `validateLines`, `postEntry` (Tasks 18, 19) are what Task 20 calls; `accountingHarness` (Task 12) is the harness of every integration test; `DIMENSIONS` (Tasks 12, 15) drives Tasks 18, 26, 28; `RecordTabContribution` (Task 3) is what Task 29 declares.
- **Review Focus.** Five lines, each pinned to named tests in Tasks 17–22 and 25.
- **Proportion.** About 2.3× the spec's length for 32 tasks that touch four packages, the app and the database; code blocks are test names, assertions and signatures.
- **Calls made in this plan (owner to check):** default rule templates ship as accounting fixtures until plan 2B relocates them; `suspense → 238095` and `rounding → 530595` as pack auxiliaries created by the seed; `co.exogena.export_xml` is exposed as the module process `accounting.report.exogena_xml` because packs register no processes; `ReportDef` consults take `{ params, state }` and reports save parameter sets as `report:<id>` saved views; `GridState.groupBy` accepts a string for backward compatibility; `v_entry_lines` masks a restricted line in place (nulls + `is_restricted`) so entry totals stay; `period.close` answers `closed: false` with the failed checks instead of throwing, so the sign-off rows of a refused close are kept; `post_from_event` throws on a ledger refusal so the engine records the failure and a retry can reuse the idempotency key; `kernel.admin.module.enable` checks the pack maps every role a module declares.

### Execution notes (filled at the end, 2026-10-30)

Tasks 1-32 executed on `main`; tag `phase-2a-accounting`. Departures and facts the next plan (2B) and the owner should know:

- `loadAppRegistry` in `scripts/help-index.ts` now loads `accounting`; the help guide loader reads module subfolders (`contabilidad/<guide>.md`) and menu groups' children count as screens (`#` is not a screen). The fourteen guides live in `docs/user-guide/es-419/contabilidad/`; the Fuentes screen is covered by `comprobantes.md`, `/accounting/setup` by `reglas-contables.md` (no route in the front matter: it is not a menu item). The test the plan named (`packages/kernel/src/__tests__/help-index.test.ts`) does not exist; the checks live in `scripts/__tests__/help-index.test.ts` (guides indexed, "¿cómo cierro el mes?" ranks `periodos-y-cierre.md` first with the offline embedder) and `packages/kernel/src/help/__tests__/help.test.ts`.
- User preference key is `master_view.<entity>` (Tabla / Árbol per master). The Tabla view has no period-movement column (only Árbol shows the period's figure).
- "Devolver a borrador" runs `accounting.entry.update`.
- A restricted account opened by its page link shows the generic permission message; the API and the Saldos / Movimientos tabs answer "Sin acceso".
- Marcela's (restricted) Balance de prueba closing columns differ from Laura's by the restricted row netting; both are internally consistent (sumas iguales).
- "Cerrar año" has no e2e. The assistant evals are structural (no model call). There is no top-level `accounting.*` i18n namespace (copy lives under `nav.accounting`, `entity.accounting`, `field.accounting`, `report.accounting`, `common.entry`, `common.acc_*`, `grid.*`).
- The exógena XML is a consult process (`accounting.report.exogena_xml`); the report page has no XML button yet (Excel / CSV / PDF only).
- Screenshots: the guides carry one `[Captura: …]` placeholder per screen; no images were captured.

