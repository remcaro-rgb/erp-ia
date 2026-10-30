# Prompt · Phase 2A Task 20 of 32 · Posting provider, post_from_event, failures, rules processes and default rule fixtures

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 20** of the phase 2A plan of ERP-IA: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (Part D · Entries, engine integration and periods). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §4.2, §4.8, §4.9, §5.1, §5.4, §5.5, §5.6, §6, §9; main design §5.5, §5.6. Sections the task text cites: §4.2, §5.4. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, this module is §22.17); the visual contract is `docs/superpowers/specs/2026-10-28-accounting-module-prototype.html`. Read `CLAUDE.md` too; its orders apply.

**Where this task sits.** Tasks 1–19 are merged on the branch. Interfaces this task consumes come from Task 8, Task 9, Task 18, Task 19: read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. The task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

- 1. **Redelivery and retry post once.** The same outbox row dispatched twice, a `posting.retry` of a resolved failure, and two rules on one event must leave exactly one entry per `(source_event_id, posting_rule_id)`. Tests in Task 20 (`post_from_event: redelivered event answers the first entry`, `two rules on one event make two entries, one each`).
- 2. **Closed periods never move an entry.** A document dated in a closed period is a `closed_period` failure from engine, UI, assistant, import (`opening.create` + `opening.post`) and template; after `period.reopen` with `date`, only an entry dated that day posts; a credit note dated in an open month against an older invoice posts without touching the old month. Tests in Task 19 (`post refuses closed period`), Task 21 (`reopened_for admits only that day`), Task 20 (`reverseOf rule posts in the note's own period`).

## The task, verbatim from the plan

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

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
