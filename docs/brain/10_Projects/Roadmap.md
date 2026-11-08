---
tags: [project, roadmap]
date: 2026-11-07
status: active
---

# Roadmap

Source: `docs/roadmap.md`. Owner: Manuel Caro.

## Phase overview
| Phase | Name | Delivers to the customer | Depends on |
|---|---|---|---|
| 1 | Fundación | Login with 2FA, shell, terceros and productos ready for DIAN, categorías, archivos, datos adicionales, import/export, roles and users, assistant that consults, creates and explains, support and help | — |
| 2 | De la venta al cobro | CRM, ventas, facturación electrónica DIAN, inventario, bodegas, costeo, pagos, contabilidad; the sale flow end to end | 1 |
| 2b | Puesta en marcha | Data import framework, onboarding agent, connectors from Siigo and Alegra | 2 |
| 3 | De la compra al pago y dinero | Compras, bancos y conciliación, finanzas, activos, programador de tareas, mensajería, agentes de fondo, multiempresa, inglés, cobro con Bold, **agente de UI adaptativa** | 2 |

## Phase 1 · Fundación (plan written, 24 tasks)
Goal: the kernel every module will stand on, plus the parts of the core a company can already use daily.

**Kernel**: tenant → companies, JWT claims, RLS helpers; entity registry with field visibility (visible / masked / hidden) applied to grids, forms, exports and assistant; process registry with `runProcess` (permission, validation, transaction, audit, outbox); domain events and outbox dispatch; module manifests and entitlements per tenant; append-only audit with origins `ui | agent | scheduler | event | api | db` and causal chain; sequences (UUID v7 + gap-free consecutive per entity); attachments with tags and admin-defined required files; custom fields (datos adicionales) with constraints and role security; verification hooks for e-mail, phone and identification (provider chosen later); mass import from Excel/CSV templates; saved views; user preferences (theme, tabs, home layout).

**Colombia pack (part 1)**: `validateParty` and `validateProduct` with the DIAN tables (document types, DV, responsibilities, tributos, DANE, UoM UN/ECE, item schemes, GTIN); `dian_status` and `invoice_ready` on parties and products.


## Phase 2 · De la venta al cobro
Goal: the §8.1 sale flow works end to end with legal Colombian invoices.

- **2A · Posting engine and accounting module: done 2026-10-30** (tag `phase-2a-accounting`; design `docs/superpowers/specs/2026-10-28-accounting-module-design.md`, plan `docs/superpowers/plans/2026-10-29-phase-2-accounting.md`, 32 tasks; user guides in `docs/user-guide/es-419/contabilidad/`). Delivered: posting engine and chart of accounts (PUC) with journals (Fuentes), periods and year close, analytic dimensions (cost centers, auxiliares abiertos, ítems, unidades de negocio), the thirteen fiscal and control reports, the Movimientos ledger-line query page with multi-filter, multi-sort and grouped aggregates (owner 2026-10-29), exógena with concept mapping, aging, security by account, the controls of the design §5.12 (four-eyes on manual entries, auto-reversing accruals, subledger tie-out and suspense check at close, auditor extract), the default posting-rule templates as fixtures, the demo ledger for Café del Norte and the assistant evals. Exit criteria met for 2A: ledger, fiscal reports and controls work on the demo company end to end; the "quote → … → ledger" chain and the DIAN invoice remain 2B. Open items carried forward: the exógena XML has a process (`accounting.report.exogena_xml`) but no button on the report page; the assistant evals are structural (no model call); the "Cerrar año" flow has no e2e; no top-level `accounting.*` i18n namespace. These, plus the restricted-row totals, the "Sin acceso" note, Devolver a borrador, the masters' Tabla figure, the FE-1234 eval, the restricted Cuenta frame and the guide screenshots, are planned in `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (10 tasks; owner decisions OD-1–OD-4 taken 2026-10-30, main design §22.20; all 10 tasks executed and merged).
- **2A.5 · Entity types Maestro / Documento: done 2026-11-03** (design `docs/superpowers/specs/2026-11-02-entity-types-design.md`, owner decisions D1–D19 of 2026-11-02, main design §22.23 and §22.24; plan `docs/superpowers/plans/2026-11-02-phase-2a5-entity-types.md`, Tasks 1–17 with 14b; user guides `maestros-y-documentos.md`, `plantillas-pdf.md`, `notificaciones.md`, `acceso-por-registro.md` and the refreshed core, accounting, import, export, assistant and navigation guides in `docs/user-guide/es-419/`). Delivered: kernel entity types (maestro, documento, lines, parametro, sistema) with the generic lifecycle (Guardar, Guardar y enviar a aprobación, Aprobar, No aprobar, Anular, Eliminar; posting in the same transaction), the «ID» (gap-free `seq` candidate key, D16), snapshots and the Versiones tab, PDF templates and Imprimir for records and lists, state e-mails and Notificar (Bcc, mail log, lease claim), record-level access (Acceso tab) and menu access, Datos adicionales, import/export for every typed entity (documentos header + lines), the four-section module menu, shell v7 (side menu of module names, sections in the top bar), core masters and accounting entries migrated onto it, and the assistant tools for every typed process (writes, Notificar included, behind confirmation cards; a record the caller cannot modify refused before any card). Not committed or pushed at close (owner's word); CI on push pending. Items parked for the phase's final review are listed in `.superpowers/sdd/2026-11-02-phase-2a5-entity-types/progress.md`.
- **2B · Sales and stock chain (plan and prototype approved 2026-11-04, main design §22.25; split 2B.1 Tasks 1–27 and 2B.2 Tasks 28–30)**: plan `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, prototype `docs/superpowers/specs/2026-11-04-erp-ia-prototype-2b-sales-chain.html`.
  - **2B.1 · done 2026-11-05 (implementation; not committed or pushed, owner's word; CI on push pending).** Run ledger `.superpowers/sdd/2026-11-03-phase-2b-sales-stock-chain/progress.md` (Tasks 1–27, plus 14b CRM and sales pages and 24b payments pages, both added by the controller; migrations 0065–0114). Shipped:

## Phase 2b · Puesta en marcha (plan 2C of the accounting plan)
Goal: a company migrates from its previous system in days, not months.
- Import framework for every entity and opening balances (§5.11 of the design) built on the phase 1 importer.
- Onboarding agent (§7.3): reads the company's files, proposes mappings, validates with the same rules, reports gaps.
- Connectors: Siigo and Alegra (port of Serena's Siigo code).
- Posting window per role: how many days back a role may date an entry, independent of period status (accounting best-practice review, owner 2026-10-28).

## Phase 3 · De la compra al pago y dinero
Goal: purchases, money and the first background agents.
- Purchases: requests, purchase orders, receipts, supplier invoices, documento soporte.
- Bank: statements import (OFX/CSV/Excel), reconciliation sessions, matching rules with agent-assisted suggestions.
- Finance: budgets, cash-flow forecast, treasury positions, loans; from the accounting best-practice review (owner 2026-10-28): scheduled entry templates on the scheduler, FX revaluation of monetary items (IAS 21), step-down cost allocations between dimensions, deferral schedules for prepaid expenses and deferred revenue, management chart mapping and XBRL export for Supersociedades. Later, not placed: prior-period error marker for the notes.
- Fixed assets: capitalization, depreciation, disposals.
- Costing: FIFO method (moved from 2B, owner 2026-11-04).

## Phase 4 · Personas
Goal: payroll legal in Colombia.
- Timekeeping: shifts, clock in/out, absences, overtime, approvals.
- Payroll: contracts, concepts, payroll runs with step-up, payslips, social security, nómina electrónica DIAN, PILA.

Exit criteria: a monthly payroll run produces payslips, the electronic payroll accepted by DIAN and the PILA file.

## Phase 5 · Punto de venta y constructores
Goal: sell at the counter and let users build their own screens.
- POS as an offline PWA on tablet: catalogue, ticket, payments, barcode scanner, cash session, offline queue, ESC/POS printing and cash drawer through a local agent; DIAN electronic POS document.
- Form builder and report builder driven by the assistant (`forms.create`, `reports.create`): custom entities as real tables with RLS, permissions and audit.
- Simulations (what-if on prices, costs, cash).
- Real image model behind "Sugerir foto con IA".


## Phase 6 · Segundo país y on-premise
- Second localization pack (Mexico or Peru) proving the country-pack boundary: taxes, documents, identifiers, reports.
- On-premise delivery: self-hosted Supabase, Next.js standalone, Workflow Postgres World, licence file for entitlements, customer-provided AI keys.

Exit criteria: the same codebase runs for a company in the second country and for a customer on their own servers.

Plans: [[Plan phase-1-foundation]], [[Plan phase-1b-density-and-audit]], [[Plan phase-1c-mfa-opt-out]], [[Plan phase-2-accounting]], [[Plan phase-2a-gaps-plan-prompt]], [[Plan phase-2a-gaps]], [[Plan shell-v7-sidebar]], [[Plan ui-ux-remediation-prompt]], [[Plan ui-ux-remediation]], [[Plan phase-2a5-entity-types]], [[Plan phase-2b-sales-stock-chain]], [[Plan phase-2b-owner-decisions-pending]]
