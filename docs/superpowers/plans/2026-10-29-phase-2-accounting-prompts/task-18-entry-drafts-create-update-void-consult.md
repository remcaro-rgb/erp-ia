# Prompt · Phase 2A Task 18 of 32 · Entry drafts: create, update, void, consult, from_template, templates

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 18** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part D · Entries, engine integration and periods). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §4.6, §4.7, §4.10, §5.5, §5.13, §6, §7; main design §5.4. Sections the task text cites: §4.10, §5.5. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–17 are merged on the branch. Interfaces this task consumes come from Task 12, Task 14, Task 15, Task 16, Task 17: read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
