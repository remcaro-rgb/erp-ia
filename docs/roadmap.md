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

- **2A · Posting engine and accounting module: done 2026-10-30** (tag `phase-2a-accounting`; design `docs/superpowers/specs/2026-10-28-accounting-module-design.md`, plan `docs/superpowers/plans/2026-10-29-phase-2-accounting.md`, 32 tasks; user guides in `docs/user-guide/es-419/contabilidad/`). Delivered: posting engine and chart of accounts (PUC) with journals (Fuentes), periods and year close, analytic dimensions (cost centers, auxiliares abiertos, ítems, unidades de negocio), the thirteen fiscal and control reports, the Movimientos ledger-line query page with multi-filter, multi-sort and grouped aggregates (owner 2026-10-29), exógena with concept mapping, aging, security by account, the controls of the design §5.12 (four-eyes on manual entries, auto-reversing accruals, subledger tie-out and suspense check at close, auditor extract), the default posting-rule templates as fixtures, the demo ledger for Café del Norte and the assistant evals. Exit criteria met for 2A: ledger, fiscal reports and controls work on the demo company end to end; the "quote → … → ledger" chain and the DIAN invoice remain 2B. Open items carried forward: the exógena XML has a process (`accounting.report.exogena_xml`) but no button on the report page; the assistant evals are structural (no model call); the "Cerrar año" flow has no e2e; no top-level `accounting.*` i18n namespace. These, plus the restricted-row totals, the "Sin acceso" note, Devolver a borrador, the masters' Tabla figure, the FE-1234 eval, the restricted Cuenta frame and the guide screenshots, are planned in `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (10 tasks; owner decisions OD-1–OD-4 taken 2026-10-30, main design §22.20; all 10 tasks executed and merged).
- **2A.5 · Entity types Maestro / Documento: done 2026-11-03** (design `docs/superpowers/specs/2026-11-02-entity-types-design.md`, owner decisions D1–D19 of 2026-11-02, main design §22.23 and §22.24; plan `docs/superpowers/plans/2026-11-02-phase-2a5-entity-types.md`, Tasks 1–17 with 14b; user guides `maestros-y-documentos.md`, `plantillas-pdf.md`, `notificaciones.md`, `acceso-por-registro.md` and the refreshed core, accounting, import, export, assistant and navigation guides in `docs/user-guide/es-419/`). Delivered: kernel entity types (maestro, documento, lines, parametro, sistema) with the generic lifecycle (Guardar, Guardar y enviar a aprobación, Aprobar, No aprobar, Anular, Eliminar; posting in the same transaction), the «ID» (gap-free `seq` candidate key, D16), snapshots and the Versiones tab, PDF templates and Imprimir for records and lists, state e-mails and Notificar (Bcc, mail log, lease claim), record-level access (Acceso tab) and menu access, Datos adicionales, import/export for every typed entity (documentos header + lines), the four-section module menu, shell v7 (side menu of module names, sections in the top bar), core masters and accounting entries migrated onto it, and the assistant tools for every typed process (writes, Notificar included, behind confirmation cards; a record the caller cannot modify refused before any card). Not committed or pushed at close (owner's word); CI on push pending. Items parked for the phase's final review are listed in `.superpowers/sdd/2026-11-02-phase-2a5-entity-types/progress.md`.
- **2B · Sales and stock chain (plan and prototype approved 2026-11-04, main design §22.25; execution not yet ordered; split 2B.1 Tasks 1–27 and 2B.2 Tasks 28–30)**: plan `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, prototype `docs/superpowers/specs/2026-11-04-erp-ia-prototype-2b-sales-chain.html`; CRM, sales, invoicing with DIAN, inventory and warehouse, costing, payments; each module ships its `postingRules` for the §5.4 events by relocating the 2A fixtures unchanged, plus its "Contabilidad" integration. Exit criteria below.
- **2C · Puesta en marcha** (the "Phase 2b · Puesta en marcha" section below): opening balances over `accounting.opening.create`, import framework, Siigo / Alegra connectors, posting window per role.
- CRM: leads, opportunities, pipelines, activities, quotes.
- Sales: orders, deliveries, returns; commissions in 2B.2 (parametric basis, CxP provision; owner 2026-11-04).
- Invoicing: invoices, credit/debit notes, DIAN electronic invoicing (UBL 2.1, signing, submission, CUFE, PDF) porting the Serena `src/lib/dian` code; `invoice_ready` enforced on every document line.
- Inventory and warehouse: stock by warehouse / location, movements, transfers, counts (2B.1); lot / serial, picking, packing and put-away follow in 2B.2 (owner 2026-11-04).
- Costing: weighted average, landed costs, COGS (FIFO moves to phase 3, owner 2026-11-04).
- Payments: customer receipts, allocations, cash boxes.
- Colombia pack (part 2): taxes, withholdings, DIAN sequences and resolutions, exógena export.
- Assistant gains the sales tools (quote, order, invoice through confirmation cards) and KPIs on the home.

Exit criteria (phase 2 as a whole; 2A delivers the ledger, the fiscal reports and exógena, 2B the chain): quote → order → delivery → DIAN invoice → payment → ledger, each step audited with one causal chain; exógena and fiscal reports exportable.

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
- **AI knowledge base (Estatuto Tributario)**: `docs/assets/estatuto-tributario/estatuto_tributario_vectorizado.txt` (added 2026-11-03) is to be indexed when the assistant's tax-knowledge task starts. Take into account then: (1) chunk per `[ARTICULO: n]`, carrying the `[METADATA: ...]` Libro/Título/Tema hierarchy as chunk metadata and the article number as the citation key; (2) it is fiscal content for country `co`, so it lives with the localization pack (`packages/localization/co`) and is retrieved only for companies with that pack, never hard-coded in the generic kernel (rule: fiscal logic only in `packages/localization`); (3) answers must cite the article, state the text's currency date (October 2026) and say it is not legal advice; (4) embeddings through the AI SDK and `kernel.model_policies`, every call metered; (5) re-importable when the Estatuto changes (store a source version/date); (6) read-only knowledge, no tool or write path; (7) the decree's final articles sit under their own metadata section at the end of the file, check the parser handles them.
- **Documentation**: user guides in `docs/user-guide/es-419` are written with each phase and indexed for the assistant.
- **Quality**: every task starts with a failing test; integration tests run against the Docker stack in CI; a whole-branch review closes each phase.

## What is not planned
Hard delete of documents (voids only), fiscal printers, Stripe (Bold instead), a native mobile app (conversation-first mobile web instead), automatic activation of AI-suggested UIs.
