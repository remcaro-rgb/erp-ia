---
tags: [area, rules]
date: 2026-11-07
status: active
---

# Project Rules

Source: `docs/project-rules.md` (binding, 37 rules). Condensed here; the file is the authority.

## 1. Architecture
- **1.** One process registry
- **2.** One system of record
- **3.** One schema per module (kernel, core, sales, …)
- **4.** Modules are plug-ins
- **5.** Localization is a pack
- **6.** Portable by construction

## 2. Data
- **7.** Every business table has id uuid (v7), company_id uuid not null, created_at, updated_at, created_by, updated_by, plus seq bigint from core.next_sequence(entity) (gap-free per company) and extra jsonb / extra_free jsonb f
- **8.** Money is numeric(18,4) with currency code and exchange-rate snapshot per document; amounts stored in document currency and company currency
- **9.** Documents are voided, never deleted; a documento still in Borrador (never numbered) may be deleted (design §22.23)
- **10.** Fiscal master data is complete from day one: parties and products carry every DIAN field (design §5.8a, §5.8b); format errors block the save, missing data sets dian_status; a record that is not invoice_ready (DIAN comple
- **11.** Phones are stored as country code + number and validated; e-mails validated; both expose the external verification hook

## 3. Security
- **12.** RLS on every table in every module schema, reading JWT claims through the kernel helpers
- **13.** Permissions are per process and per role (create, update, delete, consult)
- **14.** Field visibility (visible | masked | hidden) is enforced in the SELECT views and therefore identical in grids, forms, exports and the assistant
- **15.** Sensitive processes require a fresh TOTP step-up (≤ 5 minutes, bound to the verifying user); the admin decides which processes
- **16.** Audit is append-only (insert-only grants, trigger on update/delete) with origin ui | agent | scheduler | event | api | db, actor, causal chain id, before/after per changed field, 10-year retention
- **17.** The assistant acts strictly as the calling user, receives only the tools that user may run, and never executes a write without an explicit confirmation card; step-up processes ask for the code in the chat
- **18.** Personal usage data (adaptive UI) is never shown per user to anyone, is retained 60 days raw, and stops being captured when the feature is off for the company, the role or the user.

## 4. User interface
- **19.** The shell is shell v7 (owner 2026-11-02, design §22.24, prototype docs/superpowers/specs/2026-10-31-erp-ia-prototype-v7-shell.html): a collapsible left side menu listing module names only (e.g
- **20.** Every grid is sortable and filterable by every visible column, paginated, exportable to PDF, Excel and CSV (icons red / green / grey) with exactly the visible columns and all pages, importable from an Excel/CSV template 
- **21.** Every record opens in the record frame: title with N.º and UUID, open-in-new-browser-tab, tabs Datos · Contactos · Fotos · Datos adicionales · Archivos as the entity needs, status footer
- **22.** Files: drag-and-drop and chooser, a tag per file, admin-defined required files per entity, confirmation before removal, 25 MB per file, signed downloads.
- **23.** Money renders as $ 1.234.567,00 (es-CO, two decimals, right-aligned, tabular figures); inputs show raw digits while editing.
- **24.** Spanish (Latam) copy everywhere; every string goes through packages/i18n with an en catalogue of the same keys; registry keys live in their kind's namespace, a module's page copy in the module's namespace (accounting.*, 
- **25.** Nothing changes under the user's feet: suggested or promoted UIs are offered and activated only on acceptance; the home layout is the user's own and resettable.

## 5. AI
- **26.** Models only through the AI SDK and the model policy table (kernel.model_policies); no model id in code
- **27.** Every LLM call is logged with cost per user and company
- **28.** Background agents run as the audience role's permissions, never above them; their recommendations are offered, never executed without the user's accept.
- **29.** Statistics detect, the model composes: adaptive proposals and recommendations are built from evidence computed in SQL; the model only writes the artifact and the explanation inside a validated schema.
- **30.** A growing evaluation set of Spanish prompts → expected tool calls runs in CI: structurally and on the mock model on every push, against the policy model nightly when the gateway secret is set (every core case and ≥ 90 % 

## 6. Quality and workflow
- **31.** Test first: each task starts with a failing test (Vitest unit, integration against the Docker Supabase stack, Playwright end to end); a task is done when its tests pass and a fresh reviewer approves it.
- **32.** Plans before code: each phase has a written plan derived from the approved design; the plan carries the exact files, interfaces, values and tests; executors do not invent scope
- **33.** Commits are small and conventional (feat(core): …, fix(kernel): …), one task per commit, attribution line as configured; no commit or push without the owner asking.
- **34.** Every migration is forward-only, named NNNN_<module>_<topic>.sql, applied by the Supabase CLI, covered by an integration test
- **35.** User guides (docs/user-guide/es-419) are written with the feature and indexed for the assistant; a feature without its guide is not finished.
- **36.** Review focus on every phase: tenant isolation under company switch, transaction integrity of runProcess, masking in every output channel, idempotent confirmations, step-up binding, invoice readiness, import partial failu
- **37.** Cloning

## 7. Owner decisions in force (see design §22)

Related: [[Design Spec Index]], [[Owner Decisions]], [[Architecture Overview]].
