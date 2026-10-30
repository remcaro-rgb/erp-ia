# ERP-IA · Roadmap

Date: 2026-10-28 · Owner: Manuel Caro · Status: approved scope, phase 1 ready to start
Sources: design `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (§8 modules, §17 phasing, §22 owner decisions), phase 1 plan `docs/superpowers/plans/2026-10-27-phase-1-foundation.md`, prototype v5 `docs/superpowers/specs/2026-10-27-erp-ia-phase1-prototype.html`, adaptive UI design `docs/superpowers/specs/2026-10-28-adaptive-ui-agent-design.md`.

## Principles that shape every phase
- Each phase produces working software a company can use on its own; the next phase starts when the previous one is in production.
- Every business action is a **process** (one registry; UI, assistant, scheduler, API and background agents run the same processes under the same permissions and audit). Nothing in a later phase bypasses this.
- Colombia first (DIAN electronic invoicing, exógena, nómina electrónica, PILA), Spanish Latam UI, English plumbing from day one, second country only in phase 6.
- Cloud on Supabase + Vercel; `docker-compose` with the Workflow Postgres World runs in CI from phase 1 so on-premise stays possible.
- Each phase gets its own written plan (task by task, tests first) written when the previous phase is done. Only phase 1 has a plan today.

## Phase overview

| Phase | Name | Delivers to the customer | Depends on |
|---|---|---|---|
| 1 | Fundación | Login with 2FA, shell, terceros and productos ready for DIAN, categorías, archivos, datos adicionales, import/export, roles and users, assistant that consults, creates and explains, support and help | — |
| 2 | De la venta al cobro | CRM, ventas, facturación electrónica DIAN, inventario, bodegas, costeo, pagos, contabilidad; the sale flow end to end | 1 |
| 2b | Puesta en marcha | Data import framework, onboarding agent, connectors from Siigo and Alegra | 2 |
| 3 | De la compra al pago y dinero | Compras, bancos y conciliación, finanzas, activos, programador de tareas, mensajería, agentes de fondo, multiempresa, inglés, cobro con Bold, **agente de UI adaptativa** | 2 |
| 4 | Personas | Tiempos, nómina electrónica, PILA | 3 |
| 5 | Punto de venta y constructores | POS en tablet (offline), constructor de formularios y reportes desde el chat, simulaciones, impresión ESC/POS | 2 (POS), 3 (builders) |
| 6 | Segundo país y on-premise | Second localization pack, on-premise delivery with licence file | 3 |

## Phase 1 · Fundación (plan written, 24 tasks)
Goal: the kernel every module will stand on, plus the parts of the core a company can already use daily.

**Kernel**: tenant → companies, JWT claims, RLS helpers; entity registry with field visibility (visible / masked / hidden) applied to grids, forms, exports and assistant; process registry with `runProcess` (permission, validation, transaction, audit, outbox); domain events and outbox dispatch; module manifests and entitlements per tenant; append-only audit with origins `ui | agent | scheduler | event | api | db` and causal chain; sequences (UUID v7 + gap-free consecutive per entity); attachments with tags and admin-defined required files; custom fields (datos adicionales) with constraints and role security; verification hooks for e-mail, phone and identification (provider chosen later); mass import from Excel/CSV templates; saved views; user preferences (theme, tabs, home layout).

**Colombia pack (part 1)**: `validateParty` and `validateProduct` with the DIAN tables (document types, DV, responsibilities, tributos, DANE, UoM UN/ECE, item schemes, GTIN); `dian_status` and `invoice_ready` on parties and products.

**Core module**: terceros (contacts, dual e-mails, phone with country code, party scope by role), productos, categorías with inherited taxes, product photos with AI suggestion.

**Shell and UI** (prototype v5 is the contract; the 2026-10-29 density decisions of design §22.11–16 extend it: movable columns, sticky identity column, tfoot totals, scrolling tabs, batch admin changes, cloning, audit before/after, entity links, editable users): navy top bar with module menu and module items, tabs row, dark mode, record frame with tabs and open-in-new-tab, universal DataGrid (sort, filter, advanced filter popup with Y/O, pagination, column visibility, export PDF/Excel/CSV, import), entity lookup with magnifier, home with draggable and resizable widgets, ⌘K palette.

**Security**: login + optional TOTP, step-up for sensitive processes (5-minute freshness), roles created by the admin with party scope, users with e-mail, cellphone, roles and photo, permission matrix with entity names, field visibility matrix, sensitive processes, modules on/off.

**AI**: assistant drawer that consults data, navigates, explains how to use the app from the indexed guides, creates tickets, creates and edits terceros through confirmation cards (with 2FA in chat), model policy table, usage and cost per user and company.

**Support**: tickets with conversation, attachments and extra data; help knowledge base indexed with pgvector.

**Infra**: pnpm monorepo, Next.js 16, Supabase migrations, Vitest + Playwright, `docker-compose` with Postgres World in CI, seed company Café del Norte S.A.S. (NIT 900373115-3).

Exit criteria: a company can register its terceros and productos complete for DIAN, import them, control who sees what, and ask the assistant to do it; all of this under audit.

## Phase 2 · De la venta al cobro
Goal: the §8.1 sale flow works end to end with legal Colombian invoices.

- Posting engine (journal rules per event) and accounting module (design approved 2026-10-29; plan `docs/superpowers/plans/2026-10-29-phase-2-accounting.md`, awaiting the owner's go to execute): chart of accounts (PUC), journals, periods, analytic dimensions (cost centers, auxiliares abiertos, ítems, unidades de negocio), fiscal reports, the Movimientos ledger-line query page with multi-filter, multi-sort and grouped aggregates (owner 2026-10-29), exógena with concept mapping, aging, and the controls of the accounting design §5.12 (four-eyes on manual entries, auto-reversing accruals, subledger tie-out and suspense check at close, auditor extract) — owner decisions of 2026-10-28.
- CRM: leads, opportunities, pipelines, activities, quotes.
- Sales: orders, deliveries, returns, commissions.
- Invoicing: invoices, credit/debit notes, DIAN electronic invoicing (UBL 2.1, signing, submission, CUFE, PDF) porting the Serena `src/lib/dian` code; `invoice_ready` enforced on every document line.
- Inventory and warehouse: stock by warehouse / location / lot / serial, movements, transfers, counts, picking and packing.
- Costing: weighted average (FIFO optional), landed costs, COGS.
- Payments: customer receipts, allocations, cash boxes.
- Colombia pack (part 2): taxes, withholdings, DIAN sequences and resolutions, exógena export.
- Assistant gains the sales tools (quote, order, invoice through confirmation cards) and KPIs on the home.

Exit criteria: quote → order → delivery → DIAN invoice → payment → ledger, each step audited with one causal chain; exógena and fiscal reports exportable.

## Phase 2b · Puesta en marcha
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
- Scheduler ("cada lunes a las 5:00 envía el reporte de ventas") and messaging (e-mail, WhatsApp through adapter).
- Background agents per role: Sales Coach, Collections, Treasury, Inventory Risk; recommendations inbox.
- **Adaptive UI agent**: per-user usage evidence → suggested views with Probar / Aceptar / Descartar, promotion to roles, productivity report per process and global (approved 2026-10-28).
- Multi-company switcher and consolidated reports; English locale; Bold billing for the platform's own subscriptions (port of Serena's Bold adapter); external verification providers connected.

Exit criteria: purchase → receipt → supplier invoice → payment → bank reconciliation end to end; a sales manager receives useful daily recommendations; a user accepts a suggested view and the productivity report shows the gain.

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

Exit criteria: a store sells offline for a day and syncs without loss; a user creates a custom entity and a report by chatting.

## Phase 6 · Segundo país y on-premise
- Second localization pack (Mexico or Peru) proving the country-pack boundary: taxes, documents, identifiers, reports.
- On-premise delivery: self-hosted Supabase, Next.js standalone, Workflow Postgres World, licence file for entitlements, customer-provided AI keys.

Exit criteria: the same codebase runs for a company in the second country and for a customer on their own servers.

## Cross-phase tracks
- **Security**: process-level permissions, RLS, field visibility, 2FA and step-up exist from phase 1; every new module registers its processes and sensitive ones.
- **AI cost**: token allowance per seat with metering above it and a per-company cap, dashboard and alerts from phase 1; cheap tasks route to Haiku automatically.
- **Localization**: everything fiscal lives in `packages/localization/<country>`; modules never hard-code a country rule.
- **Documentation**: user guides in `docs/user-guide/es-419` are written with each phase and indexed for the assistant.
- **Quality**: every task starts with a failing test; integration tests run against the Docker stack in CI; a whole-branch review closes each phase.

## What is not planned
Hard delete of documents (voids only), fiscal printers, Stripe (Bold instead), a native mobile app (conversation-first mobile web instead), automatic activation of AI-suggested UIs.
