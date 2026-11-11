---
tags: [project, plan]
date: 2026-11-07
status: active
---

# ERP-IA Phase 2A: Posting engine and accounting module — Implementation Plan

Source: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (written 2026-10-29).

**Goal:** A Colombian company that enables Contabilidad gets a PUC chart, journals (fuentes), periods and four analytic dimensions seeded by the pack; every domain event with a posting rule becomes one balanced, idempotent, audited comprobante; accountants create, approve, post, reverse and query entries, close periods behind control checks, restrict accounts per role and user, and pull the fiscal reports, 

## Parts
- Part A · Kernel extensions
- Part B · Colombia pack: accounting extension
- Part C · Accounting module: schema and masters
- Part D · Entries, engine integration and periods
- Part E · Reports and the ledger-line query
- Part F · User interface
- Part G · Catalogues, assistant, demo, guides

## Tasks (32)
- Task 1: Process origins and wildcard event consumers
- Task 2: Navigation groups (NavItem.children)
- Task 3: Record-tab contributions from manifests
- Task 4: Report definitions, report route and report exports
- Task 5: Report page component (parameter bar, grid, totals, drill)
- Task 6: Grouped aggregates in the query builder and the grid route
- Task 7: DataGrid multi-sort badges, Agrupar por, Agregados, group rows and grouped exports
- Task 8: Posting engine core: roles, template schema, path resolver, composition
- Task 9: Posting engine consumer and confirmation-card effects
- Task 10: CountryPack.accounting: chart, mappings, journals, layouts, validation, tax codes
- Task 11: Exógena catalogue, concept mappings and XML writer
- Task 12: Module skeleton, masters migration, entities and masked views
- Task 13: Ledger migration: entries, lines, rules, failures, templates, close checks
- Task 14: Chart seed, accounts, journals, fiscal years and settings processes
- Task 15: Analytic dimension processes (one factory for four masters)
- Task 16: Account role mappings, account permissions and concept mappings
- Task 17: Published views and the ledger-line query view
- Task 18: Entry drafts: create, update, void, consult, from_template, templates
- Task 19: Post, submit, four-eyes, auto-reversal, reverse, opening balances
- Task 20: Posting provider, post_from_event, failures, rules processes and default rule fixtures
- Task 21: Period close with control checks, reopen, year close and reopen
- Task 22: Statement reports: balance de prueba, mayor y balances, situación financiera, resultados, centros de costo
- Task 23: Line reports: libro diario, auxiliar por cuenta, por tercero, por dimensión analítica
- Task 24: Control reconciliation, manual entries audit, aging, exógena and its XML
- Task 25: Movimientos: the ledger-line query entity, its list process and data.query
- Task 26: Tree pane and the analytic master page (Tabla · Árbol) for five masters
- Task 27: Comprobante record: header, keyboard-first lines editor, status buttons, Origen
- Task 28: Cuenta, dimension, fuente, plantilla, período and regla contable records
- Task 29: Períodos, Informes, Reglas contables pages, setup action, home widgets and contributed tabs
- Task 30: i18n catalogues, rule check for PUC codes, assistant evals
- Task 31: Demo seed and end-to-end smoke
- Task 32: User guides, roadmap and hand-off

Related: [[Roadmap]], [[Project Rules]], [[Design Spec Index]], [[10_Projects]].
