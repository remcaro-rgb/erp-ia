# Prompt · Phase 2A Task 8 of 32 · Posting engine core: roles, template schema, path resolver, composition

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 8** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part A · Kernel extensions). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §5.1, §5.2, §5.3, §5.4 (template shapes), §10a.8 (rounding); main design §5.6. Sections the task text cites: §5.1, §5.2, §5.4, §10a.8. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–7 are merged on the branch (Tasks 2–7 may still be in progress; Task 8 needs only phase 1). This task builds on phase 1 code only; read the phase 1 files it names before changing them. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
