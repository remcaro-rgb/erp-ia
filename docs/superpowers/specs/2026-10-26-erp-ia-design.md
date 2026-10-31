# ERP-IA: AI-first ERP + CRM — Design

Date: 2026-10-26
Status: draft for review
Companion visual: `2026-10-26-erp-ia-architecture.html` (same folder)

## 1. Intent

Build a multi-tenant ERP + CRM where the AI agent is a first-class user of the system, not a chat widget bolted on. Every business action is modelled once as a **Process**; the UI, the chat agent, the background agents, the scheduler and the public API all execute the same processes under the same permissions and the same audit trail. That single rule is what makes "anything a user can do manually, the agent can do" true by construction instead of by maintaining a parallel tool list.

Target customer: small and mid-sized companies in Latin America, starting with Colombia. UI language: Spanish (Latam). Hosting: Supabase (Postgres, Auth, Storage, Realtime) + Vercel (Next.js, AI SDK, Workflow, Cron).

## 2. Goals, non-goals, anti-goals

**Goals**
- Full operational coverage: sales, CRM, purchases, payments, bank reconciliation, invoicing, inventory, costing, warehouse, accounting, finance, payroll, timekeeping, fixed assets, point of sale.
- Modules are fully integrated through domain events; one sale produces invoice, stock movements, cost of goods, journal entries, receivable and CRM activity with no manual step.
- Agent chat that can create forms and reports, answer questions on data, run processes, generate documents, run simulations, send messages, schedule recurring tasks, explain how to use the app, file bugs and open support tickets.
- Background agents that produce proactive, role-aware recommendations.
- Localizable fiscal layer; Colombia is the first country pack.
- Process-level security (create / update / delete / consult per process), Row Level Security, field-level visibility, full audit, optional 2FA for login and for admin-defined sensitive processes.
- Every grid sortable and filterable on every column; every grid and report exportable to PDF, Excel, CSV.
- New modules can be added without touching the kernel.

**Non-goals (v1)**
- Native mobile apps. The web app is responsive and the POS is an installable PWA.
- Manufacturing (MRP, BOM routing). Costing covers purchased goods and simple assemblies only.
- Multi-currency consolidation across companies. Multi-currency documents yes; group consolidation no.
- Marketplace for third-party modules. The module contract is designed for it, the store is not built.

**Anti-goals (what would make it a failure even if it works)**
- An agent that can do things a user can't, or that bypasses permissions, 2FA or audit.
- Integration implemented as hard-coded cross-module function calls instead of events and posting rules. That kills the "add a module" promise.
- Fiscal logic (taxes, numbering, e-invoicing) scattered through module code instead of inside the country pack.
- A UI where grids, filters and exports are implemented per screen.

## 3. Constraints

- Supabase Postgres is the single system of record. No second database.
- Vercel serverless and Workflow for compute; no long-lived servers. Anything over a few seconds or that must survive a crash runs as a Workflow.
- LLM access through Vercel AI Gateway with Claude models (Claude Opus 5.5 for the chat agent and planning, Claude Haiku 5.5 for cheap classification and background scans). Provider is swappable at the gateway.
- Spanish (Latam) is the default locale for UI, agent and generated documents; English is a second locale from day one so i18n is never retrofitted.
- Colombian peso (COP) default currency, with per-document currency and exchange rates.

## 4. Stack (my call, override freely)

| Layer | Choice | Why |
|---|---|---|
| Web app | Next.js (App Router) on Vercel, TypeScript | Server components for data-heavy screens, Server Actions for processes, streaming for chat |
| UI | shadcn/ui + Tailwind CSS v4, TanStack Table for grids, React Hook Form + Zod for forms | Composable, no licence, strong grid primitives |
| DB / Auth / Files / Realtime | Supabase | RLS native, MFA (TOTP) native, Storage for PDFs, Realtime for notifications |
| Durable execution | Vercel Workflow DevKit (`"use workflow"` / `"use step"`) + the AI SDK `WorkflowAgent` from `@ai-sdk/workflow` (durable agent; the earlier `DurableAgent` of `@workflow/ai` is deprecated) | Agent runs, event consumers, scheduled jobs and e-invoicing submissions must survive crashes and retry |
| Scheduling | `scheduled_tasks` table + one Vercel Cron tick per minute that starts due Workflows | Keeps cron definitions in the tenant's data, not in `vercel.json` |
| AI | Vercel AI SDK + AI Gateway, Claude models, `pgvector` for the help/knowledge index | Tool calling, streaming UI, provider abstraction |
| Reports / exports | Server-side: `exceljs` (xlsx), `@react-pdf/renderer` (pdf), streaming CSV. Large exports run as a Workflow and land in Storage | Same export service for grids and reports |
| Email / messaging | Resend (email), WhatsApp Business API adapter (optional), in-app notifications over Realtime | |
| Monorepo | pnpm + Turborepo: `apps/web`, `apps/pos`, `packages/kernel`, `packages/modules/*`, `packages/localization/*`, `packages/ui`, `packages/agent` | Modules are packages |
| Testing | Vitest (unit, process tests against a Supabase branch DB), Playwright (e2e), `@workflow/vitest` for workflows | |

## 5. Kernel: the abstractions everything else is built on

The kernel is `packages/kernel`. Modules depend on it; it depends on no module.

### 5.1 Tenant and identity
- `tenants` (one per company group), `companies` (legal entity, fiscal data, country pack), `users`, `memberships` (user × company × roles). Every business row carries `company_id`; RLS policies are generated from that column.
- Supabase Auth with email + password, magic link and optional TOTP MFA. Session JWT carries `tenant_id`, `company_ids`, `role_ids` as claims via a custom access-token hook so RLS can evaluate without joins.

### 5.2 Module manifest
Each module exports a manifest the kernel registers at boot:

```ts
defineModule({
  id: "sales",
  version: "1.0.0",
  dependsOn: ["core", "inventory", "accounting"],
  entities: [...],      // metadata (see 5.3)
  processes: [...],     // see 5.4
  events: { emits: [...], consumes: [...] },
  postingRules: [...],  // default journal templates
  reports: [...],
  agentTools: [...],    // optional extras beyond auto-derived process tools
  navigation: [...],
  migrations: "./migrations",
  localizationHooks: [...],
})
```

Migrations live with the module and are applied by the kernel in dependency order. Enabling a module for a company is a row in `company_modules`.

### 5.3 Entity and field metadata registry
Every table the user sees is described once: fields, types, labels (i18n keys), relations, which process reads/writes it, sensitivity class. This registry drives:
- Grid columns, sorting and filtering (every field is sortable/filterable because the grid asks the registry, not the screen).
- Auto-generated forms and the agent's JSON schemas.
- Field-level visibility: `field_permissions(role_id, entity, field, mode: visible | masked | hidden)`. Masking is applied in the data access layer (a per-entity `SELECT` view with `CASE` on the caller's role claims) so neither the UI nor the agent ever receives a hidden value.
- Export column selection.

### 5.4 Process registry (the central contract)
A Process is the only way state changes.

```ts
defineProcess({
  id: "sales.order.confirm",
  module: "sales",
  kind: "update",                 // create | update | delete | consult
  input: z.object({ orderId: z.string().uuid() }),
  output: z.object({ invoiceId: z.string().uuid() }),
  description: "Confirma un pedido de venta y dispara facturación, inventario y contabilidad.",
  sensitivity: "normal",          // admin can raise to "step-up" (requires 2FA)
  idempotencyKey: (input) => input.orderId,
  handler: async (ctx, input) => { ... },   // runs in one DB transaction
})
```

Execution pipeline (`runProcess(ctx, id, input)`):
1. Resolve caller (user, or agent acting as user, or scheduler acting as the task owner).
2. Permission check: `process_permissions(role_id, process_id)` must allow this `kind`. Denied → audit + typed error.
3. Step-up check: if the process is in `sensitive_processes` for this company, require a fresh TOTP verification (last 5 minutes) or a stored authorization from a user with the `authorize` permission (used for discounts and voids at POS: cashier triggers, supervisor authorizes on the same screen).
4. Validate input with Zod.
5. Open transaction, run handler, write domain events to `outbox`, write `audit_log` row (who, what, input, diff, origin: ui | agent | scheduler | api, agent run id if any), commit.
6. Outbox is drained by a Workflow that dispatches events to consumers with retry.

Because every process has an id, a schema and a description, the agent's tool list is **generated** from the registry filtered by the caller's permissions. A new module's processes are available to the agent the moment it is registered.

Consult-kind processes (queries, reports) go through the same pipeline minus the transaction, so reads are also audited and permission-checked.

### 5.5 Domain events and the outbox
- Events are typed (`sales.order.confirmed`, `inventory.movement.posted`, `payments.received`...) and carry the full payload needed by consumers.
- `outbox(id, company_id, event, payload, created_at, dispatched_at)`; written inside the process transaction, so events are never lost or duplicated relative to state.
- Consumers are declared per module (`consumes: { "sales.order.confirmed": handleOrderConfirmed }`) and run as Workflow steps with retries and dead-letter on `FatalError`.
- Consumers execute processes too (`inventory.movement.post`), so downstream changes are audited with `origin: event` and the causal chain id.

### 5.6 Posting engine (accounting integration)
Modules never write journal entries directly. They emit events; the posting engine maps events to journal templates:

`posting_rules(company_id, event, template)` where the template says which accounts (by role: `receivable`, `revenue`, `vat_out`, `cogs`, `inventory`...) and which amounts from the payload. Account roles are resolved to real accounts through the company's chart of accounts mapping, which the country pack seeds (PUC for Colombia). Admins can edit rules in the UI; the agent can explain or propose rule changes but changing a posting rule is itself a step-up process.

### 5.7 Sequences and documents
`document_sequences(company_id, document_type, prefix, next, resolution)` with a locking function. Country packs attach legal constraints (Colombian DIAN resolution number, authorized range and validity dates).

### 5.8 Localization packs
`packages/localization/co` implements the `CountryPack` interface:
- chart of accounts seed and account role mapping
- tax engine: VAT (IVA) rates, INC, withholding taxes (ReteFuente, ReteIVA, ReteICA) with bases and thresholds, per-municipality ICA
- fiscal identifiers and validation (NIT with check digit, cédula, tipos de documento DIAN)
- electronic invoicing: UBL 2.1 generation, CUFE, digital signature, submission to DIAN or a technology provider, acknowledgment handling; support documents for non-obligated suppliers; credit/debit notes
- electronic payroll (nómina electrónica) and PILA social security contributions, prestaciones sociales, cesantías, prima, vacaciones, horas extras and recargos per Colombian labour law, UVT and minimum wage tables per year
- fiscal calendar and tax returns summaries (IVA bimestral/cuatrimestral, retenciones mensuales)
- document templates and legal texts

The kernel calls packs through hooks at defined points (`beforeInvoiceIssue`, `computeTaxes`, `validateParty`, `payrollRules`). Adding a country means adding a package, not editing modules.

### 5.8a Party master data required by DIAN (decided 2026-10-27)
The `core.parties` entity captures, from day one, every field the DIAN needs to issue and receive electronic invoices (Anexo técnico FE 1.9, Resolución 165/2023) and to report información exógena (Resolución 227/2025, formatos 1001 and related). The Colombia pack owns the code tables and the validation (`validateParty` hook); the kernel stores the fields. Rules:

| Field | Values / format | Required when | DIAN mapping |
|---|---|---|---|
| `person_type` | `1` jurídica y asimiladas, `2` natural y asimiladas | always | `AdditionalAccountID` |
| `document_type` | `11` registro civil, `12` tarjeta de identidad, `13` cédula de ciudadanía, `21` tarjeta de extranjería, `22` cédula de extranjería, `31` NIT, `41` pasaporte, `42` documento de identificación extranjero, `47` PEP, `48` PPT, `50` NIT de otro país, `91` NUIP | always | `CompanyID@schemeName` |
| `document_number` | digits only for 11, 12, 13, 21, 22, 31, 47, 48, 91 (max 10, PEP/PPT 15); alphanumeric max 20 for 41, 42, 50; stored without DV, dots or spaces; `222222222222` is reserved for the built-in "consumidor final" and cannot be a party | always | `CompanyID` |
| `check_digit` | computed by the DIAN modulus-11 algorithm, never typed | `document_type = 31` | `CompanyID@schemeID` |
| `legal_name` | max 450; for natural persons composed as `apellido1 apellido2 nombre1 nombre2` | jurídica | `RegistrationName` |
| `first_surname`, `second_surname`, `first_name`, `other_names` | max 60 each, no digits; second surname and other names optional | natural | exógena name columns |
| `trade_name` | max 450, optional | — | `PartyName/Name` |
| `tax_responsibilities` | set of `O-13` gran contribuyente, `O-15` autorretenedor, `O-23` agente de retención IVA, `O-47` SIMPLE, `R-99-PN` no responsable; `R-99-PN` is exclusive | always (default `R-99-PN`) | `TaxLevelCode listName="48"` |
| `tax_scheme` | `01` IVA, `04` INC, `ZA` IVA e INC, `ZZ` no aplica; `01` contradicts `R-99-PN` for jurídicas | always (default `ZZ`) | `TaxScheme/ID` |
| `ciiu` | 4 digits, optional | — | `IndustryClassificationCode` |
| `country_code` | ISO 3166-1 alpha-2; the pack maps it to the DIAN numeric country code for exógena (CO = 169) | always (default `CO`) | `Country/IdentificationCode` |
| `department_code`, `municipality_code` | DANE 2 digits and DANE 5 digits (municipality must start with the department); exógena receives them as 2 + 3 digits | `country_code = CO` | `CountrySubentityCode`, `Address/ID` |
| `address_line` | max 200, as in the RUT | always | `AddressLine/Line` |
| `postal_code` | 6 digits, optional | — | `PostalZone` |
| `invoice_email` | valid address, max 100 | customers (to deliver invoices and events) | `Contact/ElectronicMail` |
| `phone` | 7–10 digits | optional | `Contact/Telephone` |

Foreign parties (41, 42, 50) must have `country_code ≠ CO` and carry no DANE codes; domestic document types cannot be used with a foreign country. Format and length violations are `invalid_input` errors and block the save; missing data for e-invoicing or exógena does not block the save but sets a computed `dian_status` (`complete`, `missing: n`, `errors`) shown in grids, exports and the assistant so the onboarding agent and users can close the gaps before Ventas is activated. Payments to unidentified third parties ("cuantías menores", document type 43 in exógena) are produced by the reporting module, never stored as parties.

Lengths 60 / 450 / 200 and the exógena country table come from the DIAN prevalidador XSDs as known at design time; the builder must confirm them against the current prevalidador for the reported year when plan 3 implements the exógena formats.

**Money display**: all monetary values render as `$ 1.234.567,00` (locale `es-CO`, two decimals, thousands separator `.`), right-aligned with tabular figures, in grids, cards, forms (formatted input, raw number while editing) and assistant replies. Exógena files use whole pesos without separators.

### 5.8b Product master data required for the invoice line (decided 2026-10-27)
`core.products` carries what each `InvoiceLine` needs under Anexo FE 1.9 so a product can be invoiced the day Ventas is activated. The Colombia pack owns the tables and `validateProduct`; the kernel stores the fields.

| Field | Values / format | Required | DIAN mapping |
|---|---|---|---|
| `sku` | letters, digits, `.`, `_`, `-`; max 50; unique per company | always | `SellersItemIdentification/ID` |
| `description` | max 300 | always | `Item/Description` |
| `kind` | `good`, `service` (services never track stock) | always | — |
| `id_scheme` | `999` código propio, `010` GTIN (GS1 check digit, padded to 14), `001` UNSPSC (8 digits), `020` partida arancelaria (10 digits) | always (default `999`) | `StandardItemIdentification/ID@schemeID` (table 13.3.5) |
| `standard_code` | per scheme above; empty only with `999` | scheme ≠ 999 | `StandardItemIdentification/ID` |
| `brand`, `model` | max 100, optional | — | `BrandName`, `ModelName` |
| `uom_code` | UN/ECE Rec. 20 code from the DIAN table 13.3.6 (`94` unidad, `KGM`, `LTR`, `HUR`, `BX`…) | always | `InvoicedQuantity@unitCode` |
| `iva_rate` | `19`, `5`, `0` (exento), `EXC` (excluido: no tax line) | always | `TaxScheme 01` + `Percent` (table 13.3.11) |
| `inc_rate` | none, `2`, `4`, `8`, `16` | optional | `TaxScheme 04` |
| `other_taxes` | set of `22` INC bolsas, `32` ICL, `33` INPP, `34` IBUA, `35` ICUI, `23` carbono (table 13.2.2); amounts per unit configured in plan 2 | optional | extra `TaxTotal` lines |
| `list_price` | `numeric(18,4)` > 0 unless `is_free_sample` | always | `Price/PriceAmount` |
| `is_free_sample`, `reference_price_type`, `reference_price` | type `1` valor comercial, `2` valor en inventarios, `3` otro; reference price > 0 when free | free samples | `FreeOfChargeIndicator`, `PricingReference/AlternativeConditionPrice` (table 13.3.10) |
| `standard_cost` | ≥ 0; optional (cost is a costing datum, not a DIAN one: a missing cost never affects `dian_status` or `invoice_ready`; the costing module in phase 2 flags goods without cost) | goods | — |
| `track_stock`, `min_stock` | goods only | — | — |

Format errors block the save; missing data sets `dian_status` exactly as for parties (§5.8a). Products imported with errors (for example price 0 from a legacy system) keep the `errors` status until corrected and cannot be put on an invoice.

### 5.13 Attachments on any entity
Every entity in the registry accepts files. `kernel.attachments(id, company_id, entity, record_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, uploaded_at, removed_at, removed_by)` with company RLS; files live in the Supabase Storage bucket `attachments` under `tenant/company/entity/record_id/`, max 25 MB each, any MIME type, downloaded through signed URLs (60 s). Processes `kernel.attachment.add` (kind update, requires update permission on the owning entity) and `kernel.attachment.remove` (soft delete, kept for audit). The UI shows an attachments panel in every record form and an attachment count column in every grid; the agent gets `attachments.list` and can attach a generated document. Virus scanning and retention policies are left to plan 3.

Decided 2026-10-27 (v5): each attachment carries a **tag** (`tag text not null`) chosen by the uploader from the entity's defined tags or typed freely; the upload UI always offers drag-and-drop as well as a file chooser; removing a file asks for confirmation and runs `kernel.attachment.remove` (soft delete, audited). The admin defines **required files per entity** in `kernel.required_attachments(id, company_id, entity, tag, kind check in ('pdf','image','any'), required bool, condition text null, description)`; `condition` is a pack-provided predicate name (`co`, `co-juridica`, `proveedor`, `cliente`) evaluated against the record. The Colombia seed requires `RUT` (pdf, condition `co`) and `Cámara de Comercio` (pdf, condition `co-juridica`) on parties. A record missing a required file is not `invoice_ready` (§5.17).

### 5.14 Extra data on any entity (Datos adicionales)
Every registered entity has an `extra jsonb not null default '{}'` column plus `extra_free jsonb` (array of `{name, value}` pairs any user may add). The admin defines typed fields in `kernel.custom_fields(id, company_id, entity, key, label, type check in ('text','number','date','bool','list','url','email'), max_length int null, required bool, options text[] null, roles_enter text[], roles_edit text[], roles_view text[])`. Validation (`validateCustomFields(entity, extra) → {errors, missing}`) runs inside the entity's create/update processes: type and length errors block the save; a missing required field counts as missing data for `dian_status`/`invoice_ready`. Visibility follows `roles_view` exactly like `field_permissions` (grid, form, export, agent). This is the lightweight counterpart of §10 custom entities: no new table, no migration, admin self-service from day one.

### 5.15 Identity of every record
Every row has a UUID v7 primary key (kernel) **and** a per-entity consecutive number `seq bigint not null` assigned at creation from `core.next_sequence(entity)` (gap-free, per company). Grids show `N.º`; forms show `N.º` and the short UUID; the human code (`T-001`, SKU, `CAT-001`, `SP-0007`) is derived from `seq` where the entity has one.

### 5.16 Record frame
Every record opens in the same frame: header (title, N.º, UUID, **open in a new browser tab** button that deep-links to `/r/<entity>/<id>` and renders the same form as a full page), tabs `Datos · Contactos (parties) · Fotos (products) · Datos adicionales · Archivos`, footer with the DIAN status and the save button. Phone fields are a country-code select plus number, validated inline (`+57`: 10 digits starting with 3 or 60; other countries 6–14 digits); e-mails validated inline. Each e-mail, phone and identification shows a **Verificar** control bound to `kernel.verifiers(kind, provider, config)`; while no provider is configured the request is queued (`kernel.verification_requests`) and the UI shows "en cola". Providers to choose later: e-mail (ZeroBounce, Hunter…), phone (Twilio Lookup, Numverify…), identification (RUES, DIAN RUT, Registraduría).

### 5.17 Invoice readiness
`invoice_ready(entity, record) → {ok, why[]}` is false when `dian_status ≠ complete`, a required attachment is missing, or the record is not active. Stored as `invoice_ready bool` on `core.parties` and `core.products` (recomputed by the same trigger as `dian_status` and on attachment changes). The sales module (phase 2) rejects any party or product with `invoice_ready = false`; the lookup control (§9) shows them disabled with the reasons.

### 5.18 Party contacts, dual e-mails, categories
- `core.party_contacts(id, seq, company_id, party_id, name, job_title, email, phone_cc, phone, ext, mobile_cc, mobile)` with the same inline validation; shown in the Contactos tab.
- `core.parties` carries `invoice_email` (required when kind includes customer: receives our sales invoices) and `supplier_email` (required when kind includes supplier: receives purchase orders and supporting documents). A party that is both must have both.
- `core.product_categories(id, seq, company_id, name, iva_rate, inc_rate, other_taxes text[], default_uom, income_account, status)` is a master with its own grid and form. A product inherits the category's taxes when the category is chosen; the user may override them (`tax_override bool`, UI shows "modificados respecto a <categoría>" with a reset link). Changing a category never rewrites existing products.
- `core.products.photos` are attachments tagged `Foto` rendered as a carousel (first = principal); **Sugerir foto con IA** calls `ai.image.suggest(description, uom, category)` through the model policy, stores the result tagged `Foto · IA` and marks it until a user approves it.
- Role scope for parties: `kernel.roles.party_scope check in ('ambos','clientes','proveedores','ninguno')`; the grid, exports, lookup and agent filter by it; the Terceros grid also has "Mostrar clientes" / "Mostrar proveedores" switches within the role's scope.

### 5.9 Audit
`audit_log` is append-only (insert-only role, no update/delete grants, plus a trigger that raises on modification). Row-level triggers on every business table also record column diffs so direct DB edits are captured. Audit viewer is itself a consult process with its own permission.

### 5.10 Jobs and scheduling
- `scheduled_tasks(company_id, owner_user_id, cron, timezone, process_id, input, delivery, enabled, last_run, next_run)`.
- A Vercel Cron hits `/api/cron/tick` every minute; it claims due tasks (`SELECT ... FOR UPDATE SKIP LOCKED`) and starts a `runScheduledTask` Workflow for each. The Workflow runs the process **as the owner** (same permissions), renders the output (report → PDF/XLSX) and delivers it (email, WhatsApp, in-app). "Send me the sales report every Monday at 5:00" is a row the agent writes through `scheduler.task.create`.

### 5.11 Data import framework
Imports are first-class processes so onboarding, migrations from other systems and recurring bulk loads share one path.

- `import_jobs(company_id, entity, source: file | api | connector, mapping, status, stats, errors)` and `import_rows(job_id, row_no, raw, normalized, status, error)`.
- Flow: upload (CSV, XLSX, JSON; Supabase Storage) → profile (detect columns, types, encodings, duplicates) → map (column → registered field; the agent proposes the mapping from headers and sample rows, including transforms such as NIT check digit, date formats, UoM) → validate (dry run through the entity's Zod schema and country-pack validators, errors per row) → commit (a Workflow runs the entity's `create` process per row in batches, idempotent on a row hash so a retry never duplicates) → report.
- Opening balances are imports too: chart of accounts, trial balance per account and third party, open receivables and payables, stock by location and lot with cost, fixed assets with accumulated depreciation, employee contracts. The posting engine has an `opening_balance` rule that posts to the opening journal without touching the period's P&L.
- Templates: every importable entity exposes a downloadable XLSX template generated from the registry (Spanish headers, examples, validation lists).
- Connectors (later): Siigo, Alegra, World Office, Contapyme exports, DIAN bulk downloads of received e-invoices (supplier invoices via DIAN's RADIAN), bank statement formats per bank.

### 5.12 Entitlements: modules, features and functions per tenant
Customers buy modules, so what a company can use is a product decision separate from what a role may do.

- `plans(id, name, price, included_modules, limits)` and `tenant_entitlements(tenant_id, company_id?, key, enabled, limits, valid_from, valid_to, source: plan | addon | trial | manual)`.
- Keys are hierarchical: `module:payroll`, `feature:payroll.electronic_payroll`, `process:pos.ticket.void`, `limit:users`, `limit:ai_tokens_month`, `limit:invoices_month`. A feature is a named group of processes, entities, reports and navigation items declared in the module manifest (`features: [{ id, processes, entities, reports, nav }]`).
- Enforcement happens in three places, all reading the same resolver (`entitled(company, key)` cached per request): the process runner (step 2 of the pipeline, before role permission, with a distinct `not_entitled` error), the metadata registry (entities and fields of disabled modules are not served, so grids, exports and agent tool generation never see them) and navigation.
- Disabling a module keeps its data and events (consumers of a disabled module are paused and queued, not dropped) so re-enabling is safe. Cross-module dependencies declared in the manifest are validated when enabling (`invoicing` requires `core`; `pos` requires `inventory` and `invoicing`).
- Trials and add-ons are entitlements with validity dates; the background Treasury agent and the onboarding agent can suggest, never enable, paid modules.
- Admin UI: a modules page per company with on/off, feature toggles inside a module, and usage against limits. Billing integration (Stripe or local provider such as Wompi) writes entitlements through `billing.entitlement.sync`.

## 6. Security model

| Layer | Mechanism |
|---|---|
| Authentication | Supabase Auth, optional TOTP MFA per user, admin can enforce per role; login form with show/hide password and "Recordarme" (30-day persistent session vs browser session) |
| Entitlement | `tenant_entitlements` resolved before permissions; disabled modules are invisible to UI, exports and agent |
| Authorization | `process_permissions(role, process, kind)`; roles are per company, **created by the admin** (`kernel.roles` with name, description, `party_scope`), users assigned to roles and roles to users from either side; a user can hold several. The permission matrix shows the entity name (`Tercero`, `Producto`…) next to each process id |
| Users | Created by the admin with at least e-mail, mobile (country code + number, validated) and one role; photo optional; invitation by e-mail; 2FA activated by the user |
| Row isolation | RLS on every table using JWT claims (`company_id = any(auth.company_ids())`), plus ownership predicates where modules need them (a salesperson sees only their own opportunities) |
| Field visibility | `field_permissions` enforced in SELECT views, applied uniformly to UI, exports and agent |
| Step-up | `sensitive_processes(company_id, process_id, mode: self_2fa | supervisor_authorization)` |
| Audit | Append-only log, origin tagged, causal chain ids, 10-year retention |
| Agent | Acts strictly as the calling user; receives only tools the user is permitted; write-kind tool calls require explicit user confirmation in the chat before execution (card with the diff); step-up processes require the 2FA code in the chat flow |
| Secrets | Supabase service role only in Workflows and route handlers, never in the browser; DIAN certificates in Supabase Vault |

## 7. AI layer

### 7.1 Chat agent (`packages/agent`)
A `WorkflowAgent` (AI SDK, durable) running in a Workflow per conversation turn, streaming UI message chunks to the client. System prompt is assembled from: tenant/company facts, the user's role and permissions summary, locale, current screen context (route, selected record), and the relevant knowledge-base chunks.

Tool families:
- **Processes**: generated from the registry, filtered by permission. Write-kind tools return a "proposal" the UI renders as a confirmation card; execution happens only after the user confirms (hook resume).
- **Query**: `data.query` takes an entity, filters, sort, group/aggregate on registered fields (not free SQL). A separate `data.sql_readonly` tool exists only for the `analyst` role, running against a read-only role with statement timeout and RLS.
- **Builders**: `forms.create` (custom entity + fields + form layout, stored in `custom_entities`, immediately gets grid, RLS, audit and agent tools), `reports.create` (report definition: source entity or query, columns, filters, grouping, chart; stored in `report_definitions`).
- **Documents**: `docs.generate` (template id + record → PDF/DOCX in Storage).
- **Simulations**: `sim.run` (see §12).
- **Messaging**: `messages.send` (email/WhatsApp/in-app), always a write tool requiring confirmation.
- **Scheduling**: `scheduler.task.create/update/delete/list`.
- **Help**: `help.search` over the knowledge base (user guide chunks + the process registry descriptions), returns step-by-step instructions and deep links.
- **Support**: `support.ticket.create` (bug or question, with auto-captured context: route, last audit entries, console errors); `support.ticket.status`.
- **Navigation**: `ui.navigate`, `ui.open_record` so the agent can take the user to the screen.

Conversation memory: `agent_conversations`, `agent_messages`; per-user long-term preferences in `agent_memory` (what reports they like, default filters). Everything the agent executes shows up in audit with the conversation id.

### 7.2 Background agents
`agent_profiles` define role-aware agents (Sales Manager Coach, Treasury Watch, Inventory Risk, Collections, Payroll Compliance...). Each has: trigger (cron or event), audience (role), data scope (consult processes it may call as a system user bounded by the audience role's permissions), prompt, output schema.

A run produces `recommendations(company_id, audience_role, user_id?, title, body, evidence, suggested_actions[], confidence, status)`. Suggested actions are process invocations the user can accept with one click (which then goes through the normal pipeline, including confirmation and step-up). Recommendations live in an inbox and surface as cards on the dashboard and in chat. Feedback (accepted / dismissed / useful) is stored and fed back into the prompt.

Example: the Sales Manager Coach runs daily at 06:00, compares month-to-date sales against goal and run-rate, looks at open opportunities by stage and age, stale quotes, and top customers with declining volume, and proposes concrete actions (follow-ups, promotions on slow stock, targets per rep).

### 7.3 Onboarding agent
A dedicated agent profile that takes a new company from sign-up to production. It is conversational (same chat panel) and stateful: `onboarding_plans(company_id, steps[], status)` tracks a checklist the agent and the user both see.

Steps, in order, each backed by processes and skippable by the admin:
1. **Company setup**: legal data, NIT, fiscal responsibilities, regime, municipalities for ICA, currency, fiscal year, logo. Validates against the country pack.
2. **Modules and plan**: reads entitlements, explains what each enabled module does in the user's own terms, proposes a rollout order (billing first, then inventory, then accounting history).
3. **Users and roles**: proposes roles from a job-title list (gerente, contador, vendedor, cajero, bodeguero), creates invitations, suggests which processes should be step-up protected.
4. **Fiscal configuration**: DIAN resolution numbers and ranges, e-invoicing credentials or technology provider, certificate upload to Vault, test submission in the DIAN habilitación environment, withholding agent status, tax defaults per product category.
5. **Master data import**: customers, suppliers, products, price lists, warehouses, employees, through the import framework (§5.11). The agent proposes column mappings, flags duplicates and invalid NITs, and runs the dry run before commit.
6. **Opening balances**: trial balance, open invoices and bills, stock with cost, assets, bank balances. Reconciles that the opening journal balances and that receivables match the trial balance by third party.
7. **Operational configuration**: document templates, email sender, payment methods, POS registers, bank accounts, payroll concepts and calendar.
8. **Go-live rehearsal**: runs a sample cycle in a sandbox company (quote → order → invoice → payment → reconciliation) with the user watching, then a readiness checklist (e-invoicing habilitado, sequences valid, posting rules complete, 2FA on sensitive processes, backups of imports).
9. **Hand-off**: schedules the first recurring reports, enables the role-based background agents, writes a company-specific help summary into the knowledge base, and offers training sessions per role (guided tours driven by `ui.navigate`).

The onboarding agent uses the same registry tools plus `onboarding.*` processes (plan.create, step.complete, sandbox.create, readiness.check). Progress is visible in a setup page and in the chat. It can be re-invoked later for a new module ("activa nómina") and runs the subset of steps that module needs.

### 7.4 Model strategy: several providers, switchable on demand
Everything goes through the Vercel AI SDK, whose provider abstraction is the only place model ids appear. Vercel AI Gateway fronts the providers with one key and per-model routing, so Anthropic, OpenAI, Google and open models (via Groq, Fireworks, Together) are addressable without code changes.

- `model_policies(tenant_id?, task, primary, fallbacks[], max_cost, data_residency)` where task ∈ {chat, planning, classification, extraction, embeddings, recommendations, summarization}. Defaults: chat and planning on Claude Opus 5.5, classification and background scans on Claude Haiku 5.5, embeddings on a cheap embedding model. Admins at the platform level can change the mapping; a tenant can choose among allowed options (for example an on-prem customer forcing a self-hosted model).
- Switching at run time: the chat UI exposes a model selector when the tenant policy allows; the agent runner reads the policy per call, so a tenant can be moved to another provider without redeploy. Fallback on provider error or rate limit goes to the next model in the list.
- Evaluation suite (§7.5) runs per model so switching is a measured decision. Tool calling and structured output quality vary across providers, so the registry-generated tools use plain JSON schemas without provider-specific features.
- Cost and token logging per call records provider and model, which feeds billing limits (`limit:ai_tokens_month`).

### 7.5 Guardrails
- No tool exists outside the registry. No free-form code execution.
- Output of consult tools is capped (row limits, column masks applied).
- Every LLM call is logged with cost per company for billing and quotas.
- Evaluation set: a growing suite of Spanish prompts → expected tool calls, run in CI against the registry.

## 8. Modules

Each module lists main entities, key processes and events. Names are illustrative; the builder finalizes them in the registry.

| Module | Entities | Key processes | Emits | Consumes |
|---|---|---|---|---|
| core | parties (customers, suppliers, employees as one party model), contacts, addresses, products, UoM, price lists, taxes, currencies, sequences, custom entities | party.create/update, product.create/update, pricelist.* | party.*, product.* | — |
| crm | leads, opportunities, pipelines, activities, quotes | lead.convert, opportunity.stage.move, quote.create, quote.accept | crm.quote.accepted | sales.order.confirmed, invoicing.invoice.paid |
| sales | orders, order lines, deliveries, returns, commissions | order.create, order.confirm, delivery.ship, return.create | sales.order.confirmed, sales.delivery.shipped, sales.return.received | inventory.stock.low (for backorders) |
| invoicing | invoices, credit/debit notes, e-invoice submissions | invoice.issue, invoice.void (step-up), note.issue | invoicing.invoice.issued, invoicing.note.issued, invoicing.invoice.paid | sales.order.confirmed, sales.delivery.shipped, payments.received |
| purchases | purchase requests, purchase orders, receipts, supplier invoices, support documents | po.create, po.approve, receipt.post, supplier_invoice.register | purchases.receipt.posted, purchases.invoice.registered | inventory.stock.low (reorder suggestions) |
| inventory | items by warehouse/location/lot/serial, movements, adjustments, transfers, counts | movement.post, adjustment.post (step-up), transfer.*, count.* | inventory.movement.posted, inventory.stock.low | sales.delivery.shipped, sales.return.received, purchases.receipt.posted, pos.sale.closed |
| warehouse | locations, bins, picking lists, packing, put-away rules | pick.create, pick.confirm, putaway.* | warehouse.pick.confirmed | sales.order.confirmed, purchases.receipt.posted |
| costing | cost layers (weighted average default, FIFO optional), landed costs, cost of goods | cost.recompute, landed_cost.allocate | costing.cogs.posted | inventory.movement.posted, purchases.invoice.registered |
| accounting | chart of accounts, journals, journal entries, periods, cost centers, fiscal reports | entry.post, period.close (step-up), entry.reverse | accounting.entry.posted, accounting.period.closed | every event with a posting rule |
| payments | receipts (customer), disbursements (supplier), payment methods, allocations, cash boxes | payment.receive, payment.pay, allocation.apply | payments.received, payments.paid | invoicing.invoice.issued, purchases.invoice.registered |
| bank | bank accounts, statements (import OFX/CSV/Excel), reconciliation sessions, matching rules | statement.import, reconcile.match, reconcile.auto (agent-assisted suggestions) | bank.reconciled | payments.* |
| finance | budgets, cash-flow forecasts, KPIs, treasury positions, loans | budget.create, forecast.run | finance.forecast.ready | accounting.entry.posted, payments.*, invoicing.* |
| payroll | employees (party), contracts, concepts, payroll runs, payslips, social security, electronic payroll | payroll.run (step-up), payroll.approve, payslip.issue, pila.generate | payroll.run.approved | timekeeping.period.closed |
| timekeeping | shifts, clock events, absences, overtime, approvals | clock.in/out, absence.request, absence.approve, period.close | timekeeping.period.closed | — |
| assets | fixed assets, categories, depreciation schedules, disposals, maintenance | asset.capitalize, depreciation.run, asset.dispose (step-up) | assets.depreciation.posted | purchases.invoice.registered (capitalize from invoice) |
| pos | registers, sessions, tickets, cash movements, offline queue | session.open/close, ticket.pay, ticket.void (step-up), discount.apply (step-up) | pos.sale.closed, pos.session.closed | — |
| support | tickets, bug reports, knowledge base | ticket.create, ticket.reply | support.ticket.created | — |

### 8.1 The sale flow, end to end
1. Agent or user runs `sales.order.confirm`.
2. Transaction: order status → confirmed; outbox gets `sales.order.confirmed`.
3. Consumers:
   - invoicing → `invoice.issue`: taxes via country pack, sequence via DIAN resolution, e-invoice Workflow (UBL, sign, submit, poll, store CUFE + PDF) → `invoicing.invoice.issued`.
   - warehouse → pick list; inventory → `movement.post` (out) → `inventory.movement.posted`.
   - costing → COGS at current average → `costing.cogs.posted`.
   - accounting posting rules → receivable / revenue / IVA on `invoice.issued`; COGS / inventory on `cogs.posted`.
   - crm → opportunity marked won, activity logged.
   - finance → forecast cache invalidated.
4. Every step is in audit with the same causal chain id; the agent can answer "what happened when order 1234 was confirmed" from it.

## 9. Grids, reports, exports

Declared grid parameters (§22.20, OD-2): an entity may declare `gridParams`; their values travel in `GridState.params` and reach its view as transaction-local settings `erp.param.<name>`.


- One `DataGrid` component bound to an entity (or report) id. Columns, filter operators and sort come from the registry. State is server-driven: the client sends `{filters, sort, page}`; a query builder turns it into SQL over the masked view, so every column is filterable and sortable and RLS always applies. Column chooser, saved views per user, grouping and aggregates for numeric columns.
- Export: `exports.run(entity|report, state, format)` is a consult process. Under 10k rows it streams synchronously; above that it starts a Workflow, writes to Storage and notifies when ready. PDF uses the same column model with page breaks and totals; Excel keeps types (dates, numbers) and freezes the header.
- Reports: `report_definitions` (built-in from modules + user-created). A report is a query over registered entities or a module-provided SQL view with parameters, plus layout (table, pivot, chart). The agent's `reports.create` writes the same structure the report builder UI edits. All reports render through `DataGrid` and therefore inherit sort, filter and export.

- Pagination in every grid (10 / 25 / 50 / 100 rows, server-side); exports always cover all pages of the current filter. Export buttons carry their format icon.
- **Import** on every entity grid: download an Excel or CSV template generated from the registry, drop the file, preview with per-row validation by the same `validateParty` / `validateProduct` / `validateCustomFields` rules, import only valid rows, return `errores.csv` with reasons; runs as `kernel.import.run` (Workflow for large files, audited with the original file attached). Rows with missing data are created with their `dian_status` and are not invoice-ready.
- **Advanced filter builder** (shared by grids and lookups), opened from a **magnifier icon at the right of every entity text box** and from the grid's "Filtro avanzado" button as a popup above the current form: a list of conditions `field · rule · value` joined with **Y / O** (AND binds tighter than OR; the popup lists the matching records live under the conditions; clicking a row selects it into the originating text box, or opens the record when launched from a grid; non-invoiceable rows are dimmed in `forInvoice` lookups), over **every field of the entity** (grid columns, stored fields not shown, admin-defined extra data) with rules by type: text (contiene, no contiene, empieza con, termina con, igual, distinto, vacío, no vacío), number/money (=, ≠, >, >=, <, <=, entre, vacío), list/enum (igual, distinto), date (el día, antes, después, entre), boolean. Masked fields are listed but cannot filter. Active conditions show as removable chips and are part of the grid state sent to the server and of saved views.
- **Lookup control** (`EntityLookup`): autocomplete over the entity's searchable fields (name, tax id, commercial name, e-mail, code) with the magnifier icon opening the same advanced filter popup (no need to leave the form). With `forInvoice`, records that are not invoice-ready are shown disabled with their reasons.
- Tabs row: "Cerrar todas" closes every tab except Inicio after a confirmation that lists the tabs to close.

## 10. Forms and custom entities
`forms.create` and the form builder UI produce `custom_entities` + `custom_fields` (stored as a real table created by a migration Workflow, not JSONB, so RLS, indexes and grids work normally) and `form_layouts`. Custom entities register themselves in the metadata registry, get default processes (`custom.<entity>.create/update/delete/consult`) and therefore permissions, audit and agent tools automatically.

## 11. Document generation
`doc_templates(company_id, type, engine: react-pdf | docx, locale, body)` with seed templates per country pack (invoice, credit note, quote, delivery note, payslip, purchase order, asset card, certificate of withholding). `docs.generate` renders with the record and stores the file in Storage with a signed URL. The agent can draft new templates from a description, saved as a template draft for admin approval.

## 12. Simulations
`sim.run(kind, params)` with kinds: cash-flow projection (receivables/payables aging, scheduled payroll, recurring expenses), pricing / margin what-if, sales goal scenarios, inventory reorder, payroll cost change, loan amortization. Each simulation is a pure function over consult data producing a table + chart, saved in `simulations` so it can be re-run and compared. The agent picks parameters from the conversation and shows the result inline.

## 13. Messaging and notifications
`messages.send(channel, to, subject, body | document)` via Resend, WhatsApp adapter or in-app. Templates in Spanish with placeholders. Outgoing messages are audited and stored in `messages_outbox` with delivery status. Notifications (`notifications` table + Realtime) carry recommendations, scheduled report deliveries, approvals and support replies.

## 14. Point of sale
Separate app (`apps/pos`), installable PWA, tablet-first. Works offline: catalogue, price lists and tax rules cached locally; tickets queued in IndexedDB and synced through `pos.ticket.sync` which replays them as processes (so inventory, invoicing and accounting happen on sync). Discounts and voids are step-up processes with supervisor authorization by TOTP or supervisor PIN on the same screen. POS electronic invoicing in Colombia uses the POS e-invoice variant or equivalent document per DIAN rules, through the same country pack.

## 15. Data model conventions
- UUID v7 primary keys, `company_id` on every business table, `created_at/updated_at/created_by/updated_by`, soft delete only where legally required (most documents are voided, never deleted).
- Money as `numeric(18,4)`, currency code per document, exchange rate snapshot per document.
- All amounts in documents stored both in document currency and company currency.
- Timestamps `timestamptz`; tenant timezone for scheduling and reporting.
- Schemas: one Postgres schema per module (`sales.orders`), `kernel` schema for registry, audit, outbox, permissions. Cross-module reads only through views published by the owning module.

## 16. Repository layout

```
apps/web            Next.js app (ERP + CRM + agent chat)
apps/pos            PWA point of sale
packages/kernel     registry, process runner, events, posting engine, audit, scheduler, RLS generators
packages/agent      WorkflowAgent, tool generation, background agent runner, knowledge index
packages/ui         DataGrid, forms, exports, design tokens
packages/modules/*  one package per module (manifest + migrations + handlers + UI)
packages/localization/co   Colombia pack (first); /mx, /pe later
packages/i18n       es-419 (default), en
supabase/           config, generated migrations, seed, policies
```

## 17. Phasing (suggested)
1. **Foundation**: kernel (registry, processes, permissions, RLS generator, audit, outbox, entitlements; the posting engine lands with accounting in phase 2 since it needs journal tables to be testable), core module, DataGrid + exports, auth with MFA, support module (tickets, knowledge base), agent chat with consult + navigate + help + support tools.
2. **Order to cash**: CRM, sales, invoicing with Colombian e-invoicing, inventory, warehouse, costing, payments, accounting. The sale flow in §8.1 works end to end.
3. **Procure to pay + money**: purchases, bank reconciliation, finance, fixed assets. Scheduler and messaging. Background agents (Sales Coach, Collections, Treasury). **Adaptive UI agent** (per-user usage evidence → suggested views with try/accept, promotion to roles, productivity report): design in `2026-10-28-adaptive-ui-agent-design.md`.
4. **People**: timekeeping, payroll with electronic payroll and PILA.
5. **POS** (offline PWA) and custom forms/reports builders through the agent, simulations.
6. **Second country pack** to prove the localization boundary.

## 18. Decisions I made (check these)
- One `Process` abstraction as the only write path, with agent tools generated from it.
- Events + posting rules for integration, never direct cross-module writes.
- Custom entities as real tables, not JSONB.
- Weighted average costing by default; FIFO optional.
- Scheduling stored in the database with a one-minute cron tick starting Workflows.
- Agent write actions always require in-chat confirmation; admins can whitelist specific low-risk processes for auto-execution.
- Background agents run as a system identity bounded by the audience role's permissions, never above it.
- Spanish (es-419) UI default with English second locale; COP default currency.
- Party model: customers, suppliers and employees share one `parties` table with role flags.

## 18a. Code to reuse from the Serena project
`/Volumes/SATECHI2TB/Serena/serena-app` (Next.js 16, Supabase, next-intl, shadcn) already has production code to port behind this design's interfaces instead of rewriting:
- Bold payments: `src/lib/payments/bold.ts`, `bold-api.ts`, `bold-settle.ts`, `src/lib/bold-api-client.ts`, `src/app/api/payments/bold-api/`, `src/types/bold-checkout.d.ts` (plan 3, billing adapter).
- DIAN e-invoicing: `src/lib/dian/` (xml-builder, signer, ws-security, cufe, soap-client, certificate-manager, nit, amounts, with tests) and its spec `docs/superpowers/specs/2026-04-05-dian-invoicing-design.md` (plan 2, Colombia pack; NIT validation already in plan 1).
- Siigo integration `src/lib/siigo/` (plan 2b connectors), exports `src/lib/export.ts`, audit `src/lib/audit.ts` (reference only).

## 19. Left to the builder
- Exact Zod schemas and table DDL per module.
- Choice of DIAN technology provider versus direct submission (both behind the same interface).
- WhatsApp provider.
- Pivot/chart library for reports (Recharts or ECharts are both fine).
- Rate limits and LLM cost quotas per plan.

## 19a. UI direction (approved 2026-10-27)

Chosen: direction C (data workshop) as the application shell, with direction A's dashboard as the home screen, in a blue palette. Reference render: `2026-10-26-erp-ia-ui-CA-home-blue.png`, source `2026-10-26-erp-ia-ui-CA-home.html`, alternatives on the design canvas "ERP-IA UI Proposals".

**Shell**
- Top bar (48px, navy) with: product mark, company switcher, Módulos menu, open-screen tabs (each grid, record or report opens in a tab; tabs persist per user), ⌘K command bar (navigate, create, ask), notifications, Asistente toggle, user menu.
- Revised 2026-10-27 (v5.4): the **Módulos** menu lists only modules; the active module's name is the menu button and its menu items sit in the top bar right next to it. The **open-tabs row** sits under the top bar on a tinted band (`--tabrow` #D6E0F5 light / #1C2743 dark) so tabs are easy to locate; the active tab takes the page background. Grid pages carry no page title (the grid header already names the entity). Export buttons: PDF icon red, Excel icon green, CSV grey. No permanent left sidebar.
- Theme: light / dark / automatic (follows `prefers-color-scheme`), toggle in the top bar and user menu, saved per user; all colours come from tokens so both themes derive from the same table.
- Assistant: right drawer, 400px, collapsible, always aware of the active tab and selection. Write actions appear as confirmation cards (effects listed: documents, inventory, accounting, permission, 2FA requirement). Step-up shows supervisor selector and TOTP field inline.
- Grids: TanStack Table with a filter row under the header (text contains, select, numeric range, date), sortable headers, column chooser, grouping, row selection with selection totals in the footer, PDF / Excel / CSV buttons, saved views per user. Active filters are tinted light blue.
- Home: greeting with working-day count, widgets on a 4-column dashboard grid (KPIs, quick search, recommendations, embedded grids). Every widget can be **dragged by its header to relocate** and **resized from its corner** (1–4 columns, free height); the layout is saved per user in `kernel.user_prefs.home_layout` with a "Restablecer tarjetas" action. Phase 2 adds widgets from other modules and saved reports.
- Mobile: conversation-first (direction B's phone screen): recommendations and chat with the same confirmation and 2FA cards.
- POS: separate tablet layout (catalogue grid, ticket, payment buttons, offline indicator), same palette.

**Design tokens (seed for `packages/ui`)**
| Token | Value |
|---|---|
| font.body | Source Sans 3 |
| font.mono | JetBrains Mono (ids, codes, timestamps) |
| color.bar | #1E3A8A, controls #2A4A9E, borders #4A6AC2, text #DBE4F5 |
| color.primary | #1D4ED8 (buttons, user bubbles, links), hover #1E40AF |
| color.accent.soft | #DBEAFE (active filters, action card headers), border #BFDBFE |
| color.bg | #EEF0F2 page, #FFFFFF surfaces, #F7F8FA table headers and footers |
| color.text | #1A1D21, muted #3F4752 |
| color.line | #D7DBE0, light #E2E5E9 |
| semantic | ok #DDF1EB / #0A5446, warn #FBEBD2 / #7A3E05, danger #FBE3E0 / #8C1D17, info #E3ECF8 / #1D4F91, alert dot #E9A23B |
| radius | 6px controls, 8px cards, 4px pills |
| density | 36px grid rows, 13–14px grid text, 44px minimum touch targets on POS and mobile |

Dark theme: derive from the same tokens; the top bar stays navy.

## 20. Cost estimate for the chosen stack

Figures gathered 2026-10-26 from vendor pages and secondary sources; Supabase and Vercel both bill by usage on top of a base, so treat these as planning ranges and confirm on the live pricing pages before committing. Sources: [Supabase pricing guide](https://makerkit.dev/blog/saas/supabase-pricing), [Supabase pricing (2026)](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/), [Vercel cost guide](https://makerkit.dev/blog/saas/vercel-cost), [Vercel Fluid compute pricing](https://blog.vercel.com/docs/fluid-compute/pricing), [Vercel Workflow pricing](https://vercel.com/docs/workflows/pricing), Claude API price list bundled with the Claude API skill (cached 2026-10-06).

### 20.1 Unit prices used
| Item | Price |
|---|---|
| Supabase Pro | USD 25 / month per organization, includes USD 10 compute credit (Micro instance), 8 GB DB, 100 GB storage, 250 GB egress |
| Supabase compute upgrades | Small ~USD 15, Medium ~USD 60, Large ~USD 110 per month (always on); PITR 7 days USD 100 / month |
| Supabase Team (SOC 2, SSO) | USD 599 / month |
| Vercel Pro | USD 20 / month per seat, includes monthly usage credit; Active CPU ~USD 0.128 per CPU-hour, provisioned memory ~USD 0.0106 per GB-hour; Hobby is not usable for this (no commercial use, hard caps) |
| Vercel Workflow | ~50k events/steps included; on the order of USD 0.02 per 1k events plus USD 0.50 per GB written. Vendor docs disagree on the unit; verify |
| Claude Opus 5.5 | USD 4 / M input tokens, USD 20 / M output tokens, cache reads USD 0.20 / M |
| Claude Haiku 5.5 | USD 0.10 / M input, USD 0.50 / M output |
| Claude Sonnet 5.5 | USD 2 / M input, USD 10 / M output |
| Vercel AI Gateway | pass-through model price, no markup on bring-your-own-key |
| Resend | free up to 3k emails / month, ~USD 20 / month for 50k |
| DIAN technology provider | COP 0 to ~COP 300 per document depending on volume if a provider is used; direct DIAN submission is free but needs the certificate (~COP 300k–600k / year) |

### 20.2 AI usage model
Assumptions per active user per working day: 8 chat turns on Opus 5.5 at ~6k input tokens (system prompt and tool list mostly cache hits) and ~600 output tokens; 3 background-agent runs per company per day on Haiku 5.5 at ~30k input tokens each; onboarding is a one-off ~2M tokens per company.

| Per unit | Cost |
|---|---|
| One Opus 5.5 chat turn (cached prompt) | ≈ USD 0.017 |
| One active user per month (22 days × 8 turns) | ≈ USD 3.0 |
| Background agents per company per month | ≈ USD 0.30 |
| Onboarding per company (one-off) | ≈ USD 10–20 |

Switching chat to Sonnet 5.5 halves that; switching to Haiku 5.5 makes it negligible but tool-call quality on complex processes drops.

### 20.3 Monthly totals by stage
| Stage | Companies / users | Supabase | Vercel | AI | Other | Total USD / month |
|---|---|---|---|---|---|---|
| Development and pilot | 1–3 companies, 10 users | 25 (Pro, Micro) | 40 (2 seats) | 30 | 0 | **~95** |
| Launch | 20 companies, 150 users | 25 + 60 (Medium) + 100 (PITR) = 185 | 60 seats-ish (3) + ~100 usage + ~20 workflow = 180 | 150 × 3 + 20 × 0.3 ≈ 460 | 20 email | **~850** |
| Growth | 100 companies, 800 users | 25 + 110 (Large) + 100 (PITR) + storage/egress ~60 = 295 | 100 (5 seats) + ~500 usage + ~100 workflow = 700 | 800 × 3 + 30 ≈ 2,430 | 50 | **~3,500** |
| Scale with compliance | 300 companies, 2,500 users | 599 (Team) + 2× Large replicas ~400 + PITR + usage ~300 = 1,300 | 200 + ~1,500 usage + ~300 workflow = 2,000 | 2,500 × 3 + 90 ≈ 7,600 | 150 | **~11,000** |

Reading: infrastructure stays under USD 1 per user per month at every stage; AI is the dominant cost at roughly USD 3 per active user per month on Opus 5.5 and is what pricing should be built around (include a token allowance per seat, meter above it). Fixed-cost floor for a serious pilot is about USD 100 per month.

Not included: DIAN certificate, technology provider per-document fees, WhatsApp Business conversation fees, domain and monitoring (Sentry), developer time.

## 21. Deployment portability and on-premise

Yes, the stack can run on customer servers in Docker, with these substitutions. The design keeps every vendor-specific piece behind an interface so one codebase serves both targets.

| Cloud piece | On-prem equivalent | Notes |
|---|---|---|
| Supabase cloud | Self-hosted Supabase (official Docker Compose: Postgres, Auth/GoTrue, PostgREST, Storage, Realtime, Studio) | Same APIs and RLS; MFA works; backups and upgrades become the customer's job |
| Vercel hosting of Next.js | Next.js `output: "standalone"` in a Node 22 container behind Nginx or Traefik | Server Actions and streaming unaffected |
| Vercel Workflow (Vercel World) | Workflow DevKit **Postgres World** (`@workflow/world-postgres`, env `WORKFLOW_TARGET_WORLD`, `WORKFLOW_POSTGRES_URL`, migration script) running in a long-lived Node container; `@workflow/web` dashboard self-hosted on a private network | Same `"use workflow"` code; the Postgres World is for your own servers and is not used on Vercel. Sources: [Workflow Postgres World](https://useworkflow.dev/worlds/postgres), [Vercel self-hosting](https://vercel.com/docs/agent-harnesses/self-hosting) |
| Vercel Cron | `pg_cron` in Postgres or a cron container calling the tick route | Scheduler table is unchanged |
| Vercel AI Gateway | Direct provider SDKs through the AI SDK, or a self-hosted gateway (LiteLLM) in front of Anthropic/OpenAI/local models (Ollama, vLLM) | Model policy table decides; fully offline inference is possible with open models at lower quality |
| Supabase Storage | Same (self-hosted Storage over local disk or MinIO S3) | |
| Resend | Customer SMTP relay | Messaging adapter interface |
| Vercel Blob/Edge Config | Not used by design | |

Design rules that make this cheap to keep true:
- No Vercel-only runtime APIs in business code (no Edge runtime, no `@vercel/*` storage packages). Workflow and AI SDK are the two Vercel-authored libraries in use and both have a non-Vercel backend.
- One `infra` package with interfaces: `DurableRunner`, `Scheduler`, `ModelProvider`, `FileStore`, `Mailer`. Two implementations each (cloud, docker), chosen by environment variables.
- A `docker-compose.yml` in the repo from phase 1 (Supabase stack, web, workflow worker, workflow dashboard) used in CI for integration tests, so the on-prem path is exercised on every merge instead of discovered at the first on-prem sale.
- Licensing and entitlements for on-prem: the entitlement resolver accepts a signed licence file instead of the billing sync; the platform-level background agents and model policy fall back to the customer's own keys.

What changes for the customer on-prem: they run Postgres backups, PITR, TLS, upgrades and the DIAN certificate store themselves, and the AI quality depends on which provider they can reach from their network.

## 22. Owner decisions (2026-10-27)
1. **Multi-company per tenant**: modelled from day one (tenant → companies, `company_id` everywhere). UI ships single-company in phases 1–2; company switcher and consolidated reports in phase 3.
2. **POS hardware**: barcode scanners from v1 (keyboard devices). ESC/POS receipt printing and cash-drawer kick through WebUSB or a small local print agent in phase 5. No fiscal printer; the DIAN electronic POS document is the legal path. POS is Chromium-only.
3. **AI pricing**: token allowance per seat included in each module plan, metered above it, with a per-company monthly cap the admin can raise. Background agents count against the company allowance. Usage dashboard and alerts are a launch requirement. Cheap tasks route to Haiku automatically.
4. **English UI**: i18n plumbing from day one (all strings through `packages/i18n`, locale per user). Spanish only at launch; English in phase 3.
5. **Billing provider**: **Bold** (Colombian payment gateway). The Serena project already has a Bold integration; reuse its adapter and webhook handling behind the billing adapter interface. Manual invoicing (through the platform's own invoicing module) for enterprise and on-prem contracts. Stripe can be added later behind the same adapter.
6. **On-prem**: later option, not a launch requirement. `docker-compose.yml` and the Workflow Postgres World run in CI from phase 1 so the path stays working; first on-prem delivery in phase 6.
7. **Party fiscal data**: `core.parties` captures the full DIAN identity (person type, 12 document types, computed DV, split names, tax responsibilities, tributo, DANE location, invoice e-mail) with format validation from day one; see §5.8a. Money renders as `$ 1.234.567,00`.
8. **Product fiscal data and attachments**: `core.products` carries the invoice-line data of §5.8b from day one; any entity accepts attachments (§5.13).
9. **Prototype v5 changes (2026-10-27)**: module bar + tabs row shell with dark mode (§19a); record frame with open-in-new-tab, tabs, inline phone/e-mail validation and verification hooks (§5.16); tagged attachments with drag-and-drop, delete confirmation and admin-defined required files (§5.13); admin-defined extra data (§5.14); UUID + consecutive on every record (§5.15); invoice readiness blocking incomplete records (§5.17); party contacts, dual e-mails for customer-and-supplier parties, product categories master with inherited taxes, product photos with AI suggestion, role party scope (§5.18); pagination, import and lookup control on grids (§9); admin creates roles and users (§6).
10. **Adaptive UI agent (2026-10-28)**: approved as a phase 3 feature entirely; see `2026-10-28-adaptive-ui-agent-design.md`. Key owner rules: proposals only on sufficient and significant evidence, try before accept, activation only on accept, no page showing the user what was learned, proposals may change what data is shown (inside permissions), admin can promote to a role, users can ask on demand, productivity report per process and global.

11. **UI density audit and follow-ups (2026-10-29)**, from `docs/superpowers/reports/2026-10-28-ui-density-audit.md` and prototype v6 (`2026-10-28-erp-ia-prototype-v6-density.html`):
    - Accepted: OD-1 tighter `main` padding on grid and admin routes (`gap 12px · 16px 16px 12px`); OD-2 dark `--primary` #2563EB for fills and a `--link` token (#60A5FA dark) for text links; OD-3 `--line-input` (#8A94A3 light, #6B7686 dark) for input boundaries; OD-4 sticky selection and identity column in every grid; OD-5 money totals as a sticky `tfoot` row under their columns (selection totals stay in the footer); OD-6 the tabs row scrolls sideways with the active tab kept in view and "+" pinned; OD-7 admin matrices stage changes and apply them in one batch with one step-up (`kernel.admin.permission.set_many`, `kernel.admin.field_permission.set_many`); OD-9 optional `series` and `asOf` on the kernel `Kpi` contract; OD-10 the assistant drawer starts closed below 1280 px; OD-11 Enter moves to the next field in record forms and Ctrl/⌘+S saves; OD-12 DIAN schema hints move from labels to a "ver códigos DIAN" toggle.
    - Rejected: OD-8 (abandoning the shared `erp-*` stylesheet for Tailwind utilities only).
12. **Movable grid columns (2026-10-29)**: every grid lets the user reorder columns by dragging the header (and with the keyboard); the order is part of the view and is saved with it (rule 20).
13. **Cloning (2026-10-29)**: every entity with a create process can be cloned from its record ("Duplicar"). The clone is created through the entity's own create process from the source's visible data with the entity's unique and identity fields cleared (document number, DV, SKU, consecutive, files); the audit entry of the creation records the source record (`source_row_id`) so the origin is always traceable (rule 37).
14. **Audit before/after and friendly names (2026-10-29)**: the audit viewer shows, per changed field, the previous and the new value (from the row-level diff the audit trigger already records), with the field's label, the process's description and the entity's name from the catalogue instead of raw ids; values follow the viewer's field visibility (rule 16).
15. **Every entity reference is a link (2026-10-29)**: wherever the UI shows a record of another entity (the actor of an audit row, a product's supplier, a ticket's reporter, the rows of an assistant result) it links to that record's page (rule 21). Users have a page under Administración › Usuarios.
16. **Editable users (2026-10-29)**: the admin edits a user's name, mobile, photo, locale, roles and active state through `kernel.admin.user.update` (step-up); deactivating removes access without deleting history (§6).
17. **Accounting module (2026-10-29)**: see `2026-10-28-accounting-module-design.md`. `core.product_categories.income_account` (§5.18) is deprecated: the revenue account of a category is an accounting role mapping (`revenue`, dimension `category:<id>`) edited from Contabilidad → Mapeo de cuentas and from a Contabilidad tab on the category record contributed by the accounting manifest; the core column is read once by the chart seed and dropped later. Entries keep their document's own date; a document dated in a closed period waits until a privileged user reopens the period or that day (step-up); entries are never moved to another period. Masters of a module may be grouped in the items bar (`NavItem.children`). Formato 2516 is produced from the single PUC ledger plus a yearly reconciliation layer, not a second ledger. Accounting lines carry four optional analytic dimensions, centro de costo, auxiliar abierto, ítem and unidad de negocio (the last also on the comprobante header, inherited by its lines), each a group / leaf tree with its own master; hierarchical masters offer table and tree views. Información exógena is produced from the ledger through an account → concept mapping, with the catalogue, thresholds and XML writer in the Colombia pack; cartera y cuentas por pagar por edades read open items computed from the ledger until the payments module's allocations exist. Manual entries may require a second person to post them (four-eyes setting), accruals may carry a reversal date that creates the mirrored draft, and a period closes only after the control accounts tie to their subledgers and the suspense role is at zero, each check recorded as a sign-off. Permissions extend to the account level (§6 of this design): an account may be restricted so that only granted roles and users see its balances or post to it; the published views enforce it, reports aggregate what a user may not see into one line, and records mask those lines. The journal master is called **Fuente** in every UI (identifiers stay `journal`). A **Movimientos** page queries ledger lines through a read-only `accounting.ledger_line` entity with multi-filter, multi-sort and grouped aggregates; for it `GridState.groupBy` becomes an ordered array of up to three fields with per-group aggregates in the kernel query builder, available to every grid.
18. **Development environment (2026-10-29)**: development runs on the local Supabase stack (the CLI's Docker stack on OrbStack, 6 GB / 6 CPUs), never on the owner's laptop against the hosted project: over the internet the integration suites take an hour instead of two minutes (one round trip per statement). The hosted Supabase project `gextacnxvjshibrjlblq` and the Vercel project `erpia` (repo `remcaro-rgb/erp-ia`, production branch `main`, deployment behind Vercel's login) are the shared demo and the deployed app; `pnpm hosted …` reaches them from the scripts. Before a commit the implementer runs lint, typecheck, check:rules, the unit suites, the integration files and Playwright specs the task touched (`pnpm test:integration:changed`, `E2E_BASE_URL`), and the web build; the full integration and e2e suites and the compose stack run in GitHub Actions on every push (rule 6, unchanged), and a task is complete only when that run is green. Vercel's Hobby plan runs the outbox cron daily until the account moves to Pro.
19. **Two-step verification opt-out (2026-10-29)**: a user may turn off the second step of their own sign-in (`kernel.user.mfa.disable`, step-up with a fresh code from the factor being removed), unless they hold the system admin role without an exemption; an admin may remove a specific user's factor (they enrol again at the next sign-in if their role requires it) and may exempt a specific user from the admin role's requirement (`kernel.admin.user.mfa.set`, step-up; `kernel.memberships.mfa_exempt`, honoured by the access-token hook). Rule 15 is unchanged: a user without a factor cannot run sensitive processes until they enrol again, and the step-up prompt says so. Plan: `docs/superpowers/plans/2026-10-29-phase-1c-mfa-opt-out.md`.
    - Controller rulings pending the owner's confirmation (2026-10-29), made during the implementation:
      - The self-disable refusal considers every active membership of the user, tenant-wide (`kernel.user_requires_mfa`): the factor is the identity's, so a user who is a plain member in one company and an un-exempt admin in another cannot remove it from either. The access-token hook's `requires_mfa` stays per company (the sign-in enforces it per company).
      - An admin's reset removes the identity's factor even for a user who is also an admin of another company of the same tenant (they enrol again at their next sign-in there), but never for a user who also belongs to another organization: `kernel.admin.user.mfa.set { reset }` answers `invalid_input` "Ese usuario pertenece también a otra organización; su segundo paso no se cambia desde aquí" (`kernel.user_in_other_tenant`, migration 0029). The exemption is per membership and stays allowed for that user.
      - A self-disable ends every session, so the app signs the user out to `/login` with the notice "Segundo paso desactivado. Vuelve a ingresar con tu contraseña." instead of refreshing the session; an admin's reset leaves the admin's session intact and ends the target's. The final fix round (2026-10-29) found that Auth does not do it by itself (GoTrue v2.196.0: removing a verified factor through the admin API only downgrades the user's sessions to `aal1`; their tokens keep working). **Owner decision (2026-10-30): other sessions end; access tokens live 10 minutes.** Both processes end the user's sessions through `AuthAdmin.signOutUser` after removing a factor (refresh tokens and sessions deleted in Auth's store over the service connection, since the admin API signs out by JWT only; a dry run or a removal of nothing ends none); `jwt_expiry` is 600 seconds (local `supabase/config.toml`; the hosted project's dashboard must match); and the proxy signs out a token that still claims `mfa_enrolled` when the user no longer has a verified factor, sending the browser to the sign-in notice (one lookup, only for tokens that claim a factor).
      - A user of another company answers `invalid_input` "El usuario no pertenece a la empresa" (the same code and copy as `kernel.admin.user.update`).
      - `kernel.memberships.mfa_exempt` (field `mfa_exempt` of `kernel.user`) is confidential: visible to the admin by the role defaults, masked for other roles. An exemption stays on the membership until an admin lifts it, across role changes; the user page shows "exenta" while it does.
      - Both processes are excluded from the assistant's tools (`EXCLUDED_PROCESSES` in `packages/agent`): removing a factor is followed by the sign-out and the notice, which only the user menu and the user page handle.
20. **Phase 2A gaps (2026-10-30)**, from `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (the owner took the plan's recommendations):
    - OD-1 · **Devolver a borrador is its own process**: `accounting.entry.return_to_draft` (update, normal, admin may raise; input `id` and an optional reason kept in `extra.return_reason`; granted by default with `accounting.entry.post`) moves a `pending` entry back to `draft` in place, lines untouched, and works on entries with lines on restricted accounts; `accounting.entry.update` no longer accepts a `pending` entry. No event is emitted for now.
    - OD-2 · **Declared grid parameters**: an entity may declare `gridParams` (name and type, at most five); `GridState.params` carries their values, the kernel query sets them as transaction-local settings `erp.param.<name>` before the query, and the entity's masked view may read them. Undeclared parameters are refused. Saved views, exports, the URL and `data.query` carry them with the state. First use: the period figure column of the five accounting masters' Tabla (accounting design §8).
    - OD-3 · **Module namespaces in the catalogues**: registry keys stay in their kind's namespace (`entity`, `field`, `nav`, `feature`, `process`, `report`, …); a module's page copy lives in a namespace named after the module (`accounting.*` first; each 2B module gets its own).
    - OD-4 · **Model-backed evals**: the evaluation set runs against the chat policy's model nightly on `main` and on manual dispatch, only when the gateway secret is configured; a run passes when every core case passes and at least 90 % of all cases do; every push runs the same runner on the mock model at no cost; a red nightly run does not block merges (its report is the artifact). Model calls of the evals are metered like any other.
21. **UI/UX remediation (2026-10-31)**, from `docs/superpowers/plans/2026-10-31-ui-ux-remediation.md` (the owner took the plan's recommendations). The v5 shell of §19a stays; shell v7 (`2026-10-31-shell-v7-sidebar.md`) is not adopted by this decision.
    - UX-OD-1 · **Compact navigation**: from 1024 px up, module items that do not fit the top bar move into a trailing "Más ▾" menu measured at runtime; below 1024 px a "Menú" button opens a sheet listing Módulos and the active module's items (groups expanded). Global actions (⌘K, theme, notifications, Asistente, user menu) and the company switcher are never displaced; a long company name truncates with the full name in its tooltip. Module items are real links (open in a new browser tab with ⌘/Ctrl or middle click). A feature's menu item that is a group child is never listed again at the top level.
    - UX-OD-2 · **Assistant by width**: below 768 px the assistant opens as a full-screen sheet with its own "Cerrar" control, safe-area insets and a height that follows the on-screen keyboard (the conversation-first mobile direction above); from 768 to 1279 px it slides over the page instead of narrowing it; from 1280 px it is the docked 400 px drawer. Opening it moves the focus to the composer, closing it returns the focus to the toggle.
    - UX-OD-3 · **Totals of roll-up columns**: a field may declare `rollup: true` (its value already includes its descendants, as `period_figure` on the hierarchical masters). For such a column the grid footer, the selection totals and every export total the rows that have no ancestor in the result (in an unfiltered tree, the roots), computed by the kernel query over every page, filter and visible row; a generic sum is never shown for it.
    - UX-OD-4 · **Unsaved changes**: a record form with changes warns before it is left: the browser's own prompt on refresh or closing the window, and a "Guardar · Descartar · Cancelar" dialog on closing its tab, changing route or module, switching company and signing out; Cancelar keeps the input. The tab and the form show "Sin guardar". Form values are kept in memory only, never in browser storage.
    - UX-OD-5 · **⌘K create commands**: the palette offers only processes named `<module>.<noun>.create`; other create-kind processes (from a template, reversals, openings, system processes) stay on their own screens.
    - UX-OD-6 · **Assistant result columns**: a result table shows up to six columns of the entity's default grid view (identity and display field first) with the grids' enum, reference and money formatting; "Ver todas las columnas" expands it in place; "Abrir como grid" and export are unchanged.
    - UX-OD-7 · **KPI drill-downs**: the kernel `Kpi` contract gains an optional `href`; each module's KPI links to the grid or report holding its work, with the KPI's filter (e.g. Borradores → comprobantes in `draft`).
