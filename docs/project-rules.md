# ERP-IA · Rules of the project

Date: 2026-10-30 (rules 24, 30 updated; 16, 20, 21, 37 on 2026-10-29) · These rules bind every phase, every module and every contributor (human or agent). They come from the design (`docs/superpowers/specs/2026-10-26-erp-ia-design.md`), the phase 1 plan's Global Constraints and the owner decisions of 2026-10-27/28. When a rule and a convenience conflict, the rule wins; changing a rule is an owner decision recorded in the design's §22.

## 1. Architecture
1. **One process registry.** Every state change is a registered process executed through `runProcess`. No module code writes tables outside a process handler. The UI, the assistant, background agents, the scheduler and the public API call the same processes. The assistant has no tool that is not a registered process.
2. **One system of record.** Supabase Postgres. No second database, no cache that owns data.
3. **One schema per module** (`kernel`, `core`, `sales`, …). Cross-module reads only through views the owning module publishes. Cross-module effects only through domain events on the outbox.
4. **Modules are plug-ins.** A module ships a manifest (entities, processes, events, menu items, permissions, sensitive defaults), migrations, handlers and UI. The kernel never knows a module by name. A module can be disabled per tenant and then disappears from menus, exports and the assistant without losing data.
5. **Localization is a pack.** Anything fiscal (identifiers, taxes, documents, reports, validators) lives in `packages/localization/<country>`. Modules call the pack through its interface; they never embed a country rule. Default country `co`, default locale `es-419`, default currency COP.
6. **Portable by construction.** No Vercel-only runtime APIs in business code (no Edge runtime, no `@vercel/*` storage). Durable work only through `workflow`; scheduling only through the kernel scheduler table. The `infra` package exposes `DurableRunner`, `Scheduler`, `ModelProvider`, `FileStore`, `Mailer` with a cloud and a Docker implementation. `docker-compose.yml` runs the integration tests in CI on every push.

## 2. Data
7. Every business table has `id uuid` (v7), `company_id uuid not null`, `created_at`, `updated_at`, `created_by`, `updated_by`, plus `seq bigint` from `core.next_sequence(entity)` (gap-free per company) and `extra jsonb` / `extra_free jsonb` for admin-defined and free extra data.
8. Money is `numeric(18,4)` with currency code and exchange-rate snapshot per document; amounts stored in document currency and company currency. Timestamps `timestamptz`; the tenant's timezone governs scheduling and reports.
9. Documents are voided, never deleted. Soft delete only where the law requires it. Attachments are soft-deleted and stay in the audit.
10. Fiscal master data is complete from day one: parties and products carry every DIAN field (design §5.8a, §5.8b); format errors block the save, missing data sets `dian_status`; a record that is not `invoice_ready` (DIAN complete, required files present, active) cannot be used on any document line.
11. Phones are stored as country code + number and validated; e-mails validated; both expose the external verification hook. Identification numbers are stored without DV, dots or spaces.

## 3. Security
12. RLS on every table in every module schema, reading JWT claims through the kernel helpers. Service role only inside Workflows and route handlers, never in the browser. DIAN certificates and provider keys live in Supabase Vault.
13. Permissions are per process and per role (create, update, delete, consult). Roles are created by the admin and carry the party scope (clientes, proveedores, ambos, ninguno). A user holds one or more roles.
14. Field visibility (`visible | masked | hidden`) is enforced in the SELECT views and therefore identical in grids, forms, exports and the assistant. A masked field never filters or sorts.
15. Sensitive processes require a fresh TOTP step-up (≤ 5 minutes, bound to the verifying user); the admin decides which processes. Admin processes are sensitive by default.
16. Audit is append-only (insert-only grants, trigger on update/delete) with origin `ui | agent | scheduler | event | api | db`, actor, causal chain id, before/after per changed field, 10-year retention. The audit viewer shows the field label, the process description and the entity name from the catalogue, the previous and the new value of every changed field (subject to the viewer's field visibility), and the source record when the row was created by cloning. The single exception is the `telemetry` process kind (adaptive UI events), which is still permissioned and RLS-bound but writes no audit row.
17. The assistant acts strictly as the calling user, receives only the tools that user may run, and never executes a write without an explicit confirmation card; step-up processes ask for the code in the chat. Consult results are capped and masked.
18. Personal usage data (adaptive UI) is never shown per user to anyone, is retained 60 days raw, and stops being captured when the feature is off for the company, the role or the user.

## 4. User interface
19. The shell is the approved one (design §19a, prototype v5): navy top bar with company switcher, Módulos menu listing modules only, the active module's items next to it, tinted tabs row below, ⌘K palette, assistant drawer of 400 px, light / dark / automatic theme from one token table.
20. Every grid is sortable and filterable by every visible column, paginated, exportable to PDF, Excel and CSV (icons red / green / grey) with exactly the visible columns and all pages, importable from an Excel/CSV template with per-row validation, and has the advanced filter popup (every field, rules by type, Y/O with AND precedence, live results, row pick). Columns can be reordered by dragging the header or with the keyboard, and the order is part of the view. Views can be saved per user and promoted per role.
21. Every record opens in the record frame: title with N.º and UUID, open-in-new-browser-tab, tabs `Datos · Contactos · Fotos · Datos adicionales · Archivos` as the entity needs, status footer. Every entity text box has the magnifier for the advanced filter. Every reference to a record of another entity shown anywhere in the UI (grids, forms, audit, assistant results, home) is a link to that record's page.
22. Files: drag-and-drop and chooser, a tag per file, admin-defined required files per entity, confirmation before removal, 25 MB per file, signed downloads.
23. Money renders as `$ 1.234.567,00` (es-CO, two decimals, right-aligned, tabular figures); inputs show raw digits while editing.
24. Spanish (Latam) copy everywhere; every string goes through `packages/i18n` with an `en` catalogue of the same keys; registry keys live in their kind's namespace, a module's page copy in the module's namespace (`accounting.*`, owner 2026-10-30). Fonts Source Sans 3 and JetBrains Mono; 36 px grid rows; 44 px minimum touch targets on POS and mobile.
25. Nothing changes under the user's feet: suggested or promoted UIs are offered and activated only on acceptance; the home layout is the user's own and resettable.

## 5. AI
26. Models only through the AI SDK and the model policy table (`kernel.model_policies`); no model id in code. Defaults: chat and planning `anthropic/claude-opus-5.5`, classification and summaries `anthropic/claude-haiku-5.5`, embeddings `openai/text-embedding-3-small`; every policy has a fallback.
27. Every LLM call is logged with cost per user and company. Token allowance per seat, metered above it, per-company cap the admin can raise; when the cap is hit the assistant answers consult questions only.
28. Background agents run as the audience role's permissions, never above them; their recommendations are offered, never executed without the user's accept.
29. Statistics detect, the model composes: adaptive proposals and recommendations are built from evidence computed in SQL; the model only writes the artifact and the explanation inside a validated schema.
30. A growing evaluation set of Spanish prompts → expected tool calls runs in CI: structurally and on the mock model on every push, against the policy model nightly when the gateway secret is set (every core case and ≥ 90 % overall must pass; owner 2026-10-30).

## 6. Quality and workflow
31. Test first: each task starts with a failing test (Vitest unit, integration against the Docker Supabase stack, Playwright end to end); a task is done when its tests pass and a fresh reviewer approves it.
32. Plans before code: each phase has a written plan derived from the approved design; the plan carries the exact files, interfaces, values and tests; executors do not invent scope. Design changes go back to the design document first.
33. Commits are small and conventional (`feat(core): …`, `fix(kernel): …`), one task per commit, attribution line as configured; no commit or push without the owner asking.
34. Every migration is forward-only, named `NNNN_<module>_<topic>.sql`, applied by the Supabase CLI, covered by an integration test. No manual changes in any database.
35. User guides (`docs/user-guide/es-419`) are written with the feature and indexed for the assistant; a feature without its guide is not finished.
36. Review focus on every phase: tenant isolation under company switch, transaction integrity of `runProcess`, masking in every output channel, idempotent confirmations, step-up binding, invoice readiness, import partial failures.
37. **Cloning.** Every entity with a create process offers "Duplicar" on its record frame. The clone runs the entity's create process with the source's visible data and the entity's unique and identity fields cleared (declared on the entity definition); the creation's audit entry records `source_row_id`. No clone bypasses validation, permissions or step-up.

## 7. Owner decisions in force (see design §22)
Multi-company modelled from day one (UI single-company until phase 3) · barcode scanners from v1, ESC/POS in phase 5, no fiscal printer · AI pricing by seat allowance with metering and cap · English in phase 3 · Bold as payment gateway, manual invoicing for enterprise · on-premise in phase 6 · full DIAN party and product data from day one · attachments on every entity · prototype v5 shell and record frame · adaptive UI agent in phase 3 with try/accept, promotion and productivity report.
