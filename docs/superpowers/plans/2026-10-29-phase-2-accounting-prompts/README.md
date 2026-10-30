# Phase 2A · one prompt per task

Generated 2026-10-30 from `docs/superpowers/plans/2026-10-29-phase-2-accounting.md`. Each file is a complete first message for a new session that implements exactly one task. Run them in order; a task starts only when the previous ones are merged on the branch, except where the dependency column says otherwise. The owner has not yet ordered execution; these files are prepared for that moment.

The plan is the authority; each prompt copies its task's text verbatim, so an edit to the plan must be mirrored in the prompt (or the prompts regenerated). The prompt adds what a fresh session needs around the task: the mandatory reading line, where the task sits, how to work in this repository, the global constraints, the review-focus lines pinned to the task and the report format.

| # | Part | File | Task | Consumes |
|---|---|---|---|---|
| 1 | A | [`task-01-process-origins-and-wildcard-event-consumers.md`](task-01-process-origins-and-wildcard-event-consumers.md) | Process origins and wildcard event consumers | phase 1 code only |
| 2 | A | [`task-02-navigation-groups.md`](task-02-navigation-groups.md) | Navigation groups (NavItem.children) | phase 1 code only |
| 3 | A | [`task-03-record-tab-contributions-from-manifests.md`](task-03-record-tab-contributions-from-manifests.md) | Record-tab contributions from manifests | phase 1 code only |
| 4 | A | [`task-04-report-definitions-report-route-and-report.md`](task-04-report-definitions-report-route-and-report.md) | Report definitions, report route and report exports | phase 1 code only |
| 5 | A | [`task-05-report-page-component.md`](task-05-report-page-component.md) | Report page component (parameter bar, grid, totals, drill) | Task 4 |
| 6 | A | [`task-06-grouped-aggregates-in-the-query-builder.md`](task-06-grouped-aggregates-in-the-query-builder.md) | Grouped aggregates in the query builder and the grid route | phase 1 code only |
| 7 | A | [`task-07-datagrid-multi-sort-badges-agrupar-por.md`](task-07-datagrid-multi-sort-badges-agrupar-por.md) | DataGrid multi-sort badges, Agrupar por, Agregados, group rows and grouped exports | Task 6 |
| 8 | A | [`task-08-posting-engine-core-roles-template-schema.md`](task-08-posting-engine-core-roles-template-schema.md) | Posting engine core: roles, template schema, path resolver, composition | phase 1 code only |
| 9 | A | [`task-09-posting-engine-consumer-and-confirmation-card.md`](task-09-posting-engine-consumer-and-confirmation-card.md) | Posting engine consumer and confirmation-card effects | Task 1, Task 8 |
| 10 | B | [`task-10-countrypack-accounting-chart-mappings-journals-layouts.md`](task-10-countrypack-accounting-chart-mappings-journals-layouts.md) | CountryPack.accounting: chart, mappings, journals, layouts, validation, tax codes | phase 1 code only |
| 11 | B | [`task-11-ex-gena-catalogue-concept-mappings-and.md`](task-11-ex-gena-catalogue-concept-mappings-and.md) | Exógena catalogue, concept mappings and XML writer | Task 10 |
| 12 | C | [`task-12-module-skeleton-masters-migration-entities-and.md`](task-12-module-skeleton-masters-migration-entities-and.md) | Module skeleton, masters migration, entities and masked views | Task 1, Task 3, Task 4, Task 9, Task 10 |
| 13 | C | [`task-13-ledger-migration-entries-lines-rules-failures.md`](task-13-ledger-migration-entries-lines-rules-failures.md) | Ledger migration: entries, lines, rules, failures, templates, close checks | Task 12 |
| 14 | C | [`task-14-chart-seed-accounts-journals-fiscal-years.md`](task-14-chart-seed-accounts-journals-fiscal-years.md) | Chart seed, accounts, journals, fiscal years and settings processes | Task 10, Task 12, Task 13 |
| 15 | C | [`task-15-analytic-dimension-processes.md`](task-15-analytic-dimension-processes.md) | Analytic dimension processes (one factory for four masters) | Task 12, Task 14 |
| 16 | C | [`task-16-account-role-mappings-account-permissions-and.md`](task-16-account-role-mappings-account-permissions-and.md) | Account role mappings, account permissions and concept mappings | Task 8, Task 12, Task 14 |
| 17 | D | [`task-17-published-views-and-the-ledger-line.md`](task-17-published-views-and-the-ledger-line.md) | Published views and the ledger-line query view | Task 12, Task 13, Task 16 |
| 18 | D | [`task-18-entry-drafts-create-update-void-consult.md`](task-18-entry-drafts-create-update-void-consult.md) | Entry drafts: create, update, void, consult, from_template, templates | Task 12, Task 14, Task 15, Task 16, Task 17 |
| 19 | D | [`task-19-post-submit-four-eyes-auto-reversal.md`](task-19-post-submit-four-eyes-auto-reversal.md) | Post, submit, four-eyes, auto-reversal, reverse, opening balances | Task 13, Task 18 |
| 20 | D | [`task-20-posting-provider-post-from-event-failures.md`](task-20-posting-provider-post-from-event-failures.md) | Posting provider, post_from_event, failures, rules processes and default rule fixtures | Task 8, Task 9, Task 18, Task 19 |
| 21 | D | [`task-21-period-close-with-control-checks-reopen.md`](task-21-period-close-with-control-checks-reopen.md) | Period close with control checks, reopen, year close and reopen | Task 17, Task 19, Task 20 |
| 22 | E | [`task-22-statement-reports-balance-de-prueba-mayor.md`](task-22-statement-reports-balance-de-prueba-mayor.md) | Statement reports: balance de prueba, mayor y balances, situación financiera, resultados, centros de costo | Task 4, Task 16, Task 17 |
| 23 | E | [`task-23-line-reports-libro-diario-auxiliar-por.md`](task-23-line-reports-libro-diario-auxiliar-por.md) | Line reports: libro diario, auxiliar por cuenta, por tercero, por dimensión analítica | Task 4, Task 17 |
| 24 | E | [`task-24-control-reconciliation-manual-entries-audit-aging.md`](task-24-control-reconciliation-manual-entries-audit-aging.md) | Control reconciliation, manual entries audit, aging, exógena and its XML | Task 4, Task 11, Task 16, Task 17, Task 21 |
| 25 | E | [`task-25-movimientos-the-ledger-line-query-entity.md`](task-25-movimientos-the-ledger-line-query-entity.md) | Movimientos: the ledger-line query entity, its list process and data.query | Task 6, Task 12, Task 17 |
| 26 | F | [`task-26-tree-pane-and-the-analytic-master.md`](task-26-tree-pane-and-the-analytic-master.md) | Tree pane and the analytic master page (Tabla · Árbol) for five masters | Task 2, Task 12, Task 16, Task 17 |
| 27 | F | [`task-27-comprobante-record-header-keyboard-first-lines.md`](task-27-comprobante-record-header-keyboard-first-lines.md) | Comprobante record: header, keyboard-first lines editor, status buttons, Origen | Task 18, Task 19, Task 20 |
| 28 | F | [`task-28-cuenta-dimension-fuente-plantilla-per-odo.md`](task-28-cuenta-dimension-fuente-plantilla-per-odo.md) | Cuenta, dimension, fuente, plantilla, período and regla contable records | Task 16, Task 17, Task 20, Task 21, Task 26, Task 27 |
| 29 | F | [`task-29-per-odos-informes-reglas-contables-pages.md`](task-29-per-odos-informes-reglas-contables-pages.md) | Períodos, Informes, Reglas contables pages, setup action, home widgets and contributed tabs | Task 3, Task 5, Task 20, Task 21, Task 22, Task 23, Task 24, Task 27 |
| 30 | G | [`task-30-i18n-catalogues-rule-check-for-puc.md`](task-30-i18n-catalogues-rule-check-for-puc.md) | i18n catalogues, rule check for PUC codes, assistant evals | every earlier task (Tasks 1–29) |
| 31 | G | [`task-31-demo-seed-and-end-to-end.md`](task-31-demo-seed-and-end-to-end.md) | Demo seed and end-to-end smoke | every earlier task (Tasks 1–30) |
| 32 | G | [`task-32-user-guides-roadmap-and-hand-off.md`](task-32-user-guides-roadmap-and-hand-off.md) | User guides, roadmap and hand-off | every earlier task (Tasks 1–31) |

Tasks 2, 3, 4, 6 and 8 need only phase 1 and may run in parallel sessions on separate worktrees (5 after 4, 7 after 6, 9 after 1 and 8); from Task 12 on, run them in order. The "Consumes" column names the tasks whose Interfaces · Produces blocks the task reads.

Execution has not been ordered by the owner; these files are prepared for that moment.
