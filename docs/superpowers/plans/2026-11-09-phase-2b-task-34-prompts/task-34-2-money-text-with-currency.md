# Prompt · Phase 2B.2 · Task 34.2 of 34.8 · Money text with currency

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **sub-task 34.2** of Task 34 (foreign currency) of the Phase 2B plan of ERP-IA: `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, section «Expanded task of the foreign-currency batch (Task 34; expanded 2026-11-09)». Do this sub-task only; nothing from any other sub-task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for foreign currency (`docs/superpowers/specs/2026-11-10-foreign-currency-design.md`, the FX § this sub-task cites), kernel §5 (processes, posting, outbox), modules §8 and §8.1, owner decisions §22 (§22.25, §22.28) and the accounting design `docs/superpowers/specs/2026-10-28-accounting-module-design.md` §5 before starting; follow the plan task verbatim. The main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md`. Read `CLAUDE.md` too; its orders apply. Read items 114, 118 and 120–130 of `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md` (decided 2026-11-09; item 126 with the accountant).

**Where this sub-task sits.** Branch `phase-2b-sales-chain`. Starts when: At once: in parallel with 34.1 (separate worktree). Names and signatures other sub-tasks produce are in their «Interfaces · Produces» lines in the plan; use those, never reinvented ones. This sub-task's own «Interfaces · Produces» is a contract for the later ones: keep every name exactly as written.

**How to work.**
- Test first (rule 31): write the failing tests the sub-task lists, run them and show they fail, implement, run them and show they pass, then run the gates. Use `superpowers:test-driven-development`.
- Work on the branch the owner's session names; do not create another one unless asked. When this sub-task runs in parallel with another, it runs in its own worktree.
- Environment: the local Supabase stack (Docker via OrbStack); check Docker is up before `pnpm db:reset`. The app's dev server is `:3100` through `.claude/launch.json`; stop or start only that one (`lsof -ti:3100` or the preview tools), never `pkill next-server` (another project runs on `:3000`). Run touched e2e specs with `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`; specs on the demo company need `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` first. Never run the full integration suites against the hosted project. Tests never call the internet: `RATE_FEED=fixture`.
- Migrations forward-only; take the number the sub-task names, or the next free one if it is taken, and say so. Each migration has its integration test (rule 34).
- If the sub-task would break a rule or deviate from the design, stop and report; the fix is an owner decision recorded in the main design §22, never a workaround. No PUC code outside `packages/localization/co` (rule 5). Never edit §22 or `docs/project-rules.md`.
- Before the commit: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the sub-task touches against `:3100`, and `pnpm build`. The full suites run in GitHub Actions on the push; the sub-task is complete only when that run is green.
- Commit only when the owner asks in the session; one conventional commit for the sub-task, ending `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, tag or open a PR unless the owner says so.
- Spanish Latam copy only through `packages/i18n` with an `en` mirror (rule 24). A feature without its user guide is not finished (rule 35): the sub-task's guide edits are part of it. Add or update a brain note in `docs/brain/` (frontmatter tags, date, status; wikilinks) per `CLAUDE.md`.

## Global constraints (from the plan; every task inherits them)

- Migrations forward-only from `0056`, `NNNN_<module>_<topic>.sql`, each covered by an integration test (rule 34). One schema per module: `crm`, `sales`, `inventory`, `costing`, `invoicing`, `payments` (rule 3); no foreign key across schemas; cross-module reads only through views the owner publishes.
- Every table: `id uuid` v7, `company_id`, audit columns, `seq` from `core.next_seq`, `extra`, `extra_free`; `kernel.enable_company_rls()` and `kernel.enable_row_audit()` (rules 7, 12, 16). Money `numeric(18,4)` with document currency, company currency and the exchange-rate snapshot (rule 8).
- Every entity declares `maestro`, `documento`, `lines`, `parametro` or `sistema`; documentos declare `contabiliza` / `requiere_aprobacion`, numbering, import (header + lines through `ref`), export, PDF default templates and the four menu sections (entity types spec §2, §9.2). `check:rules` stays green.
- Every state change is a registered process; the assistant gets no tool outside the registry; writes only behind confirmation cards that list the module effects (`effectsFor`, accounting design §5.1) (rules 1, 17).
- A party or product with `invoice_ready = false` is refused on every document line of quote, order, delivery and invoice (rule 10, main §5.17), with the reasons in the error.
- Fiscal logic only in `packages/localization/co` (rule 5). DIAN certificates and provider keys in Vault (rule 12). No Vercel-only APIs (rule 6); durable work only through `DurableRunner`.
- Posting is mandatory and in the same transaction as the lifecycle action for `contabiliza` documentos (entity types D8). Event-driven postings go through the 2A engine; a failure becomes a `posting_failure`, never a lost event.
- Money `$ 1.234.567,00`; Spanish copy through `packages/i18n` with an `en` mirror; each module's page copy in its own namespace (`sales.*`, `inventory.*`, … rule 24).
- Step-up processes: `invoicing.invoice.void`, `inventory.adjustment.post`, `invoicing.settings.update` (resolution and certificate), `payments.payment.void`. The admin may raise others.
- Test first (rule 31); no commit or push unless the owner asks (rule 33); a feature without its guide in `docs/user-guide/es-419` is not finished (rule 35). Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Rulings of Task 34 (verbatim from the plan)

**Rulings** (what — why — cost if wrong):
- **R34-1 Order and parallelism.** 34.1 and 34.2 are independent (separate worktrees). 34.3 needs 34.1. 34.4 needs 34.2 and 34.3. 34.5 needs 34.4. 34.6 needs 34.5 **and the accountant's answer to item 126 (e)**. 34.7 needs 34.5 (not 34.6: the advance columns it reads are added in 34.5's migration). 34.8 last. Cost if wrong: two sub-tasks editing `invoice.ts` or the open-items SQL at once.
- **R34-2 Rates reach other modules only through `core.v_exchange_rates`** (rule 3). Each consuming module reads it with its own `defaultRate(tx, currency, date)` in its `common.ts`; no module writes `core.exchange_rates` except core's processes. Cost if wrong: none; a shared helper later is a refactor.
- **R34-3 Which companies the TRM import runs for.** A company is in scope when it has at least one row in `core.exchange_rates` or one `core.price_lists` row in a currency other than its own (both core tables), and its pack has `exchangeRates`. Others are skipped silently. Cost if wrong: a company that bills USD without a list or a rate gets `exchange_rate_missing` until its first manual rate, which then brings it into scope.
- **R34-4 One payload shape.** Every payload field that exists today keeps its company meaning; the document twin is the same name with `Doc` appended (`subtotal` → `subtotalDoc`, `totals.total` → `totals.totalDoc`, `lines[].amount` → `lines[].amountDoc`, `taxes[].amount` → `taxes[].amountDoc`). The payload gains `currency` and `exchangeRate`. A COP document carries both with equal values. Cost if wrong: a rename across rules and tests.
- **R34-5 Old rule copies stay correct.** A company rule without a `currency` path posts company amounts at rate 1 (today's behaviour, pinned by a test with a foreign invoice). Migrations rewrite only copies with `is_default and not is_modified`; an edited copy gets the kernel recommendation «La regla X no lleva moneda…» to the accounting role, once per rule.
- **R34-6 Allowed currency pairs on a receipt** (FX §6): receipt currency = invoice currency, or receipt in the company currency against a foreign invoice. Anything else: `currency_mismatch`. One receipt may settle COP and USD invoices together only when the receipt is in COP.
- **R34-7 Export only** (item 124): a foreign-currency invoice whose `InvoiceTypeCode` would not be `02` (customer in Colombia) is refused at create, update and issue with `foreign_currency_domestic` «En esta versión solo las facturas de exportación pueden ir en moneda extranjera». Quotes and orders are not refused (they are not fiscal); the refusal shows when the invoice is made from them.
- **R34-8 Rate vs TRM** (item 123): a rate that differs from the TRM row of the issue date by more than 0,005 % issues with the warning chip; no refusal. The issue output carries `rateWarning: { trm, rate } | null`.
- **R34-9 Guide path.** The rates guide is `docs/user-guide/es-419/tasas-de-cambio.md` (there is no `nucleo/` folder; FX §13 named one), indexed beside `parametros.md`.

## Review focus pinned to this sub-task

5. **Visibility and money text.** Each new company-amount column is masked with its document twin; cards, grids, exports and the PDF print `USD 12.500,00` for a USD value and `$ 1.234.567,00` for COP (34.2, 34.4).

## The sub-task, verbatim from the plan

**34.2 Money text with currency [item 129]** (FX §10). No migration.
- Files. Modify `packages/ui/src/money/format.ts` (`formatMoney`), `packages/kernel/src/exports/format.ts:122` (`moneyText`), `packages/modules/payments/src/processes/common.ts:99` (`pesos` → `money`), `packages/modules/accounting/src/processes/close-checks.ts` (`money`), `packages/agent/src/…/labels.ts:31-42` (`valueText`), every caller grep finds (`moneyText(`, `pesos(`), the snapshot and screenshot tests they move.
- Interfaces · Produces: `formatMoney(value: number, currency: string, companyCurrency = "COP"): string` and `moneyText(amount: number, currency = "COP"): string`: COP → `$ 1.234.567,00`; any other ISO code → `<CODE> 12.500,00` (es-CO digits, two decimals); `rateText(rate: number): string` → up to six decimals, trailing zeros dropped to two (`4.123,45`, `4.123,456789`), exported beside `moneyText`. `payments` `money(n: number, currency: string)` replaces `pesos`.
- Failing tests first. `packages/ui/src/money/__tests__/format.test.ts` and `packages/kernel/src/exports/__tests__/format.test.ts`: `formatMoney(12500, "USD") === "USD 12.500,00"`, `formatMoney(980.5, "EUR") === "EUR 980,50"`, `formatMoney(1234567, "COP") === "$ 1.234.567,00"`, negative `-$ 1.000,00` and `-USD 1.000,00` as today's sign rule, `rateText(4123.45) === "4.123,45"`; agent: a card for an input with `currency: "USD"` shows `USD`, not `$`.
- Note in the report: rule 23 is extended by item 129; the owner records it.

**Gates (each sub-task).** lint, typecheck, check:rules, unit, the touched integration files (always the posting, invoice, receipt and open-items files from 34.4 on), the e2e specs it touches against `:3100`, the build.

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the migration number used, the commit hash if the owner asked for one, any point where you chose something the plan left open, and any point where you stopped because the plan or the design would have been broken. Do not claim the sub-task is complete before the gates passed locally; say so plainly if a step was skipped or a suite is still red. New owner items go to the pending-decisions file from number 131.
