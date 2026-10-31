# ERP-IA Phase 2A gaps: the known gaps of the accounting module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Enforcement (owner order, 2026-10-28):** every implementer and reviewer, whatever model runs it, reads `docs/project-rules.md` and the design sections the task touches before starting, and the brief given to any subagent says: "Read `docs/project-rules.md` and the design sections for X before starting; follow the plan task verbatim." Work that passes its tests but breaks a rule or deviates from the design is rejected. A task that would need a deviation stops and reports; the fix is an owner decision in the main design §22, never a workaround.
>
> **Owner order (2026-10-30):** this plan is written for review. Do not execute it until the owner says so. The owner decisions OD-1–OD-4 were taken on 2026-10-30 (the plan's recommendations, recorded in the main design §22.20); Tasks 3, 6, 7 and 8 implement them.

**Goal:** Close the eight gaps the Phase 2A hand-off listed (plan `2026-10-29-phase-2-accounting.md`, "Execution notes"), so the accounting module does what its design says on every path: an XML button for exógena, the "Sin acceso" note where a restricted account is asked for, statement totals equal to the admin's on every column, an end-to-end test of the year close, the period figure in the masters' Tabla, a clean "Devolver a borrador", model-backed evals with a correct FE-1234 case, a settled catalogue convention, a restricted Cuenta frame like every other record frame, and real screenshots in the fourteen accounting guides.

**Architecture:** Fixes stay in their owners: the restricted fold in `packages/modules/accounting/src/reports`, refusal notes and the report file action in the kernel's report contract and `packages/ui` grid/report components, the XML file through the kernel `exportsStore` (`FileStore`), the year close spec on its own fixture company, the eval runner in `packages/agent` behind an opt-in CI job. Three gaps change a design contract (a process list, `GridState`, the catalogue namespaces); the owner decided them on 2026-10-30 (main §22.20).

**Tech Stack:** TypeScript 5.x, Next.js 16 App Router, React 19, Supabase Postgres 15+, `postgres` (porsager), Zod 4, AI SDK (`ai` 7, `ai/test` mock), next-intl, Vitest, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-28-accounting-module-design.md` (§4.15, §4.16, §5.7, §5.11, §5.12, §5.13, §5.14, §6, §8, §9, §10a.5) and `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (§7.1 evals, §9 grids, §19a UI, §22.17 accounting). Rules: `docs/project-rules.md` (37 rules). Source of the gaps: the execution notes at the end of `docs/superpowers/plans/2026-10-29-phase-2-accounting.md`. Section references below are to the accounting design unless marked "main".

## Gap verification (2026-10-30, against `main` at `99113c6`, tag `phase-2a-accounting`)

| # | Gap as briefed | Found in the code | Task |
|---|---|---|---|
| 1 | Exógena XML has no button | Confirmed. `accounting.report.exogena_xml` (`processes/exogena-xml.ts`) returns `{ fileName, xml, rows }`; `ReportDef` has no file action; the report page offers only PDF / Excel / CSV. | 5 |
| 2 | Restricted account by link shows a generic message | Confirmed for the **report page**: `/api/report/:id` answers `403 { code: "forbidden", details: ["Sin acceso"] }`, but `GridFetchError` (`packages/ui/src/grid/fetch-grid.ts`, also thrown by `report-model.ts` `reportFetcher`) keeps only the code, so `DataGrid` shows `errors.forbidden`. The smoke spec pins the gap (`accounting-smoke.spec.ts:155` expects no "Sin acceso"). The **Cuenta record** is already fixed: `/r/accounting.account/<id>` renders `RestrictedAccount` (Saldos and Movimientos answer "Sin acceso") and the same frame for an id that does not exist. One leak remains: `account_detail` and `dimension_detail` answer `invalid_input` "La cuenta indicada no existe" for a missing account and `forbidden` "Sin acceso" for a restricted one, an existence oracle the record page avoids. | 4 |
| 3 | Trial balance closing columns differ restricted vs unrestricted | Confirmed and broader: `trial-balance.ts` folds the restricted rows by adding `openingNet`, `debit`, `credit`, then splits the **net** into debit / credit, so opposite-nature restricted accounts (demo: 5105 debit, class 3 credit) cancel in the **opening** and the **closing** columns. The demo's opening matched only because class 3 has no opening on that side. The design is not ambiguous: §5.13 "replace … by one line … with their aggregated figures, so sumas iguales and the equation still hold" and Review Focus 3 "totals equal to the admin's". The guide `seguridad-por-cuenta.md` and the smoke spec document the defect as intended. Balance sheet and income statement fold one net amount per section, which is their presentation: correct. | 1 |
| 4 | "Cerrar año" has no e2e | Confirmed. `accounting-periods.spec.ts` covers period close / reopen only. The demo company cannot host it: its October holds Andrés's pending provision (smoke test 3) and Nov–Dec are open, so closing the year there changes the shared demo and the smoke's preconditions. | 2 |
| 5 | Tabla has no period-movement column | Confirmed. Design §8 asks for it ("Tabla is the DataGrid of every node with … estado and the period's movement"). The figure needs a period, and a grid has no way to pass one to a view: no `GridState` parameter, no extra-column hook. | 7 (OD-2) |
| 6 | "Devolver a borrador" runs `accounting.entry.update` | Confirmed. `entry-return.ts` rebuilds the whole update input from the consult; the update deletes and re-inserts every line (new line ids, line audit rows deleted and inserted for a status change); masked lines cannot be re-sent, so the action is refused (`return_blocked`) for an entry with a restricted line; a role that may approve (`entry.post`) but not edit (`entry.update`) cannot return. The design names `entry.update` as the devolver (§5.12.1, §6), so a dedicated process is a design change. | 6 (OD-1) |
| 7 | Evals are structural | Confirmed. `packages/agent/src/__tests__/evals.test.ts` checks the set against the registry; no model is called. | 3 (OD-4) |
| 8 | No top-level `accounting.*` namespace | Confirmed. `catalogue.test.ts` pins the twelve namespaces by kind (`agent, auth, common, entity, errors, feature, field, grid, home, nav, process, report`), from the phase 1 plan's i18n interface; the 2A plan's Task 30 named `accounting.status.*`, `accounting.check.*`, `accounting.failure.*`, `accounting.entry.*`, which execution placed under `common.entry` (93 keys), `common.acc_record` (165), `common.acc_pages` (140) and `grid.*`. Changing the pinned list is a convention change. | 8 (OD-3) |
| 9 | (owner, 2026-10-30) Restricted Cuenta frame lacks the status footer and the deep link | Confirmed. `RestrictedAccount` (`apps/web/src/app/(app)/r/[entity]/[id]/page.tsx:130-149`) passes `uuid` but no `seq`, no `deepLinkHref` and no `status`, so `RecordFrame` prints "assigned on create" where the N.º goes (`RecordFrame.tsx:91`), offers no open-in-new-tab and leaves the footer's status empty (rule 21). The N.º cannot be shown: reading it would read the row the caller may not see, and an id that does not exist has none. | 9 |
| 10 | (owner, 2026-10-30) The fourteen accounting guides have no screenshots | Confirmed: fifteen `[Captura: …]` placeholders (two in `comprobantes.md`, one in each other guide) and no image anywhere in `docs/user-guide/es-419`. The guides are not rendered in the app; they are chunked for the assistant's help search (`packages/kernel/src/help/guides.ts`), so an image line must not reach a chunk as noise. | 10 |
| 11 | (owner, 2026-10-30) The "FE-1234" eval expects `ledger_line`, not `accounting.entry` as the 2A plan said | Confirmed, and the case is wrong, not only unrecorded. The 2A plan (Task 30) asked for `kernel.data.query` on `accounting.entry` by `source_ref`, but `accounting.entry` has no `source_ref` field (`entities.ts:210-226` has `source_entity` and `source_record_id`), so the structural test would have refused it; the executor moved the case to `accounting.ledger_line`, which has the field, and did not say so. On that entity `source_ref` is `source_entity || ':' || source_record_id` (`0033_accounting_views.sql:191`), e.g. `sales.invoice:019a2c4e-…`, never an invoice number, so the expected filter `source_ref eq "FE-1234"` matches no line: a model that obeyed the eval would answer "no encontré nada". The invoice number lives only in the entry's description, which the default rule writes as `Factura {{number}} · {{customer.legalName}}` (`rules/defaults/invoice-issued.json:7`), e.g. `Factura FE-1001 · <razón social del cliente>`, and reaches `v_ledger_lines` as `entry_description`. Design §7 workflow 9 also wants the assistant to read the entries and the audit chain and explain; a one-call eval checks only the first call. Fix here: the case expects `entry_description contains "FE-1234"` (Task 3) and the 2A execution notes record the change. Making `source_ref` the document's own number is a posting-template change that belongs to plan 2B, where invoicing defines its document number (listed below). | 3 |

## Global Constraints

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

## Review Focus

1. **A restricted account leaks nothing through the new channels.** The "Sin acceso" note, the restricted Cuenta frame, the report file action and the Tabla figure must not tell a user without view whether an account id exists, what its code is or what it holds: a missing and a restricted account id answer the same refusal; the XML of a year with restricted accounts aggregates them like the report; a restricted node's figure in Tabla is masked (null, not sortable, not filterable, rule 14). Tests in Task 4 (`missing and restricted account answer the same Sin acceso`), Task 9 (`missing and restricted Cuenta frames are identical`), Task 5 (`exógena XML as a restricted user equals the report's rows`), Task 7 (`period figure of a restricted account is masked and refuses sort and filter`).
2. **Totals equal to the admin's on every column.** A trial balance or libro mayor with restricted accounts of both natures, with and without opening balances, at levels 2 and 4: each of the six money totals equals the admin's. Tests in Task 1 (`restricted accounts of both natures keep each side`, `libro mayor keeps each side`).
3. **Step-up binding and refusals on the new actions.** The XML action under a raised sensitivity asks for the code once and binds it to the caller; a refused XML (errors, no rows, no NIT) shows the reasons and writes no file; Devolver a borrador from the assistant needs a confirmation card. Tests in Task 5 (`raised exogena_xml asks for step-up`, `refused XML stores nothing`), Task 6 (`return_to_draft is a write the assistant confirms`).
4. **Idempotent, order-independent end-to-end runs.** The year close spec creates and removes its own company, never touches the demo company, and passes when run alone, first, last or twice; the smoke keeps its preconditions. Test in Task 2 (run the spec twice in a row and with the smoke after it).
5. **Transaction integrity of the status change.** Returning a pending entry to draft keeps the line ids, writes one audit row on the entry and none on the lines, and two concurrent returns leave one change. Test in Task 6 (`returns in place: same line ids, one audit row`).

---

## Part A · Independent fixes (run in parallel)

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

### Task 3: Model-backed assistant evals (opt-in job, mock fallback) — OD-4 decided 2026-10-30

**Files:**
- Create: `packages/agent/src/evals/run-evals.ts` (`runEvals`), `packages/agent/src/evals/match.ts` (`matchCall`), `packages/agent/src/__tests__/evals-run.test.ts`, `packages/agent/src/__tests__/evals-model.integration.test.ts`, `scripts/evals.ts` (CLI: `pnpm evals`), `.github/workflows/evals.yml`
- Modify: `package.json` (script `"evals": "tsx scripts/evals.ts"`), `packages/agent/src/index.ts` (export `runEvals`, `EvalReport`), `packages/agent/src/__tests__/evals/accounting.json` (`"tier": "core" | "extended"` per case; the five plan prompts are `core`; the case `accounting-what-happened-to-invoice` expects `{ "entity": "accounting.ledger_line", "filters": [{ "field": "entry_description", "op": "contains", "value": "FE-1234" }], "sort": [{ "field": "date", "dir": "asc" }] }`)
- Modify: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` execution notes (one bullet: the FE-1234 case queries `accounting.ledger_line` by `entry_description`, because `accounting.entry` has no `source_ref` and `source_ref` holds `entity:uuid`; `source_ref` as the document number is for plan 2B)
- Create: `docs/evals.md` (how to run, read the report, add a case); no user guide changes (nothing changes on screen)

**Interfaces:**
- Consumes: `resolveModel(sql, tenantId, "chat")`, `policyModel(choice)`, `installedAgentModelFactory`/`setAgentModelFactory`, `mockAgentModel` (`runtime/*`); `toolDescriptors(deps, caller, registry)`, `toolSet(descriptors, run)` (`tools/*`); `buildSystemPrompt`, `permissionSummary` (`runtime/system-prompt.ts`); `recordUsage(sql, row)` (`runtime/usage.ts`); the eval JSON files.
- Produces: `runEvals(opts: { sql: Sql; deps: RunProcessDeps; caller: Caller; registry: Registry; cases: EvalCase[] }): Promise<EvalReport>`; `EvalReport = { model: string; cases: { id: string; tier: "core" | "extended"; pass: boolean; got: { tool: string; input: unknown } | null; why?: string }[]; passRate: number; corePass: boolean }`; `matchCall(expect: EvalCase["expect"], got: { tool: string; input: unknown }): string | null` (null = match; subset match of `expect.input`, tool by `toolName(process)`); the turn runs with `maxSteps: 1` and tool `execute` replaced by a recorder (no process runs, nothing written); every call metered with `recordUsage` under the eval caller.

Values (OD-4, decided 2026-10-30): pass when every `core` case passes and `passRate ≥ 0.9`; the report is written to `eval-report.json` and summarised in the job log; the job runs nightly on `main` (`schedule: "17 6 * * *"`, 01:17 Bogotá) and on `workflow_dispatch`, only when the secret `AI_GATEWAY_API_KEY` exists; on every push the integration test runs the same runner with `AGENT_MODEL=mock` so the plumbing stays tested at no cost.

- [ ] **Step 1: Write the failing tests**

```ts
// evals-run.test.ts (unit)
it("matchCall: subset match on input, tool by provider-safe name; a missing field or a wrong enum is a reason", () => { ... });
it("runEvals never executes a tool: the recorder answers and no process runs", async () => { /* fake deps whose runProcess throws */ });
it("corePass is false when one core case fails even with passRate 0.95", () => { ... });
// evals-model.integration.test.ts (local stack, AGENT_MODEL=mock)
it("runs the set with the mock model: the case the mock knows ('gastos de octubre por centro de costo') passes, the report names the model 'mock/agent', usage rows are recorded", async () => { ... });
it("reads the model only from kernel.model_policies: with the chat policy deleted it fails with MissingModelPolicy", async () => { ... });
it("every data.query case's expected input returns rows on the demo ledger once its literal is swapped for a seeded one (FE-1234 → FE-1001)", async () => { /* run kernel.data.query as Laura with the case's input; rows > 0 */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/agent test -t evals-run && pnpm -F @erp/agent test:integration -t evals-model`
Expected: FAIL (`runEvals` not exported).

- [ ] **Step 3: Implement** `matchCall`, `runEvals` (`generateText` with the policy model, the caller's tool set, the system prompt, `toolChoice: "auto"`, one step), `scripts/evals.ts` (seeds nothing: runs as the demo company's Laura on a stack with `DEMO_SEED=1`, prints the table, writes `eval-report.json`, exits 1 when the threshold fails), `.github/workflows/evals.yml` (supabase start, `pnpm db:seed` with `DEMO_SEED=1`, `pnpm evals`, upload `eval-report.json`; `if: ${{ secrets.AI_GATEWAY_API_KEY != '' }}` through an env check step).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @erp/agent test && pnpm -F @erp/agent test:integration -t evals-model && AGENT_MODEL=mock pnpm evals`
Expected: PASS; the mock run reports the cases it cannot answer as failures and exits 1 — the CLI accepts `--allow-fail` for the mock run, which the integration test does not need.

- [ ] **Step 5: Commit**

```bash
git add packages/agent scripts/evals.ts package.json .github/workflows/evals.yml docs/evals.md
git commit -m "feat(agent): model-backed eval run with a nightly opt-in job and a mock fallback"
```

---

## Part B · Report refusals and the exógena file (in order)

### Task 4: Report and grid refusals show their note; a missing and a restricted account answer the same

**Files:**
- Modify: `packages/ui/src/grid/fetch-grid.ts` (`GridFetchError.details: string[]`, `failureOf`), `packages/ui/src/grid/use-grid.ts` (`GridData.errorNote: string | null`), `packages/ui/src/grid/DataGrid.tsx:327-334` (the alert shows the note when there is one), `packages/ui/src/report/report-model.ts:95-107` (`reportFetcher` passes `details`)
- Modify: `packages/modules/accounting/src/reports/account-detail.ts:32-34`, `dimension-detail.ts:35-37` (a missing account answers `forbidden` "Sin acceso", like a restricted one)
- Modify: `apps/web/e2e/accounting-smoke.spec.ts:153-155` (the page shows "Sin acceso"), `apps/web/e2e/accounting-records.spec.ts` (the Movimientos tab link of a restricted account opens the Auxiliar that answers "Sin acceso")
- Modify: `docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md` (what a user without view sees on the Auxiliar: "Sin acceso", with no detail of the account)
- Test: `packages/ui/src/grid/__tests__/DataGrid.test.tsx`, `packages/ui/src/report/__tests__/report-model.test.ts`, `packages/modules/accounting/src/__tests__/reports-lines.integration.test.ts`

**Interfaces:**
- Consumes: the route's refusal body `{ code, details }` (`apps/web/src/lib/server/process-response.ts`), unchanged.
- Produces: `class GridFetchError { code: string; status: number; details: string[] }`; `failureOf(error: unknown): { code: string; note: string | null }` (`note` = the first string detail of a `forbidden`, `not_found` or `invalid_input` refusal; `failureCode` stays as a wrapper); `GridData = { page; loading; error: string | null; errorNote: string | null }`; `DataGrid` renders `errorNote ?? <the code's message>` in the existing `role="alert"`. Notes are the process's own Spanish copy, as the action dialogs already show (`entry-actions.ts`, `period-actions.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
it("a refused fetch with details shows the first detail in the alert instead of the code's message", async () => { /* fetcher throws new GridFetchError("forbidden", 403, ["Sin acceso"]) → alert text "Sin acceso" */ });
it("a refusal without details keeps the code's message ('No tienes permiso para hacer esto.')", async () => { ... });
it("reportFetcher keeps the details of a 403", async () => { /* fetch mock 403 { code: "forbidden", details: ["Sin acceso"] } → rejects with details ["Sin acceso"] */ });
it("account detail: a missing and a restricted account answer the same Sin acceso", async () => { /* random uuid and restricted 5105 as auxiliar: both ProcessError forbidden, details ["Sin acceso"]; dimension_detail with accountId the same */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/ui test -t "refused fetch|reportFetcher keeps" && pnpm -F @erp/module-accounting test:integration -t "missing and a restricted"`
Expected: FAIL.

- [ ] **Step 3: Implement** the error shape, the note in `use-grid`, the alert text, and the two refusals; update the existing `reports-lines` assertion that expected "La cuenta indicada no existe".

- [ ] **Step 4: Run the tests and the touched e2e to verify they pass**

Run: `pnpm -F @erp/ui test && pnpm -F @erp/module-accounting test:integration -t reports-lines && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-smoke accounting-records`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/grid packages/ui/src/report/report-model.ts packages/ui/src/report/__tests__ packages/modules/accounting/src/reports/account-detail.ts packages/modules/accounting/src/reports/dimension-detail.ts packages/modules/accounting/src/__tests__/reports-lines.integration.test.ts apps/web/e2e/accounting-smoke.spec.ts apps/web/e2e/accounting-records.spec.ts docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md
git commit -m "fix(ui): refused reports and grids show the process's note; Auxiliar answers Sin acceso alike for missing and restricted accounts"
```

### Task 5: "Exportar XML" on the Información exógena page

**Files:**
- Modify: `packages/kernel/src/reports/types.ts` (`ReportFileAction`, `ReportDef.fileActions?`), `packages/kernel/src/reports/define.ts` (validate: unique `id`, `process` registered, kind `consult`, same `feature`), `packages/kernel/src/reports/run.ts` (`runReportFile`)
- Create: `apps/web/src/app/api/report/[id]/file/[action]/route.ts`, `apps/web/src/app/api/report/__tests__/report-file.integration.test.ts`
- Modify: `packages/modules/accounting/src/reports/exogena.ts` (`fileActions: [{ id: "xml", label: "report.file.exogena_xml", process: "accounting.report.exogena_xml", contentType: "application/xml", contentField: "xml" }]`), `packages/ui/src/report/report-model.ts` (`ReportDefClient.fileActions: { id: string; label: string }[]`), `packages/ui/src/report/ReportPage.tsx` (one button per file action next to the export buttons; prop `onFileAction?: (actionId: string, params: ReportParams) => Promise<void>`), `apps/web/src/lib/reports/load.ts` (translated labels), `apps/web/src/app/(app)/_components/report-screen.tsx` (the handler: POST, step-up on 401 through `requestStepUp`, the refusal's details listed in an alert, the signed link opened on success)
- Modify: `packages/i18n/messages/es-419.json` / `en.json`: `report.file.exogena_xml` "Exportar XML" / "Export XML", `report.file.running` "Generando el archivo…" / "Generating the file…", `report.file.refused` "No se generó el archivo:" / "The file was not generated:"
- Modify: `docs/user-guide/es-419/contabilidad/exogena.md` (Exportar XML: when it is enabled, what the refusal list means, the file name `Dmuisca_<formato><versión><año>.xml`, the link lasts 10 minutes)
- Test: `packages/kernel/src/reports/__tests__/define.test.ts`, `packages/ui/src/report/__tests__/ReportPage.test.tsx`, `packages/modules/accounting/src/__tests__/exogena.integration.test.ts`, `apps/web/e2e/accounting-reports.spec.ts`

**Interfaces:**
- Consumes: `GridFetchError.details` / `failureOf` (Task 4); `exportsStore()` and `EXPORT_URL_TTL_SECONDS` (`packages/kernel/src/files/store.ts`, `exports/jobs.ts`); `reportOf`, `reportDenial` (`packages/kernel/src/reports`); `processFailure` (`apps/web/src/lib/server/process-response.ts`).
- Produces: `interface ReportFileAction { id: string; label: string; process: string; contentType: string; contentField: string }`; `runReportFile(deps, caller, reportId, actionId, params): Promise<{ fileName: string; content: string; contentType: string }>` (runs the action's process with `params` as its input through `runProcess`, so permission, sensitivity and step-up apply); `POST /api/report/:id/file/:action` body `{ params }` → `200 { url, fileName }` after `exportsStore().put(\`${companyId}/report-files/${uuidv7()}/${fileName}\`, Buffer.from(content), contentType)` and `signedUrl(path, EXPORT_URL_TTL_SECONDS, fileName)`; refusals through `processFailure` (400 with the error list, 401 `step_up_required`, 403, 404). No file is stored when the process refuses.

Call made: the XML is generated synchronously (one format and year, a few thousand rows at most) instead of through an export job; the job table stays the grid exports' (`pdf | xlsx | csv`). The process stays `normal` (§6 lists no sensitivity for exógena); an admin may raise it (rule 15) and the route honours it.

- [ ] **Step 1: Write the failing tests**

```ts
it("defineReport refuses a file action whose process is missing, not a consult or of another feature", () => { ... });
it("ReportPage shows one button per file action and calls onFileAction with the current parameters", async () => { ... });
it("POST /api/report/accounting.exogena/file/xml stores the XML in the exports store and answers a signed link named Dmuisca_…xml", async () => { /* MemoryFileStore via setExportsStore; the stored bytes equal exogena_xml's xml */ });
it("a refused XML (unmapped account) answers 400 with the error list and stores nothing", async () => { ... });
it("raised exogena_xml asks for step-up: 401 step_up_required without a fresh code, 200 with one bound to the caller", async () => { ... });
it("exógena XML as a restricted user equals the report's rows (restricted accounts aggregated as the report does)", async () => { ... });
// accounting-reports.spec.ts
test("Información exógena 1001 de 2026 → Exportar XML downloads `Dmuisca_001001<versión>2026.xml`; with an unmapped account the page lists the errors", async ({ page }) => { ... });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/kernel test -t "file action" && pnpm -F @erp/ui test -t "file action" && pnpm -F web test:integration -t report-file && pnpm -F @erp/module-accounting test:integration -t exogena`
Expected: FAIL.

- [ ] **Step 3: Implement** the kernel type, validation and `runReportFile`; the route; the UI button and handler; the exógena declaration; the catalogue keys; the guide.

- [ ] **Step 4: Run the tests and the touched e2e to verify they pass**

Run: the Step 2 commands, then `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-reports`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/reports apps/web/src/app/api/report packages/modules/accounting/src/reports/exogena.ts packages/modules/accounting/src/__tests__/exogena.integration.test.ts packages/ui/src/report apps/web/src/lib/reports/load.ts "apps/web/src/app/(app)/_components/report-screen.tsx" packages/i18n/messages apps/web/e2e/accounting-reports.spec.ts docs/user-guide/es-419/contabilidad/exogena.md
git commit -m "feat(accounting): Exportar XML on the exógena report through a report file action and a signed download"
```

---

## Part C · Planned on the owner's decisions

### Task 6: Devolver a borrador as its own process — OD-1 decided 2026-10-30 (option A)

**Files:**
- Create: `packages/modules/accounting/src/processes/entry-return.ts` (`accounting.entry.return_to_draft`)
- Modify: `packages/modules/accounting/src/processes/index.ts` (register), `packages/modules/accounting/src/index.ts` (manifest permissions: default grant to the roles that hold `accounting.entry.post`), `packages/modules/accounting/src/processes/entry.ts:136-143` (description of `entry.update` no longer mentions pending; `update` of a `pending` entry is refused with "Devuelve el comprobante a borrador antes de modificarlo")
- Delete: `apps/web/src/lib/accounting/entry-return.ts` and `entry-return.test.ts`
- Modify: `apps/web/src/lib/accounting/entry-actions.ts:80-86` (`return` runs `accounting.entry.return_to_draft` with `{ id, reason }`), `apps/web/src/lib/accounting/entry-load.ts` (the button shows when the caller may run `return_to_draft`), `packages/ui/src/accounting/entry-model.ts` (`allowedActions`: `return` needs `canReturn`), `packages/ui/src/accounting/EntryForm.tsx` (the Devolver dialog asks for an optional reason)
- Modify: `packages/i18n/messages/es-419.json` / `en.json`: `process.accounting.entry.return_to_draft` "Devolver comprobante a borrador" / "Return entry to draft", `common.entry.return_reason` "Motivo (opcional)" / "Reason (optional)"; remove `common.entry.return_blocked`
- Modify: `docs/user-guide/es-419/contabilidad/comprobantes.md:58`, `controles-y-cierre.md:19` (who may return, the reason, that a comprobante with restricted lines can be returned)
- Modify: `packages/agent/src/__tests__/evals/accounting.json` (case "devuelve a borrador el comprobante NC-2026-0042" → `accounting.entry.return_to_draft`, confirmation)
- Test: `packages/modules/accounting/src/__tests__/entry-post.integration.test.ts`, `apps/web/e2e/accounting-entry.spec.ts`, `packages/ui/src/accounting/__tests__/entry-model.test.ts`

**Interfaces:**
- Produces: `accounting.entry.return_to_draft` kind `update`, sensitivity `normal` (admin may raise), feature `accounting.ledger`, input `{ id: uuid, reason?: string (1..500) }`, output `{ id }`; refuses `not_found`, and `invalid_input` "Solo un comprobante pendiente de aprobación vuelve a borrador" for any status but `pending`; sets `status = 'draft'`, `submitted_by = null`, `submitted_at = null`, `extra.return_reason` when given; lines untouched; emits no event (§6 lists none; OD-1 asks).

- [ ] **Step 1: Write the failing tests**

```ts
it("return_to_draft returns in place: same line ids, one audit row on the entry, none on the lines, reason kept", async () => { ... });
it("return_to_draft works on an entry with a restricted line for an approver without view on it", async () => { ... });
it("return_to_draft refuses a draft, a posted and a voided entry; entry.update refuses a pending entry", async () => { ... });
it("return_to_draft is a write the assistant confirms (tool present, confirmation card, no run before accept)", async () => { ... });
// accounting-entry.spec.ts: four-eyes flow → "Devolver a borrador" with a reason → status Borrador, the creator edits and resubmits
```

- [ ] **Step 2: Run them to verify they fail, implement, run them to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "return_to_draft" && pnpm -F @erp/ui test -t entry-model && pnpm -F @erp/agent test -t evals && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-entry`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting packages/ui/src/accounting apps/web/src/lib/accounting packages/i18n/messages packages/agent/src/__tests__/evals docs/user-guide/es-419/contabilidad apps/web/e2e/accounting-entry.spec.ts
git commit -m "feat(accounting): Devolver a borrador as its own process, in place, with a reason"
```


### Task 7: The period figure in the masters' Tabla — OD-2 decided 2026-10-30 (option A)

**Files:**
- Modify: `packages/kernel/src/registry/entities.ts` (`EntityDef.gridParams?: { name: string; type: "uuid" | "date" | "text"; required?: boolean }[]`), `packages/kernel/src/query/grid-state.ts` (`GridState.params?: Record<string, string>`, max 5), `packages/kernel/src/query/run.ts` (`gridQueryInTx` validates `state.params` against `entity.gridParams`, then `select set_config('erp.param.' || name, value, true)` for each before the query; unknown names refused `invalid_input`), `packages/kernel/src/query/data-query.process.ts` (same params), `packages/kernel/src/exports/*` (the job's stored state carries them; nothing else changes)
- Create: `supabase/migrations/0036_accounting_period_figures.sql`: `accounting.period_figure(kind text, node_id uuid, period_id uuid) returns numeric` (`stable`, `security invoker`, reads `v_account_balances` and the master views, descendants included, null when the node or the account is not visible), and `create or replace view` of `v_accounts`, `v_cost_centers`, `v_open_auxiliaries`, `v_items`, `v_business_units` adding the column `period_figure = accounting.period_figure('<kind>', id, nullif(current_setting('erp.param.period_id', true), '')::uuid)` (balance for accounts, result for cost centers, net movement for the other three, as the tree, `masters.ts` `figure`)
- Modify: `packages/modules/accounting/src/entities.ts` (field `period_figure` type money, `filterable`, `sortable`, `aggregatable`; `gridParams: [{ name: "period_id", type: "uuid" }]` on the five masters), `packages/ui/src/grid/DataGrid.tsx` + `types.ts` (prop `params?: Record<string, string>` merged into every request and export), `apps/web/src/app/(app)/accounting/_components/master-page.tsx` (the period selector shows in both views; Tabla passes `params={{ period_id }}`; the column header is the figure's label of `grid.master.<figure>`)
- Modify: `packages/i18n/messages/*.json` (`field.accounting.period_figure` "Cifra del período" / "Period figure"; `grid.master.period` reused)
- Modify: `docs/user-guide/es-419/contabilidad/plan-de-cuentas.md`, `centros-de-costo.md:21`, `auxiliares-abiertos-e-items.md`, `unidades-de-negocio.md` (Tabla shows the selected period's figure; it sorts, filters and exports)
- Test: `packages/kernel/src/__tests__/grid-params.integration.test.ts`, `packages/modules/accounting/src/__tests__/master-figures.integration.test.ts`, `apps/web/e2e/accounting-masters.spec.ts`

**Interfaces:**
- Produces: `EntityDef.gridParams`, `GridState.params`, the `erp.param.<name>` transaction settings (local to the query's transaction), `accounting.period_figure(kind, node_id, period_id)`, the `period_figure` column of the five master views; `DataGrid` prop `params`.
- Kernel impact: one optional `GridState` field and one optional `EntityDef` field; entities without `gridParams` refuse any `params` (no behaviour change elsewhere); saved views and the URL `?view=` keep `params` with the state.

- [ ] **Step 1: Write the failing tests**

```ts
it("grid params: declared params reach the view through erp.param.*, undeclared ones are refused, and the setting does not outlive the transaction", async () => { ... });
it("Tabla figure equals the tree's figure for every node and period, descendants included, for the five masters", async () => { ... });
it("period figure of a restricted account is masked and refuses sort and filter", async () => { ... });
it("the export of Tabla with a period carries the figure column of that period", async () => { ... });
// accounting-masters.spec.ts: Plan de cuentas → Tabla → period octubre de 2026 → sort by the figure column (header `grid.master.balance`) desc → the first row is the account with the largest October balance; Excel export has the column
```

- [ ] **Step 2: Run them to verify they fail, implement, run them to verify they pass**

Run: `pnpm -F @erp/kernel test:integration -t "grid params" && pnpm -F @erp/module-accounting test:integration -t master-figures && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-masters`
Expected: PASS; `supabase db reset` applies `0036`.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel packages/modules/accounting supabase/migrations/0036_accounting_period_figures.sql packages/ui/src/grid "apps/web/src/app/(app)/accounting/_components/master-page.tsx" packages/i18n/messages docs/user-guide/es-419/contabilidad apps/web/e2e/accounting-masters.spec.ts
git commit -m "feat(accounting): the period figure in the masters' Tabla through declared grid parameters"
```


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


---

## Part D · Owner additions (2026-10-30)

### Task 9: The restricted Cuenta frame gets the status footer, the deep link and a masked N.º

**Files:**
- Modify: `packages/ui/src/record/RecordFrame.tsx:11-21, 91` (`seq?: number | null | "masked"`; `"masked"` renders `N.º •••• · UUID <short>…`, the same masking glyph as a masked field), `apps/web/src/app/(app)/r/[entity]/[id]/page.tsx:130-149` (`RestrictedAccount` passes `seq="masked"`, `deepLinkHref={recordHref("accounting.account", id)}`, `status={<span data-testid="record-status" className="erp-record__status"><span className="erp-pill erp-pill--gray">{t("common.acc_record.no_access")}</span></span>}`)
- Modify: `docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md` (what the frame of a restricted account shows: title "Cuenta restringida", N.º hidden, UUID, open in a new tab, "Sin acceso" in the footer and on Saldos and Movimientos)
- Test: `packages/ui/src/record/__tests__/RecordFrame.test.tsx`, `apps/web/e2e/accounting-records.spec.ts`

**Interfaces:**
- Consumes: `recordHref`, `RecordFrame` / `AppRecordFrame`, `NoAccess`; the key `common.acc_record.no_access` (moved to `accounting.record.no_access` by Task 8, which runs after).
- Produces: `RecordFrameProps.seq: number | null | "masked"`; no other caller changes.

- [ ] **Step 1: Write the failing tests**

```ts
it("seq 'masked' shows N.º •••• with the UUID, never 'N.º y uuid se asignan al crear'", () => { ... });
// accounting-records.spec.ts, as marcela:
test("missing and restricted Cuenta frames are identical: title Cuenta restringida, N.º ••••, the id's UUID, Abrir en una pestaña nueva opens the same URL, footer Sin acceso", async ({ page }) => { /* 510506's id and a random uuid v7: same text, same tabs, same footer */ });
```

- [ ] **Step 2: Run them to verify they fail, implement, run them to verify they pass**

Run: `pnpm -F @erp/ui test -t RecordFrame && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-records`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/record "apps/web/src/app/(app)/r/[entity]/[id]/page.tsx" apps/web/e2e/accounting-records.spec.ts docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md
git commit -m "fix(accounting): restricted Cuenta frame with status footer, deep link and a masked number"
```

### Task 10: Screenshots in the accounting guides

**Files:**
- Create: `apps/web/guide-shots/accounting.shots.ts` (one Playwright test per placeholder), `apps/web/playwright.guides.config.ts` (`testDir: "./guide-shots"`, `testMatch: "*.shots.ts"`, viewport 1440 × 900, `colorScheme: "light"`, locale `es-419`, timezone `America/Bogota`, no `webServer`: it runs against `E2E_BASE_URL`), `docs/user-guide/es-419/contabilidad/img/` (fifteen PNGs), `scripts/__tests__/guide-images.test.ts`
- Modify: `apps/web/package.json` (script `"guide:shots": "playwright test -c playwright.guides.config.ts"`), the fourteen guides (each `[Captura: <texto>]` becomes `![<texto>](img/<slug>.png)`), `packages/kernel/src/help/guides.ts` (an image line contributes its alt text only, not the markdown, to the chunk), `docs/user-guide/es-419/README.md` (how to refresh the screenshots)
- Test: `packages/kernel/src/help/__tests__/help.test.ts`, `scripts/__tests__/guide-images.test.ts`

**Interfaces:**
- Consumes: the demo company after `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` and the help index; the demo accounts `LAURA`, `MARCELA` (`scripts/demo/accounts.ts`); `login` as in `accounting-smoke.spec.ts`; the final UI of Tasks 1–9.
- Produces: `docs/user-guide/es-419/contabilidad/img/<slug>.png`; slugs: `auxiliares-abiertos-arbol`, `cartera-por-edades`, `centros-de-costo-arbol`, `comprobantes-listado`, `comprobante-borrador-lineas`, `conceptos-exogena-sin-concepto`, `movimientos-agrupado`, `auditoria-comprobantes-manuales`, `informes-tarjetas`, `plan-de-cuentas-arbol`, `pendientes-de-contabilizar`, `periodos-cerrar`, `regla-contable-lineas`, `seguridad-cuenta-restringida`, `unidades-de-negocio-tabla`.

Rules for the captures: each test signs in as Laura (Marcela for nothing: the restricted views are documented in words), opens the screen the placeholder names and screenshots the `main` region (`animations: "disabled"`, the clock fixed with `page.clock.setFixedTime("2026-10-30T15:00:00-05:00")`); a state the demo does not hold (a draft with lines, a pending posting failure, an account with movement and no exógena concept) is created by the test through the same fixture SQL the e2e specs use and removed in `afterEach`, so the demo company ends as it started; the shots spec is not part of `pnpm -F web e2e` (other `testDir`), so CI never rewrites the images. PNGs only, each under 300 KB (`pngquant` is not required: the viewport size keeps them small).

- [ ] **Step 1: Write the failing tests**

```ts
it("no guide keeps a [Captura: …] placeholder and every image a guide names exists under its img/ folder", () => { ... });
it("a guide image line reaches its chunk as its alt text only", () => { /* chunk text of '![Plan de cuentas en vista Árbol](img/plan-de-cuentas-arbol.png)' is 'Plan de cuentas en vista Árbol' */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run scripts/__tests__/guide-images.test.ts && pnpm -F @erp/kernel test -t "image line"`
Expected: FAIL (fifteen placeholders; the chunk keeps the markdown).

- [ ] **Step 3: Implement** the shots spec and config, the alt-text rule in `guides.ts`; run `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web guide:shots` on a freshly seeded demo; replace the placeholders; look at every PNG (it must show what its alt text says, in Spanish, light theme, no dev overlay).

- [ ] **Step 4: Run the tests and the help index to verify they pass**

Run: `pnpm vitest run scripts/__tests__/guide-images.test.ts && pnpm -F @erp/kernel test && pnpm help:index && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-smoke`
Expected: PASS; the smoke still passes after the shots ran (the demo is unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/web/guide-shots apps/web/playwright.guides.config.ts apps/web/package.json docs/user-guide/es-419 packages/kernel/src/help scripts/__tests__/guide-images.test.ts
git commit -m "docs(accounting): screenshots in the accounting guides, captured from the demo company"
```

## Task order and parallel groups

| Wave | Tasks | Runs | Shared files that force the order |
|---|---|---|---|
| 1 | 1, 2, 3 | in parallel, separate worktrees | none between them (3 waits for OD-4 only to confirm the spend) |
| 2 | 4 ∥ 6 | 4 after 1 (both edit `accounting-smoke.spec.ts`, `seguridad-por-cuenta.md`); 6 after OD-1; 4 and 6 share no file | — |
| 3 | 5 ∥ 9 | 5 after 4 (`report-model.ts`, `ReportPage` area, `failureOf`) and after 6 (`packages/i18n/messages/*.json`); 9 after 4 (`accounting-records.spec.ts`, `seguridad-por-cuenta.md`); 5 and 9 share no file | i18n catalogues (5) |
| 4 | 7 | after 4 (`DataGrid.tsx`), 5 and 6 (catalogues); after OD-2 | `DataGrid.tsx`, catalogues |
| 5 | 8 ∥ 10 | 8 after OD-3 and every earlier task (it rewrites the catalogues and every accounting copy reference); 10 after Tasks 1–7 and 9, so the screenshots show the final screens; 8 changes no text on screen and 10 touches no source but `packages/kernel/src/help/guides.ts`, so they share no file | — |

Size: small — 1, 2, 4, 9; medium — 3, 5, 6, 10; large — 7, 8.

## Owner decisions (taken 2026-10-30: the recommendation of each, recorded in the main design §22.20, the accounting design §5.12.1, §6, §8, rules 24 and 30)

- **OD-1 · Devolver a borrador (gap 6).** The design names `entry.update` as the devolver (§5.12.1, §6). Options: **A** a dedicated `accounting.entry.return_to_draft` (update, normal, optional reason, granted with `entry.post`), with `entry.update` refusing pending entries; **B** keep `entry.update` and add a status-only input `{ id, returnToDraft: true }`; **C** keep as is (restricted lines block the return; approvers need `entry.update`). **Decided: A** — the audit names what happened, lines keep their ids, an approver without edit rights can return, and a restricted line no longer blocks it. Also: should a return emit `accounting.entry.returned` (to notify the author in phase 3)? Decided: not now. Recorded in main §22.17 and accounting §5.12.1 / §6.
- **OD-2 · The period figure in Tabla (gap 5).** Options: **A** declared grid parameters (`EntityDef.gridParams`, `GridState.params`, `erp.param.*` settings read by the master views) — a kernel extension available to every grid; **B** five query entities per master × period, no kernel change; **C** open-period-only column, no selector. **Decided: A** — one column per master view, rule 20 (sort, filter, export) and rule 14 (masking in the view) hold with no client code, and later "as of date" grids (inventory, cartera) reuse it. Recorded in main §9 and §22.
- **OD-3 · Catalogue namespaces (gap 8).** The pinned list is "namespaces by kind" (phase 1). Options: **A** registry keys stay by kind, each module's page copy moves to `<module>.*` (`accounting.*` now; `sales.*`, `inventory.*` … in 2B); **B** keep everything by kind and document `common.<module>_*`. **Decided: A** — 2B adds six modules whose page copy would otherwise all land in `common` (already ~400 accounting keys there), and a module namespace can be split into its own file later. Recorded in rule 24 and main §22.
- **OD-4 · Model eval cost and threshold (gap 7).** Rule 30 says the set "runs in CI"; running it calls a paid model. Proposed: nightly on `main` plus manual dispatch, only with the `AI_GATEWAY_API_KEY` secret, pass = every core case and ≥ 90 % overall, mock run on every push; budget about 15 cases × 1 step ≈ a few cents a night with the chat policy. Decided as proposed: a red nightly run does not block merges (it opens nothing; the report is the artifact).

## Unlisted gaps seen in the Phase 2A execution notes (not planned here)

- **For plan 2B:** `source_ref` of `v_ledger_lines` is `entity:uuid`; design §4.16 calls it "the document that produced the entry", and the assistant, Movimientos and exógena would be better served by the document's own number (FE-1234). The posting template header would carry it (`sourceRef: "{{number}}"`) and the entry would store it; invoicing defines that number in 2B.
- `/accounting/setup` is not a menu route and is documented inside `reglas-contables.md`; the help index treats it as no screen.
- The help-index test the 2A plan named (`packages/kernel/src/__tests__/help-index.test.ts`) lives elsewhere; the plan text was not corrected.
- The e2e default port is `3217` (`playwright.config.ts`), not the `:3100` dev server; the prompts run touched specs with `E2E_BASE_URL=http://127.0.0.1:3100`.

## Self-review

- **Gap coverage.** 1 → Task 5; 2 → Task 4 (record frame verified fixed; existence oracle added); 3 → Task 1 (design unambiguous, fixed, not documented away); 4 → Task 2; 5 → Task 7 + OD-2; 6 → Task 6 + OD-1; 7 → Task 3 + OD-4; 8 → Task 8 + OD-3 (OD-1–OD-4 decided 2026-10-30); owner additions of 2026-10-30: restricted Cuenta frame → Task 9, screenshots → Task 10, FE-1234 eval → Task 3 (the `source_ref` contract left to 2B). No 2B/2C work pulled in.
- **Step scan.** Every step names its tests, its signature or its command; the options the owner did not choose are recorded only in the decisions section.
- **Type consistency.** `GridFetchError.details` and `failureOf` (Task 4) are what Task 5's handler reads; `ReportFileAction` / `runReportFile` (Task 5) are used only there; `seedYearLedger` returns `SmallLedger` plus fields; `runEvals` / `EvalReport` / `matchCall` (Task 3) are internal to the agent package; `GridState.params` / `EntityDef.gridParams` (Task 7) are new and named once.
- **Review Focus.** Five lines, each pinned to a named test in Tasks 1, 2, 4, 5, 6, 7, 9.
- **Proportion.** About 1.5× the brief for eight tasks; code blocks are test names and signatures.
- **Effort.** Task 1: 1–2 h · Task 2: 2–3 h · Task 3: 4–6 h · Task 4: 2–3 h · Task 5: 5–7 h · Task 6: 4–5 h · Task 7: 1–1.5 days · Task 8: 4–6 h (mostly verification of the rewrite) · Task 9: 1–2 h · Task 10: 4–6 h (the fifteen states, looking at every image).
