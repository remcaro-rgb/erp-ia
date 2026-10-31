# Accounting module and posting engine (design)

**Status:** approved by the owner on 2026-10-29 ("Approve, write plan") after the additions of §10b.13–19; recorded in the main design §22.17. Owner decisions of 2026-10-28 applied (§10b). Owner opted out of the brainstorming questions; the choices in §10 and §10a were my calls and the owner reviewed all twelve decisions of the presentation on 2026-10-28: nine confirmed, two amended (closed periods, menu), one widened (revenue mapping also editable from the product category record). All twelve are settled. On review the owner added two analytic masters, Auxiliar abierto and Ítem, with table and tree views on every hierarchical master (§4.5, §10b.13), and after a market benchmark pulled two gaps into phase 2: exógena with an account → concept mapping, and cartera y cuentas por pagar por edades (§4.13, §5.11, §10b.14), then a fourth analytic dimension, Unidad de negocio, assignable on the comprobante header and on lines (§4.5, §10b.15), and five controls from a review of global accounting best practice: four-eyes on manual entries, auto-reversing accruals, subledger tie-out and suspense check at period close, and an auditor extract of manual entries (§5.12, §10b.16), and security by account: who may see an account's balances and who may post to it, per role and per user (§4.15, §5.13, §10b.17). The document is ready for the owner's approval, after which the phase 2 plan is written. **Phase:** 2, first item of the roadmap ("Posting engine (journal rules per event) and accounting module: chart of accounts (PUC), journals, periods, cost centers, fiscal reports"). To be planned as the first tasks of the phase 2 plan.

Companion to `2026-10-26-erp-ia-design.md` (main design). Uses its kernel: module manifest (§5.2), entity registry (§5.3), processes (§5.4), outbox and consumers (§5.5), posting engine (§5.6), sequences (§5.7), country packs (§5.8), import framework (§5.11), module table (§8), sale flow (§8.1), grids and reports (§9), data conventions (§15), UI direction (§19a), owner decisions (§22). Bound by every rule in `docs/project-rules.md`.

## 1. Intent

A Colombian company that sells with ERP-IA must get its accounting for free: every invoice, cost of goods, payment and stock adjustment becomes a balanced journal entry in the company's PUC-based chart, by third party and cost center, in the right period, without an accountant typing it. The accountant's job becomes reviewing, adding the manual entries the system cannot derive (provisions, adjustments, reclassifications), closing months, and pulling the fiscal reports the DIAN, the revisor fiscal and the bank ask for. The assistant can answer "¿cuánto vendimos en septiembre por centro de costo?" and "¿qué pasó contablemente con la factura FE-1234?" from the same tables.

Two things are designed here because one cannot be tested without the other (main design §17): the **posting engine**, a kernel service that turns domain events into journal entries through admin-editable rules, and the **accounting module**, the schema, processes, pages and reports those entries live in.

## 2. Goals, non-goals, anti-goals

**Goals**
- Automatic, idempotent posting of every business event that has a rule, with the causal chain of the originating process, so one sale produces one traceable set of entries (§8.1).
- A complete Colombian chart of accounts (PUC, Decreto 2650) seeded by the country pack, extensible by the company below the subcuenta level, with account roles mapped so modules never name an account.
- Manual journal entries (notas de contabilidad) with the same validations as automatic ones: balanced, open period, movement-level account, third party and cost center where the account requires them.
- Monthly periods and fiscal years with step-up close and reopen, and a year-end close that moves the result to equity.
- Four analytic dimensions as hierarchies (group and leaf nodes): centro de costo, auxiliar abierto, ítem and unidad de negocio, each usable on any line (unidad de negocio also on the comprobante header, inherited by its lines) and as a filter or breakdown in every report. Every hierarchical master offers a table view and a tree view.
- Fiscal reports every Colombian accountant expects: balance de prueba, libro diario, libro mayor y balances, auxiliar por cuenta y por tercero, estado de situación financiera, estado de resultados (by cost center), each a grid with filters, drill-down to the entry and export to PDF, Excel and CSV.
- Security by account: an account (and its subtree) can be restricted so that only the roles and users granted may see its balances and movements or post lines to it; everyone else sees one aggregated line and masked lines, never the detail (§5.13).
- The controls a revisor fiscal tests first: segregation of duties on manual entries, accruals that reverse themselves, a period close that ties the control accounts to their subledgers and clears suspense, and an extract of manual entries with who, what and when (§5.12).
- Información exógena (formatos 1001, 1003, 1005, 1006, 1007, 1008, 1009) built from the ledger through an account → concept mapping the accountant edits, with the XML the DIAN prevalidador accepts, and cartera y cuentas por pagar por edades by third party (owner 2026-10-28 after the market benchmark, §10b.14).
- Posting rules the admin can read, test against a real past event, and change under step-up; failed postings visible and retryable, never silently dropped.
- Everything exposed to the assistant as processes: it consults, explains, drafts entries and proposes rule changes; it posts only after a confirmation card.

**Non-goals (phase 2)**
- Bank reconciliation, fixed assets and depreciation, budgets and forecasts (phase 3); payroll postings (phase 4); consolidated multi-company reports (phase 3).
- Exógena and tax return summaries: they are Colombia pack part 2 and read this module's published views; this module only guarantees the data they need (third party, tax base and tax code on every tax line).
- Dual books (NIIF vs fiscal) and the conciliación fiscal (formato 2516). One book per company in v1; see §10.
- Open-item management (partidas abiertas) of receivables and payables: the payments module owns allocations; accounting mirrors them.
- Printing or registering libros oficiales with the Cámara de Comercio beyond the PDF export of libro diario and mayor y balances.

**Anti-goals (a failure even if it works)**
- An event that produced state in another module but no entry, with nobody told. Every posting outcome is recorded; failures have an inbox and a retry.
- An entry posted twice for one event (redelivery, retry, double click). Idempotency is structural, not best effort.
- A module or a report that hard-codes a PUC code. Codes live in the pack and in company data only.
- An unbalanced or closed-period entry that reaches `posted` status by any path, UI, assistant, import or event.

## 3. Constraints

- Rules 1 to 36 of `docs/project-rules.md`; in particular one schema (`accounting`), RLS on every table, cross-module reads only through the views of §6, every state change a process, UUID v7 + gap-free `seq`, money `numeric(18,4)` in document and company currency, Spanish copy through `packages/i18n`, step-up on sensitive processes, append-only audit, forward-only migrations, test first, user guides with the feature.
- Country pack boundary (rule 5): the PUC seed, the default role mapping, account code validation, the fiscal calendar and the layouts of the two financial statements come from `packages/localization/co`; the module calls the pack through the `CountryPack` interface (§5.8), which this design extends (§5.9 below).
- Posting engine lives in `packages/kernel/src/posting` (main design §16) and depends on no module and knows none by name (rule 4): it owns the template DSL, the role catalogue and the composition algorithm, and talks to the ledger through a `PostingProvider` interface a module registers in its manifest (§5.1). The accounting module is that provider; every write goes through its own processes.
- Phase 2 modules (invoicing, costing, inventory, payments, sales) ship their default posting rules in their manifests (`postingRules`, §5.2); this design defines the rule format they must use, and the rules for the events of §8.1.
- UI follows the approved shell and record frame (§19a, prototype v5): grids are the universal DataGrid, records open in the record frame with `Datos · Datos adicionales · Archivos` plus the entity's own tabs, every entity text box has the magnifier.

## 4. Entities (schema `accounting`)

Every table carries the rule 7 columns (`id`, `company_id`, `seq`, `created_*`, `updated_*`, `extra`, `extra_free`) and a masked view `accounting.v_<table>`; they are omitted below. Spanish labels are the i18n keys' default copy.

### 4.1 Account (`accounting.account`, table `accounts`) — Cuenta
The chart of accounts. PUC hierarchy by code prefix; the company owns its chart after the seed.

| Field | Notes |
|---|---|
| `code` | PUC code, digits only, unique per company. Levels by length: 1 clase, 2 grupo, 4 cuenta, 6 subcuenta, 8+ auxiliar. A child's code starts with its parent's. Validated by `pack.accounting.validateAccountCode`. |
| `name` | Nombre |
| `parent_id` | ref account; derived from the code on save, kept for tree queries |
| `level` | enum `class | group | account | subaccount | auxiliary` |
| `nature` | enum `debit | credit` (naturaleza); seeded from the class, editable on auxiliaries |
| `allows_movement` | boolean. Only leaf accounts at level `subaccount` or `auxiliary` may receive lines. Creating a child under an account with movements is refused. |
| `requires_party` | boolean (exige tercero). Seeded true for receivables, payables, taxes, withholdings, advances, employees. |
| `requires_cost_center` | boolean (exige centro de costo). Seeded true for classes 4, 5, 6, 7. |
| `requires_open_auxiliary`, `requires_item`, `requires_business_unit` | boolean (exige auxiliar abierto, exige ítem, exige unidad de negocio). Seeded false everywhere; the accountant turns them on per account. My call, mirrors the cost-center flag so the three dimensions share one validation path. |
| `statement_section` | text code from the pack layout (e.g. `esf.assets.current.cash`); inherited from the parent when empty |
| `is_opening_result` | boolean, marks the retained-earnings style accounts the year close may post to (seeded on 3605, 3705, 3710) |
| `is_active` | boolean; an account with lines cannot be deleted, only deactivated |
| `access` | enum `open | restricted`; `restricted` makes the account and its descendants visible and postable only to the subjects granted in §4.15; a descendant may set its own value (most specific wins) |

### 4.2 Account role mapping (`accounting.account_role_mapping`, table `account_role_mappings`) — Mapeo de cuentas
Resolves the roles posting rules use (`receivable`, `revenue`, `vat_out`…) to accounts of this company. The catalogue includes `rounding` (ajuste al peso) and `suspense` (cuenta transitoria, partidas por aclarar): the pack seeds both, and `period.close` requires `suspense` to be at zero (§5.12).

| Field | Notes |
|---|---|
| `role` | role id from the kernel role catalogue (§5.3 below) |
| `dimension` | text, nullable. A qualifier a rule line can supply: `tax:IVA19`, `tax:INC8`, `category:<uuid>`, `party_kind:supplier`, `payment_method:<code>`. Unique `(role, dimension)`. |
| `account_id` | ref account, must `allows_movement` |

Resolution order for a line: explicit `account` in the rule line → `(role, dimension)` → `(role, null)` → failure `missing_account_mapping`.

### 4.3 Journal (`accounting.journal`, table `journals`) — Fuente (tipo de comprobante; labelled **Fuente / Fuentes** in every UI, owner 2026-10-28)
| Field | Notes |
|---|---|
| `code` | short code, unique per company: `NC`, `VT`, `CP`, `RC`, `CE`, `AP`, `CI` |
| `name` | Notas de contabilidad, Ventas, Compras, Recibos de caja, Comprobantes de egreso, Apertura, Cierre |
| `kind` | enum `general | sales | purchases | receipts | payments | opening | closing` |
| `next_number` | gap-free counter of the journal's consecutivo, advanced by `accounting.next_entry_number(journal_id)` under row lock at post (own counter: journals carry no DIAN resolution, so `core.document_sequences` is not involved and no cross-module write happens) |
| `manual_entries` | boolean: a user may create entries in it by hand (false for Apertura and Cierre) |
| `is_active` | |

### 4.4 Fiscal year and period (`accounting.fiscal_year`, `accounting.period`) — Año fiscal, Período
| Field | Notes |
|---|---|
| fiscal year `year`, `starts_on`, `ends_on`, `status` | `open | closed`; Colombia: calendar year (pack) |
| period `fiscal_year_id`, `number` (1–12), `starts_on`, `ends_on`, `status` | `open | closed`; `closed_at`, `closed_by`, `reopened_count`, `reopened_for` (date, nullable: while set, only entries dated that day may post in the reopened period, §5.7) |

Opening a fiscal year creates its 12 periods. The first fiscal year is created when the module is enabled, from the current date.

### 4.5 Analytic dimensions: Centro de costo, Auxiliar abierto, Ítem, Unidad de negocio
Four masters with one shape, used for analytic accounting on any line (owner 2026-10-28 for the last three):

| Entity | Table | Spanish | Typical content |
|---|---|---|---|
| `accounting.cost_center` | `cost_centers` | Centro de costo | areas and stores (Administración, Tostión, Tiendas → Tienda Chapinero) |
| `accounting.open_auxiliary` | `open_auxiliaries` | Auxiliar abierto | free analytic sub-ledger: projects, contracts, vehicles, employees (Proyectos → Exportación piloto; Vehículos → Camioneta NPR) |
| `accounting.item` | `items` | Ítem | what was sold or bought, independent of the product catalogue (Café → Café tostado 500 g; Bebidas → Espresso) |
| `accounting.business_unit` | `business_units` | Unidad de negocio | lines of business that cut across cost centers (Consumo → Tiendas, Web; Institucional → Horeca, Distribuidores; Corporativo). The only dimension that also lives on the comprobante header: `entries.business_unit_id` is the default for its lines; a line may override it; at post the engine writes the resolved value on every line, so views and reports read lines only (my call) |

Fields, identical on the four: `code` (unique per company, free format), `name` (descripción), `parent_id` (same table), `kind` (`group | leaf`; only leaves receive lines; a group with lines cannot become a leaf's child and a leaf with lines cannot become a group), `is_active` (an inactive node is refused on new lines and hidden from lookups, never deleted). One tree per company and per dimension, any depth. No default node: an account that requires the dimension and a rule or user that does not supply it is a visible posting failure (`missing_cost_center`, `missing_open_auxiliary`, `missing_item`). A line may carry any combination of the four; the account flags of §4.1 say which are required. Rule templates set `businessUnit` on the header (`$.businessUnitId`) or per line.

The kernel gains nothing new for them: the four are ordinary entities. The UI shares one **analytic master page** (§8): a Tabla · Árbol toggle, the same record frame, the same Nuevo form (código, descripción, padre, tipo grupo / hoja, activo). `cost_centers.allows_movement` of the first draft becomes `kind` so the four masters are the same component (my call).

### 4.6 Journal entry (`accounting.entry`, table `entries`) — Comprobante
| Field | Notes |
|---|---|
| `journal_id` | ref journal |
| `number` | consecutivo `<journal code>-<n>` from the journal's own counter (§4.3), assigned at post, null while draft |
| `date` | fecha; must fall in an open period at post time |
| `period_id` | derived from `date` at post |
| `status` | enum `draft | pending | posted | reversed | voided`. `voided` only from `draft` or `pending`. When `require_approval_on_manual` is on, a manual entry goes `draft → pending → posted`: `entry.submit` moves it to `pending` (read-only), `entry.post` is the approval and refuses when the poster is the creator (§5.12) |
| `reverse_on` | date, optional (acumulación con reversión automática): at post the engine creates the mirrored reversal as a draft dated `reverse_on`, linked both ways; posting that draft marks this entry `reversed` (§5.12) |
| `submitted_by`, `submitted_at` | who sent the entry to approval and when; `posted_by` is the approver |
| `description` | Detalle |
| `currency`, `exchange_rate` | document currency and rate snapshot (rule 8); COP, 1 by default |
| `total_debit`, `total_credit` | company currency, maintained by trigger, equal when posted |
| `source_event_id` | ref `kernel.outbox.id` when posted by the engine; unique per `(source_event_id, posting_rule_id)` |
| `posting_rule_id` | ref posting rule, nullable |
| `source_entity`, `source_record_id` | the business document (`invoicing.invoice`, uuid) for the "Contabilidad" tab of that document and the `v_entries_for_source` view |
| `chain_id` | causal chain of the originating process (audit) |
| `business_unit_id` | ref unidad de negocio leaf, optional; default for the lines (§4.5); shown in the header of the record |
| `reversal_of_id`, `reversed_by_id` | reversal links |
| `is_opening`, `is_closing` | flags set by the opening and closing processes; excluded from the income statement and from "movimientos del período" by default |
| `posted_at`, `posted_by` | |

Attachments on every entry (soportes); the admin may define required files for manual journals (§5.13 of the main design).

### 4.7 Journal entry line (`accounting.entry_line`, table `entry_lines`) — Movimiento
| Field | Notes |
|---|---|
| `entry_id`, `line_no` | |
| `account_id` | must `allows_movement` and be active at post |
| `party_id` | uuid of a `core.party`, validated through `core.v_parties` in the process, no cross-schema foreign key (rule 3); required when the account `requires_party` |
| `cost_center_id` | ref cost center leaf; required when the account `requires_cost_center` |
| `open_auxiliary_id` | ref auxiliar abierto leaf, optional; required when the account `requires_open_auxiliary` |
| `item_id` | ref ítem leaf, optional; required when the account `requires_item` |
| `business_unit_id` | ref unidad de negocio leaf; empty on input means the header's; stored resolved at post; required when the account `requires_business_unit` and neither line nor header has one |
| `description` | |
| `debit`, `credit` | company currency; exactly one is non-zero |
| `debit_doc`, `credit_doc` | document currency |
| `tax_code`, `tax_rate`, `tax_base` | filled on tax and withholding lines. `tax_code` comes from the pack catalogue and encodes concept and rate (`IVA_19`, `IVA_5`, `INC_8`, `RTEFTE_SERVICIOS_4`, `RTEFTE_COMPRAS_2_5`, `RTEIVA_15`, `RTEICA_<municipio>_<tarifa>`), `tax_rate` is the numeric rate, `tax_base` the base amount, so exógena (formato 1001 and others) and retention certificates can be built from lines alone |
| `reference` | free reference (invoice number, cheque) |
| `due_date` | for receivable and payable lines; rules fill it from the document (`dueDate` in the template), humans from the lines grid; `report.aging` reads it (§5.11) |

Lines are editable only while the entry is `draft`.

### 4.8 Posting rule (`accounting.posting_rule`, table `posting_rules`) — Regla contable
Per-company copy of a module's default rule, editable by the admin.

| Field | Notes |
|---|---|
| `event` | event id (`invoicing.invoice.issued`) |
| `name`, `description` | |
| `module` | the module that shipped the default, nullable for company-made rules |
| `journal_id` | journal the entry goes to |
| `template` | jsonb, the rule template of §5.2, validated by the kernel Zod schema |
| `priority` | integer; several rules may match one event (each produces its own entry) |
| `is_default`, `is_modified` | default shipped by a manifest; modified by the company ("Restablecer" restores the manifest version) |
| `is_active` | |

### 4.9 Posting failure (`accounting.posting_failure`, table `posting_failures`) — Pendiente de contabilizar
`event_id` (outbox), `event`, `event_date`, `posting_rule_id`, `payload` (jsonb, as received), `error_code` (`unbalanced | missing_account_mapping | closed_period | inactive_account | missing_party | missing_cost_center | missing_open_auxiliary | missing_item | missing_business_unit | inactive_dimension | invalid_template | no_journal`), `error_detail`, `status` (`pending | resolved | dismissed`), `resolved_entry_id`, `attempts`, `last_attempt_at`.

### 4.10 Entry template (`accounting.entry_template`, `accounting.entry_template_line`) — Plantilla de comprobante
Recurring manual entries (arriendo, provisiones, depreciación manual until phase 3): `name`, `journal_id`, `description`; lines with `account_id`, `party_id`, `cost_center_id`, `open_auxiliary_id`, `item_id`, `business_unit_id`, side, optional fixed amount; the template header may carry a default `business_unit_id`. `entry.from_template` creates a draft the user completes. My call, small, keeps accountants from retyping the same entry monthly.

### 4.11 Settings (`accounting.settings`, one row per company) — Configuración contable
`ledger_starts_on` (date, default the day the chart was seeded: events dated before it are acknowledged without posting and counted, since opening balances cover them, §5.1), `rounding_tolerance` (numeric, default 1.0000 COP: a difference up to this is posted to role `rounding`), `manual_journal_id` (default journal for manual entries, NC), `require_attachment_on_manual` (boolean, default false), `niif_group` (`1 | 2 | 3`, informational, default 2), `require_approval_on_manual` (boolean, default false: when on, manual entries need a second person to post them, §5.12), `use_open_auxiliaries`, `use_items` and `use_business_units` (boolean, default false: when off, the dimension's columns, filters and menu item stay hidden so a company that does not use it never sees it; turning one on is `settings.update` under step-up). My call.

### 4.12 Published views (read by other modules, rule 3)
- `accounting.v_account_balances(company_id, period_id, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id, debit, credit)` aggregated from posted lines; indexed on `(company_id, period_id, account_id)`.
- `accounting.v_entries_for_source(source_entity, source_record_id, entry_id, number, date, status, total_debit)` for the "Contabilidad" tab on any document.
- `accounting.v_tax_lines(entry_id, date, party_id, tax_code, tax_base, debit, credit)` for exógena and certificates (Colombia pack part 2).
- `accounting.v_open_items(company_id, account_id, party_id, entry_id, line_no, date, due_date, original, open)` receivable and payable lines with their unapplied amount, computed by FIFO per party and account from posted lines (§5.11); replaced by the payments module's allocations when that module is enabled.

### 4.13 Fiscal concept mapping (`accounting.fiscal_concept_mapping`, table `fiscal_concept_mappings`) — Conceptos de exógena
Owner 2026-10-28 (§10b.14). Resolves the DIAN exógena concepts to accounts of this company, the same way role mappings resolve roles.

| Field | Notes |
|---|---|
| `format` | text, e.g. `1001`, `1003`, `1005`, `1006`, `1007`, `1008`, `1009`; the catalogue of formats, their version per tax year, concept codes and columns comes from `pack.accounting.exogenaFormats(year)` in `packages/localization/co` (rule 4: fiscal logic only in the pack) |
| `concept` | concept code from the catalogue (`5001` salarios, `5002` honorarios, `5004` servicios, `5005` arrendamientos, `5007` compras, `4001` ingresos operacionales, `1315` clientes, `2201` proveedores…) |
| `account_id` | an account at any level; descendants inherit; one account belongs to one concept per format |
| `is_active` | |

Seeded by `chart.seed` from `pack.accounting.defaultConceptMappings()` for the PUC accounts the DIAN concepts name directly; the accountant completes it. Unmapped accounts with movement show in red on the Conceptos exógena tab and the report refuses to export while any exists. The mapping is edited under step-up (`fiscal_concept_mapping.update`). Withholding columns (retefuente, reteIVA, reteICA practised or suffered) need no mapping: they come from `tax_code` on the lines (§4.7, §10a.9). The pack also supplies the per-year thresholds (cuantías menores, the `222222222` aggregation NIT) and the XML writer.

### 4.14 Period close check (`accounting.period_close_check`, table `period_close_checks`) — Verificación de cierre
Owner 2026-10-28 (§10b.16). One row per check that `period.close` ran: `period_id`, `check` (`drafts | pending_failures | pending_approvals | undispatched_events | control_receivable | control_payable | control_inventory | suspense_zero | rounding_within_tolerance | contra_nature_balances`), `value` (jsonb: the figures compared), `passed`, `note`, plus the rule 7 columns (who ran it and when are the sign-off). Append-only like the audit; a reopen and a second close produce a second set of rows. The Cierre tab of the period record lists them.

### 4.15 Account permission (`accounting.account_permission`, table `account_permissions`) — Seguridad por cuenta
Owner 2026-10-28 (§10b.17). Who may see and who may post to a restricted account.

| Field | Notes |
|---|---|
| `account_id` | the restricted account (any level); descendants inherit the grant unless they carry their own |
| `subject_kind` | enum `role | user` |
| `subject_id` | a `kernel.roles` id or a `kernel.users` id of this company |
| `can_view` | boolean: balances, movements, the account in trees, lookups and reports |
| `can_post` | boolean: lines on this account in `entry.create / update / post`, templates, imports and the assistant; implies `can_view` |
| `is_active` | |

Resolution for a user and an account: take the nearest ancestor-or-self account with `access` set; if it is `open`, allowed; if `restricted`, the user's own grant on that account wins, else any of the user's roles' grants (view if any grants view, post if any grants post), else denied. Admins hold every permission (main design §6) and are the only ones who may edit grants (`account_permission.update`, step-up, audited). The engine's automatic postings (origin `event`) are not subject to `can_post`: a posting rule is already an admin's decision under step-up; a human editing the resulting entry is.

### 4.16 Ledger line query (`accounting.ledger_line`, view `v_ledger_lines`) — Movimiento (consulta)
Owner 2026-10-29 (§10b.19). A read-only registry entity (no table of its own, `kind: "query"`) over the view `v_ledger_lines`, which joins `entry_lines` with their entry, account, party and the four analytic dimensions so that every field of a comprobante line is one filterable, sortable, groupable column. Every column below is `filterable` and `sortable` in the registry; money columns are `aggregatable`.

| Column | Source | Notes |
|---|---|---|
| `entry_id`, `number`, `date`, `period_id`, `fiscal_year` | entry | `number` null while draft |
| `journal_id` → `journal_code` | entry → journal | Fuente |
| `status`, `origin`, `created_by`, `posted_by`, `posted_at` | entry | status `draft | pending | posted | reversed | voided`; origin `manual | auto | import | template` |
| `source_entity`, `source_record_id`, `source_ref`, `posting_rule_id` | entry | the document that produced the entry, when automatic |
| `entry_description`, `line_no`, `description`, `reference` | entry, line | |
| `account_id` → `account_code`, `account_name`, `account_class` (1 char), `account_group` (2), `account_level` | account | restricted accounts filtered by `can_view_account` (§5.13) |
| `party_id` → `party_document`, `party_name` | party | |
| `cost_center_id`, `open_auxiliary_id`, `item_id`, `business_unit_id` (+ `_code`, `_name` each) | line (business unit resolved at post, §4.5) | |
| `debit`, `credit`, `net` (`debit - credit`), `signed_net` (by the account's nature) | line | money |
| `tax_code`, `tax_base`, `due_date` | line | |
| `reversal_of_id`, `reversed_by_id`, `is_opening`, `is_closing`, `reverse_on` | entry | |

Indexes on the underlying tables already cover `(company_id, date)`, `(company_id, account_id, date)`, `(company_id, party_id)` and each dimension column; the view adds nothing stored.

## 5. The posting engine (`packages/kernel/src/posting`)

### 5.1 Position in the pipeline
The kernel engine is generic and knows no module (rule 4). A module manifest may declare `postingProvider`, an object implementing:

```ts
interface PostingProvider {
  rulesFor(ctx, event: string): Promise<PostingRule[]>;          // active rules of the company for this event
  resolveAccount(ctx, role: string, dimension?: string): Promise<ResolvedAccount | null>;
  ledgerStartsOn(ctx): Promise<Date | null>;                       // null: ledger not set up yet
  post(ctx, draft: ComposedEntry): Promise<{ entryId: string }>;  // runs the provider's own process
  reverse(ctx, ref: { event: string; sourceId: string }): Promise<{ entryId: string } | null>;
  recordFailure(ctx, failure: PostingFailure): Promise<void>;     // runs the provider's own process
  effectsFor(ctx, event: string): Promise<string[]>;              // copy for confirmation cards ("Contabilidad: asiento en Ventas")
}
```

The accounting module registers itself as the provider, and its manifest consumes `"*"` (a kernel change: `consumes` accepts the wildcard; `consumers.for(event)` returns wildcard consumers after the specific ones). Because the consumer belongs to `accounting`, the outbox dispatcher's existing rule for disabled modules applies: a company without accounting keeps its events parked for this consumer, so enabling the module later finds them (design §5.12). Two kernel adjustments come with this: parked rows for a disabled consumer are not re-claimed on every tick (the dispatcher skips consumers of modules disabled for the company until the module is enabled), and the engine checks `ledgerStartsOn` first, acknowledging without posting every event dated before it (counted in Reglas contables → Configuración as "eventos anteriores al inicio del libro").

Composition: the engine resolves the template against the payload, resolves roles through the provider, balances (§5.5) and calls `provider.post`, which runs `accounting.entry.post_from_event`, a process restricted to origin `event` (kernel change: `ProcessDef.origins?: Origin[]`; a process with `origins` set is never offered in the sensitive processes admin page, since no human can pay its step-up). It is audited with origin `event`, the chain id of the originating process and the rule id. Humans and the assistant use `accounting.entry.post`, which the admin may raise to step-up without touching automatic postings.

Idempotency: `post_from_event` uses idempotency key `posting:<event_id>:<rule_id>`, and `entries` has a unique index on `(source_event_id, posting_rule_id)`. Redelivery produces the first entry's result.

### 5.2 Rule template
A declarative JSON document; no code is evaluated. Paths are a JSONPath subset: dot segments, `[*]` once per path for `forEach`. Strings in `description` use `{{path}}` interpolation. The Zod schema lives in the kernel and is what the UI editor and `posting_rule.update` validate.

```jsonc
{
  "date": "$.issuedAt",                       // entry date; default event created_at
  "description": "Factura {{number}} · {{customer.legalName}}",
  "party": "$.customer.partyId",              // default party for lines that do not set one
  "costCenter": "$.costCenterId",             // default cost center, optional
  "openAuxiliary": "$.projectId",             // default auxiliar abierto, optional
  "item": "$.line.itemId",                    // default ítem, optional; a line may set its own
  "businessUnit": "$.businessUnitId",         // header unidad de negocio, optional; a line may override
  "currency": "$.currency", "exchangeRate": "$.exchangeRate",
  "source": { "entity": "invoicing.invoice", "id": "$.invoiceId" },
  "lines": [
    { "role": "receivable", "side": "debit",  "amount": "$.totals.total", "dueDate": "$.dueDate" },
    { "role": "revenue",    "side": "credit", "forEach": "$.lines[*]", "amount": "$.subtotal",
      "dimension": "category:{{categoryId}}", "costCenter": "$.costCenterId" },
    { "role": "vat_out",    "side": "credit", "forEach": "$.taxes[*]", "amount": "$.amount",
      "dimension": "tax:{{code}}", "taxCode": "$.code", "taxBase": "$.base" }
  ],
  "reverseOf": null                            // or { "event": "invoicing.invoice.issued", "sourceId": "$.invoiceId" }
}
```

Line fields: `role` or `account` (explicit code, discouraged), `side`, `amount`, optional `forEach`, `dimension`, `party`, `costCenter`, `description`, `taxCode`, `taxBase`, `reference`, `dueDate`. Inside a `forEach`, paths are relative to the item; `$$.` reaches the root payload. Lines whose amount resolves to 0 are dropped. Negative amounts flip the side.

`reverseOf` makes a rule a reversal: the engine finds the entry posted for the referenced event and source id and runs `accounting.entry.reverse` instead of composing lines. This is how `invoicing.invoice.voided` and `payments.payment.voided` are handled without a second template.

### 5.3 Account role catalogue
Roles are identifiers kernel-side (`packages/kernel/src/posting/roles.ts`) that modules reference in their templates and the Colombia pack maps to PUC codes. Phase 2 set: `cash`, `bank`, `receivable`, `customer_advances`, `revenue`, `sales_returns`, `sales_discounts`, `vat_out`, `inc_out`, `vat_in`, `withholding_income_suffered` (retención en la fuente que nos practican), `withholding_vat_suffered`, `withholding_ica_suffered`, `withholding_income_payable`, `withholding_vat_payable`, `withholding_ica_payable`, `inventory`, `inventory_adjustment`, `cogs`, `payable`, `supplier_advances`, `rounding`, `income_summary` (ganancias y pérdidas, 5905), `current_year_profit` (3605), `current_year_loss` (3610), `retained_earnings` (3705), `accumulated_losses` (3710), `opening_equity`. A module adds roles in its manifest; the pack must map every role a module declares or the module cannot be enabled for a company of that country (checked by `kernel.module.enable`).

### 5.4 Default rules shipped by phase 2 modules (the §8.1 flow)
| Event | Journal | Lines |
|---|---|---|
| `invoicing.invoice.issued` | Ventas | Dr receivable (party, due date, gross) · Cr revenue per line (category dimension, cost center) · Cr vat_out / inc_out per tax (tax dimension, rate, base). Withholdings the customer will practise are **not** recognised here (§10a.7) |
| `invoicing.note.issued` (credit) | Ventas | mirror of the above with sales_returns / revenue per note reason |
| `invoicing.note.issued` (debit) | Ventas | Dr receivable · Cr revenue · Cr vat_out |
| `invoicing.invoice.voided` | Ventas | `reverseOf` invoice.issued |
| `costing.cogs.posted` | Notas | Dr cogs (cost center) · Cr inventory |
| `inventory.movement.posted` kind `adjustment` | Notas | Dr/Cr inventory_adjustment · Cr/Dr inventory |
| `payments.received` | Recibos de caja | Dr cash / bank (payment_method dimension) · Cr receivable (party) · Dr withholdings suffered (retefuente, reteIVA, reteICA) per withholding the customer practised, with code, rate and base |
| `payments.payment.voided` | Recibos de caja | `reverseOf` payments.received |
| `kernel.import.opening_balances` (phase 2b) | Apertura | pass-through lines by account code, `is_opening` |

Purchases, bank, assets and payroll add theirs in their phases through the same mechanism.

### 5.5 Validation and failure handling
`accounting.entry.post` enforces, for engine and humans alike (plus the four-eyes rule of §5.12 for manual entries): at least two lines; every line exactly one side; sum debit = sum credit after the rounding line (difference ≤ `rounding_tolerance` goes to `rounding`, above it `unbalanced`); account active and `allows_movement`; party present where required; each analytic dimension (cost center, auxiliar abierto, ítem, unidad de negocio after header inheritance) present where the account requires it, and when present a leaf and active; date inside an open period; journal active; manual journals only for manual entries.

Engine failures are configuration or state problems that retrying will not fix, so the consumer records a `posting_failure`, emits `accounting.posting.failed` and acknowledges the event (no infinite retry); transient errors (connection, lock timeout) throw and let the outbox workflow retry. The entry date is always the source document's own date (`$.date` of the event), never the date of a document it references: a credit note issued on 2026-11-01 against an invoice of 2026-10-30 posts in November, and November being open is all that is checked (owner decision 2026-10-28). `closed_period` applies only to documents whose own date falls in a closed period: the failure is recorded and the inbox offers "Reabrir período" to users with the `period.reopen` permission (step-up, for the whole period or for that single day, §5.7) followed by "Reintentar". The engine never moves an entry to another period. The admin fixes the cause (maps the account, reopens the period, activates the account) and runs `posting.retry`, which re-executes the rule on the stored payload under the same idempotency key.

Balances are never stored as snapshots: `v_account_balances` aggregates posted lines by period, so an entry posted into a reopened period changes the opening balance of every later period the moment it posts, with no recalculation step. The only exception is a year already closed, whose closing entries are reversed by `year.reopen` before the period can be reopened.

### 5.6 Posting rule changes
`posting_rule.create/update/disable` and `account_role_mapping.update` are `step-up` processes (main design §5.6). `posting_rule.test` (consult) runs a rule against a chosen past event of the company and returns the entry it would produce, without posting; the rule page shows it as a preview grid. The assistant may call `posting_rule.test` freely and proposes changes as a confirmation card that asks for the TOTP code.

### 5.7 Period and year processes
- `period.close` (step-up): refuses while the period has draft entries or pending posting failures dated in it (lists them); emits `accounting.period.closed`. Closing a period does not touch later ones; periods close in order (period N requires N−1 closed).
- `period.reopen` (step-up): any closed period of an open fiscal year (a closed year needs `year.reopen` first); optional `date` inside the period sets `reopened_for`, so only entries dated that day may post until the period is closed again (the usual case: one late document); increments `reopened_count`; emits `accounting.period.reopened`. Later periods stay closed; their balances follow the new entry because balances are computed (§5.5). `period.close` closes it again and clears `reopened_for`.
- `year.close` (step-up): requires the 12 periods closed; computes the balance of classes 4, 5, 6, 7 (excluding `is_opening`) and posts two entries in the Cierre journal dated `ends_on`, both `is_closing`: the first zeroes every result account against `income_summary` (5905), the second moves the 5905 balance to `current_year_profit` (3605) when credit or `current_year_loss` (3610) when debit. Then it closes the year, opens the next year with its 12 periods if not yet open, and emits `accounting.year.closed`. Reclassifying the result to `retained_earnings` or `accumulated_losses` after the asamblea is a manual entry (template seeded).
- `year.reopen` (step-up): reverses the closing entry and reopens the year and its December period.
- `fiscal_year.open`: creates the year and its periods; the first one is created on module enable.

Close checklist, extended by §5.12: `period.close` refuses while the period has drafts, entries pending approval, posting failures or undispatched events dated inside it; it then runs the control checks of §4.14 (receivable, payable and inventory control accounts tied to their subledgers, `suspense` at zero, `rounding` within tolerance for the period, no contra-nature balances) and refuses on any failed check, listing the figures; every check is recorded in `period_close_checks` with the user and time as the sign-off, and the Cierre tab shows them.

### 5.8 Opening balances
Opening balances arrive as **draft** entries in the Apertura journal: `accounting.opening.create` (normal) receives lines `(accountCode, partyDocument?, costCenterCode?, debit, credit)`, resolves them and creates the draft dated `ledger_starts_on` with `is_opening = true`; phase 2b's import framework calls it per file, as it calls any entity's `create`. The accountant then runs `accounting.opening.post` (step-up) from the Comprobante record, which is the human step the rule requires. The `opening_balance` rule of main design §5.11 is this pair of processes.

### 5.9 Country pack extension (`packages/localization/co`)

The `statementLayouts` of the pack include, besides balance and income statement, the line codes of the DIAN formato 2516 (H2 ESF, H3 ERI) keyed by PUC account prefix, so every 2516 line can read its **valor contable** column from the single ledger (§5.10).
`CountryPack.accounting`:
- `chartOfAccounts(): AccountSeed[]` the PUC through subcuenta level, with `nature`, `requires_party`, `requires_cost_center` (`requires_open_auxiliary`, `requires_item` and `requires_business_unit` seed false), `statement_section`, `is_opening_result`.
- `defaultRoleMappings(): { role, dimension?, code }[]` e.g. `receivable → 130505`, `vat_out tax:IVA19 → 240801`, `vat_out tax:IVA5 → 240802`, `inc_out → 2495…`, `withholding_income_suffered → 135515`, `cogs → 6135…`, `inventory → 1435`, `income_summary → 590505`, `current_year_profit → 360505`, `current_year_loss → 361005`, `retained_earnings → 370505`, `accumulated_losses → 371005`, `rounding → 530595`.
- `validateAccountCode(code, parentCode?)`.
- `fiscalYearFor(date): { year, startsOn, endsOn }` (calendar year).
- `statementLayouts(): { balanceSheet, incomeStatement }` sections ordered, each a list of `statement_section` codes with labels (i18n keys).
- `defaultJournals()` the seven of §4.3.
- `taxCodes()` the codes rules may put in `tax_code` (IVA19, IVA5, IVA0, EXC, INC8, RTEFTE, RTEIVA, RTEICA…), shared with Colombia pack part 2's tax engine.

Enabling the module does not seed anything (enabling is an entitlement write with no user step-up available). The first visit to Contabilidad by a user who may run it shows a single action, **Configurar contabilidad**, which runs `accounting.chart.seed` (step-up, admin) and writes accounts, mappings, journals, the current fiscal year, `ledger_starts_on` and settings from the pack; re-running it only adds what is missing and never overwrites company edits. Until it has run, the posting engine finds `ledgerStartsOn = null` and acknowledges events without posting (counted).

### 5.10 Fiscal differences and formato 2516 with a single ledger (owner question 2026-10-28)

Formato 2516 (conciliación fiscal, art. 1.7.1 DUR, Resolución DIAN vigente) is a worksheet with three columns per line: valor contable, efecto de conversión fiscal, valor fiscal. The single PUC ledger provides the first column directly through the 2516 layout of §5.9, and `v_tax_lines` feeds section H5 (ingresos y facturación) and the retention certificates. The second column is a finite list of adjustments per year (depreciación fiscal vs contable, provisiones y deterioros no deducibles, gastos sin soporte, GMF al 50 %, impuestos asumidos, ingresos no constitutivos de renta, diferencias temporarias con su impuesto diferido), which Colombian accountants of grupo 2 companies enter once a year from their own working papers, not per transaction. A second fiscal ledger is therefore not needed to produce 2516: a reconciliation layer over the same ledger is. Design, deferred to the fiscal-reports item of phase 3 unless the owner pulls it into phase 2:

- `accounting.fiscal_adjustment(fiscal_year_id, line_code, amount, kind permanent|temporary, concept, note)` entered manually (process `fiscal_adjustment.create/update/void`, normal) or seeded by later modules (fixed assets posts the depreciation difference it knows).
- Report `fiscal_reconciliation` (consult): 2516 lines with contable from the ledger, conversión from the adjustments, fiscal as the sum; export in the DIAN prevalidador layout.
- Companies of grupo 1 with material dual reporting are the case for a second ledger dimension on `entry_lines`; none is planned.

### 5.11 Exógena and aging (owner 2026-10-28, from the market benchmark)
**Exógena.** `accounting.report.exogena(year, format, threshold?)` is a consult over `v_account_balances`, `v_tax_lines` and the concept mapping of §4.13: for each party and concept it sums the year's movement of the mapped accounts (and their descendants) on the side the format reports (debit for 1001 and 1005, credit for 1006 and 1007); opposite-side lines count only when the entry is a reversal or a credit note of a counted document, so a cost-of-sales credit to inventory or a reclassification never appears as a payment; opening entries never count in movement formats and always count in the balance formats 1008 and 1009; withholding columns come from `v_tax_lines` grouped by party and `tax_code` family; a line without party on a mapped account takes the party of its entry's source document (rules set `party` on the header, §5.2) and is otherwise listed as an error. Parties below the format's threshold are aggregated under the pack's cuantías-menores NIT. Export: the grid's Excel and CSV, plus `co.exogena.export_xml(year, format)` in the pack, which writes the XML of the prevalidador and refuses while the report lists errors (unmapped accounts with movement, lines without party, parties missing DANE codes or document type, §5.18 of the main design already captures those fields). The concept catalogue, versions, thresholds and XML layout are the pack's and change per tax year without touching the module.

**Aging.** `accounting.report.aging(kind receivable | payable, as_of, buckets?)` reads `v_open_items`: for the accounts that `requires_party` under the pack's receivable (13) and payable (22, 23) classes, each debit (receivable) or credit (payable) line with a `due_date` is an open item; credits (receivable) or debits (payable) of the same party and account are applied FIFO by due date. Buckets default to por vencer · 1–30 · 31–60 · 61–90 · más de 90 days after `due_date` at `as_of`, editable in the parameter bar; rows per party with a total column, drill-down to the party's auxiliar and to each open document. My call: FIFO in the ledger is enough for phase 2 because the payments module of this phase posts receipts and payments through rules; when its allocations exist (`payments.v_allocations`), `v_open_items` reads them instead of FIFO, so the report does not change.

### 5.12 Controls from the best-practice review (owner 2026-10-28)
Sources: COSO and ISA 240 on journal-entry controls, Kieso/Weygandt and the Oracle and NetSuite close guides on reversing entries and subledger tie-out, Bragg's *Fast Close*, the MFMA guidance on suspense accounts. Five controls, all small:

1. **Four-eyes on manual entries.** With `require_approval_on_manual` on, `entry.submit` (normal) moves a manual or assistant draft to `pending`, read-only; `entry.post` is the approval and refuses with `same_user_approval` when `posted_by` would equal `created_by`; `entry.return_to_draft` moves `pending` back to `draft` in place, lines untouched, with an optional reason (devolver; owner 2026-10-30, main §22.20 OD-1; `entry.update` no longer accepts a pending entry). Automatic entries (`origin: event`) are not affected: their control is the posting rule, changed under step-up. The assistant's confirmation card for a draft it wrote says who will have to approve it. Comprobantes gains the quick filter Por aprobar and a home widget count.
2. **Auto-reversing accruals.** `entries.reverse_on`: at post the engine creates the mirrored entry as a draft dated `reverse_on` (same journal, lines inverted, `reversal_of_id` set, `is_auto_reversal`), in the same chain; it appears in Borradores of the next period and in its close checklist, so it cannot be forgotten; posting it marks the original `reversed`. Phase 3's scheduler may post those drafts on their date under origin `scheduler`; until then a person posts them.
3. **Subledger tie-out at close.** Consult `accounting.report.control_reconciliation(as_of)`: for the roles `receivable` and `payable`, the ledger balance by party against the open items (`v_open_items`, or the payments module's allocations when present); for `inventory`, the ledger balance against `inventory.v_stock_value`; differences listed by party or warehouse. `period.close` runs it and refuses on a difference above `rounding_tolerance` (§4.14).
4. **Suspense at zero.** Role `suspense` mapped by the pack (Colombia: an auxiliar under 2380 or 1399, the company chooses); `period.close` refuses while its balance at period end is not zero, and the report of item 3 shows the open lines.
5. **Auditor extract of manual entries.** Consult `accounting.report.manual_entries_audit(from, to)`: every non-automatic posted entry with creator, submitter, poster, timestamps, whether it was posted after the period's first close, round-amount flag (multiple of 1 000 000 COP, parameter), attachment count, line count and amount; drill-down to the entry; exports through the grid like any report. ISA 240 asks for exactly this list.

Deferred to the roadmap (owner 2026-10-28): posting window per role (phase 2b), scheduled templates, FX revaluation, step-down allocations, deferral schedules, management chart mapping and XBRL export (phase 3), prior-period error marker (later).

### 5.13 Security by account (owner 2026-10-28)
Enforcement lives in the database so every path (grid, reports, assistant, exports, API) behaves the same:
- `accounting.can_view_account(account_id)` and `accounting.can_post_account(account_id)` are SQL functions over §4.15 for the current user; `v_entry_lines`, `v_account_balances`, `v_tax_lines`, `v_open_items` and the account view return a row of a restricted account only when `can_view_account` is true, and the chart tree marks the node as restricted with no figures.
- Reports never hide money, only detail: Balance de prueba, Mayor y balances, Estado de resultados and Situación financiera keep the parents' totals and replace the accounts the user may not see by one line "Cuentas restringidas (n)" with their aggregated figures, so sumas iguales and the equation still hold; line reports (Auxiliar, Tercero, Libro diario, dimensión) omit the lines and say how many were omitted; an Auxiliar asked directly for a restricted account answers "Sin acceso".
- A comprobante record shows a restricted line with its account and amounts masked (`••••`, field visibility as in main design §6) and the entry totals intact; the lines editor offers only accounts the user may post to; `entry.create / update / post`, `entry.from_template`, the importer and the assistant refuse a line on a forbidden account with `account_forbidden` naming the account, never silently dropping it.
- Administration: Plan de cuentas → account record → tab **Seguridad** (Abierta / Restringida switch, grants grid: rol o usuario · ver · contabilizar, Agregar, Quitar; step-up); the chart grid shows a Seguridad column and a quick filter Restringidas; the role and user records of Sistema get a **Cuentas** tab contributed by the accounting manifest (`recordTabs`, kind `grid`) listing their grants. Every change is audited with before and after.
- Typical use, seeded as examples by the pack but empty by default: 5105 gastos de personal (salaries) visible to contador and gerencia only; class 3 patrimonio visible to admin and contador; a bank account postable only by tesorería.

### 5.14 Consulta de movimientos (owner 2026-10-29)
Owner: "a page for querying ledger lines in general, able to filter by all the fields associated to a comprobante's line, including analytic variables (centro de costo, ítem, auxiliar abierto); allow multi-sort, multi-filter and multi-aggregate."

- **Page** Movimientos (`/accounting/movements`, §8): one DataGrid bound to `accounting.ledger_line` (§4.16), so the phase 1 grid gives the filter row under the header, the advanced conditions builder (`GridState.filters`, up to 50 conditions joined with and / or, every operator of the field's family: contains, equals, starts, between, in, is null…), column chooser, saved views per user, export and selection totals without new UI code.
- **Multi-filter**: the filter row (one quick condition per column) and the conditions builder combine; both become `GridState.filters` and the kernel query builder turns them into SQL over the masked view, so RLS and account security apply exactly as everywhere else (§5.13: a user without view on an account sees no line of it and the footer says how many lines were omitted).
- **Multi-sort**: `GridState.sort` already takes up to five fields; the grid gets shift-click on headers to append a sort level and shows the level number beside the arrow (phase 1 grid task).
- **Multi-aggregate** (kernel extension, recorded in §11): `GridState.groupBy` becomes `string[]` (max 3, ordered) and `aggregates` is applied per group as well as to the whole filter: `buildQuery` emits `groupAggregateSql` (`group by rollup(g1, g2, g3)` over the same where clause) and the grid renders collapsible group rows with the subtotal of every aggregated column, a grand total in the footer and the group path in exports. Aggregate functions per numeric column: `sum`, `avg`, `min`, `max`, `count` (several at once on the same column); non-numeric columns take `count`. Grouping fields may be any column of §4.16: account, class, group, party, fuente, status, origin, period, cost center, auxiliar abierto, ítem, unidad de negocio, tax code, due month.
- **Defaults**: filter `date between` the open period and `status = posted`; sort `date asc, number asc, line_no asc`; columns Fecha, Número, Fuente, Cuenta, Nombre de la cuenta, Tercero, Centro de costo, (Auxiliar abierto, Ítem, Unidad de negocio when in use), Detalle, Débito, Crédito, Neto, Estado. Drafts and pending entries appear only when the status filter asks for them, marked by the status pill. Opening and closing lines are included (they are ledger lines); the user excludes them with a condition on `is_opening` / `is_closing`.
- **Drill**: a row opens the comprobante record; a group row's context action opens the same query filtered to that group ("Ver líneas").
- **Saved consultas**: the phase 1 saved views (filters, sort, columns, groupBy, aggregates) per user; the plan seeds none.
- **Assistant**: `data.query` on `accounting.ledger_line` with the same state shape, so "gastos de octubre por centro de costo" is one call and the answer links to the page with that state in the URL (`?view=`, phase 1 convention).
- Not a report in the catalogue (§6): no fixed layout or libro header, no PDF signature block; the export is the grid export.

## 6. Processes

| Process | Kind | Sensitivity | Notes |
|---|---|---|---|
| `accounting.chart.seed` | create | step-up | from the pack, additive |
| `accounting.account.create / update / consult` | | normal | create only under a parent without movements; code validated by the pack; `update` may deactivate |
| `accounting.account_role_mapping.update / consult` | update | step-up | whole mapping or one role |
| `accounting.account_permission.update / consult` | update | step-up | §4.15, §5.13; admin only; sets `access` and the grants of one account |
| `accounting.journal.create / update / consult` | | normal | |
| `accounting.cost_center.create / update / consult` | | normal | `update` may deactivate or re-parent; `kind` changes refused when the node has lines or children conflict (§4.5) |
| `accounting.open_auxiliary.create / update / consult` | | normal | same rules |
| `accounting.item.create / update / consult` | | normal | same rules |
| `accounting.business_unit.create / update / consult` | | normal | same rules |
| `accounting.fiscal_year.open / consult`, `accounting.period.consult` | | normal | |
| `accounting.period.close / reopen` | update | step-up | §5.7 |
| `accounting.year.close / reopen` | update | step-up | §5.7 |
| `accounting.entry.create / update / void` | | normal | draft only (`update` refuses a pending entry, owner 2026-10-30); `void` drafts and pending entries |
| `accounting.entry.submit` | update | normal | §5.12, draft → pending; manual entries only |
| `accounting.entry.return_to_draft` | update | normal (admin may raise) | §5.12, pending → draft in place with an optional reason; granted with `entry.post` by default (owner 2026-10-30, main §22.20 OD-1) |
| `accounting.entry.post` | update | normal (admin may raise) | §5.5; humans and the assistant; the approval step under four-eyes (§5.12); creates the auto-reversal draft when `reverse_on` is set |
| `accounting.entry.post_from_event` | update | not raisable (origin `event` only) | §5.5; the engine's single write path |
| `accounting.entry.reverse` | create | normal (admin may raise) | new entry in the same journal, dated today or a given date in an open period, lines mirrored, links both ways, original status `reversed` |
| `accounting.entry.consult`, `accounting.entry_line.consult` | consult | | |
| `accounting.entry_template.create / update / consult`, `accounting.entry.from_template` | | normal | |
| `accounting.posting_rule.create / update / disable` | | step-up | §5.6 |
| `accounting.posting_rule.test` | consult | normal | simulate on a past event |
| `accounting.posting_failure.record` | create | not raisable (origin `event` only) | written by the provider when a rule fails |
| `accounting.posting.retry`, `accounting.posting_failure.dismiss / consult` | update | normal | retry under the same idempotency key; dismiss records a reason |
| `accounting.opening.create` | create | normal | §5.8, draft in Apertura; the importer's `create` |
| `accounting.opening.post` | update | step-up | §5.8 |
| `accounting.settings.update / consult` | update | step-up | |
| `accounting.report.trial_balance` | consult | normal | params: period from/to, level, cost center, auxiliar abierto, ítem, unidad de negocio, party, include opening, include closing, only with movement |
| `accounting.report.journal_book` | consult | normal | libro diario: date range, journal |
| `accounting.report.ledger` | consult | normal | libro mayor y balances: period, level |
| `accounting.report.account_detail` | consult | normal | auxiliar: account, period range, party, cost center, auxiliar abierto, ítem, unidad de negocio |
| `accounting.report.party_detail` | consult | normal | auxiliar por tercero: party, accounts, period range |
| `accounting.report.balance_sheet` | consult | normal | estado de situación financiera at period end, comparative with previous year end |
| `accounting.report.income_statement` | consult | normal | estado de resultados for a period range, by cost center column optional, comparative |
| `accounting.report.cost_center_statement` | consult | normal | income and expense by cost center tree |
| `accounting.fiscal_concept_mapping.update / consult` | update | step-up | §4.13, whole mapping or one concept |
| `accounting.report.exogena` | consult | normal | §5.11: year, format, threshold; errors list; export through the grid and `co.exogena.export_xml` |
| `accounting.report.aging` | consult | normal | §5.11: kind receivable / payable, as_of, buckets |
| `accounting.report.control_reconciliation` | consult | normal | §5.12: as_of; control accounts vs subledgers, suspense, rounding |
| `accounting.report.manual_entries_audit` | consult | normal | §5.12: from, to, round-amount threshold |
| `accounting.ledger_line.list / consult` | consult | normal | §4.16, §5.14: the Movimientos page and `data.query`; multi-filter, multi-sort, grouped aggregates; account security in the view |
| `accounting.report.dimension_detail` | consult | normal | auxiliar por dimensión analítica: dimension (cost center, auxiliar abierto, ítem, unidad de negocio), node (with its descendants), period range, optional account; rows by account with debit, credit and net, drill-down to the lines |

Events emitted: `accounting.entry.submitted`, `accounting.entry.posted`, `accounting.entry.reversed`, `accounting.period.closed`, `accounting.period.reopened`, `accounting.year.closed`, `accounting.posting.failed`. Consumed: `*` through the posting engine.

Features (entitlement keys): `accounting.ledger` (chart, journals, cost centers, auxiliares abiertos, ítems, unidades de negocio, entries, templates, reports), `accounting.periods` (fiscal years, periods, year close), `accounting.posting` (rules, mappings, concept mappings, failures, settings). The module depends on `core`.

## 7. Workflows (what a person does)

1. **Puesta en marcha contable.** Admin enables Contabilidad → `chart.seed` runs → the admin opens Reglas contables, reviews the role mapping (every role mapped, in green) and the default rules per enabled module → optionally adds auxiliares under subcuentas, cost centers, auxiliares abiertos, ítems and unidades de negocio (and turns the last three on in Configuración) → phase 2b loads the opening balances. Done when the mapping page shows no unmapped role and the first fiscal year is open.
2. **Contabilización automática.** A seller confirms an order; invoicing issues the invoice; the engine posts the Ventas entry; costing posts COGS; a receipt posts Recibos de caja. The accountant sees them arrive in Comprobantes filtered by "Hoy", opens one, and from Origen jumps to the invoice. If a posting failed, the Pendientes de contabilizar badge on Reglas contables and the home widget show it; the accountant fixes the cause and clicks Reintentar.
3. **Nota de contabilidad manual.** Comprobantes → Nuevo → journal NC, date, description, unidad de negocio of the whole comprobante when in use → lines grid (account lookup with magnifier, party lookup when required, cost center, auxiliar abierto, ítem and unidad de negocio override when in use, debit/credit with live totals and difference) → attach the soporte → Contabilizar. Or: Nuevo desde plantilla → fill amounts → Contabilizar. Or: ask the assistant "registra la provisión de arriendo de octubre por $ 2.500.000" → confirmation card showing the entry → accept.
4. **Reversión.** From a posted entry: Reversar → date (default today) and reason → a new entry mirrors it; both show the link. Used for errors; voids of documents reverse through their own event.
5. **Cierre mensual.** Períodos → the open month → Cerrar período: checklist (borradores: 0, pendientes de contabilizar: 0, eventos sin despachar: 0, saldos de naturaleza contraria: list) → TOTP → closed. Reabrir, with TOTP, when something was missed; the counter shows how often.
6. **Cierre de año.** Períodos → year → Cerrar año: shows the computed result and the closing entry preview → TOTP → closed, next year open.
7. **Informes.** Informes → report card → parameter bar → grid → drill: a trial balance row opens the auxiliar of the account; an auxiliar row opens the entry; the entry's Origen opens the document. Export PDF with the libro header (company, NIT, period, page x of y), Excel, CSV. Save the parameter set as a view.
8. **Cambiar una regla contable.** Reglas contables → rule → edit lines (role, side, amount path, dimension) → Probar con un evento real → preview → Guardar (TOTP). Or ask the assistant "las ventas de la categoría Bebidas deben ir a la 413520": it proposes the mapping change as a card with the diff and asks for the code.
9. **¿Qué pasó con la factura FE-1234?** From the invoice record's Contabilidad tab (a kernel record-frame tab shown on any entity that has rows in `v_entries_for_source`), or by asking the assistant, which reads the entries and the audit chain and explains.

6. **Exógena del año.** Reglas contables → Conceptos exógena: every account with movement in green; the accountant maps the few the pack could not guess → Informes → Información exógena → formato 1001, año 2026 → the grid by party and concept, the errors panel empty → Exportar XML → the file goes to the prevalidador. Done when every format of the year exported without errors.
7. **Cobrar lo vencido.** Informes → Cartera por edades → rows by customer with the 1–30 · 31–60 · 61–90 · > 90 columns → click a customer → its open invoices → the assistant: "¿quién me debe más de 90 días?" answers from the same report.
8. **Consultar movimientos (owner 2026-10-29).** Movimientos → the grid opens on the open period's posted lines → the accountant types `5105` in the Cuenta filter cell, adds the condition Centro de costo *en* (Ventas Bogotá, Ventas Medellín) and Tercero *contiene* "Nómina" → sorts by Fecha then Débito descending (shift-click) → Agrupar por Cuenta, then Centro de costo → the grid shows two levels of group rows with Σ débito, Σ crédito, Σ neto and the line count, grand total in the footer → Guardar vista "Gastos de personal por sede" → Excel keeps the groups. Marcela, without view on 5105, runs the same saved view and gets zero lines and the note "n movimientos en cuentas restringidas omitidos".

## 8. UI: menu items and pages

Module **Contabilidad** in the Módulos menu; its items in the top bar, in this order (`navigation` of the manifest, `feature` gated). Owner decision 2026-10-28: the masters sit under a **Maestros** group, so the bar shows five items (six since the owner added Movimientos on 2026-10-29, §10b.19); the group holds Plan de cuentas, Centros de costo, Auxiliares abiertos, Ítems, Unidades de negocio and Fuentes (the three analytic masters added by the owner the same day; their items are hidden while `use_open_auxiliaries` / `use_items` / `use_business_units` are off). `NavItem` gains `children?: NavItem[]` (kernel task): an item with children renders as a dropdown in the items bar, is active when any child route is active, and is hidden when no child passes its `feature` / `process` gate.

| Item | href | Feature | Page |
|---|---|---|---|
| Comprobantes | `/accounting/entries` | `accounting.ledger` | DataGrid of `accounting.entry` (number, date, journal, description, debit, credit, status, origin). Toolbar: Nuevo, Nuevo desde plantilla, quick filters Hoy · Este período · Borradores · Por aprobar · Automáticos · Manuales. |
| Movimientos | `/accounting/movements` | `accounting.ledger` | DataGrid of `accounting.ledger_line` (§4.16): every field of a comprobante line, including the four analytic dimensions, filterable from the filter row and the conditions builder, multi-sort by shift-click, Agrupar por up to three fields with Σ / promedio / mín / máx / conteo per group (§5.14). Toolbar: Agrupar por, Agregados, Columnas, Guardar vista, PDF / Excel / CSV. Default: open period, posted lines. Row → comprobante record. |
| Maestros ▾ | — | — | Group with the six masters below. Every hierarchical master (Plan de cuentas, Centros de costo, Auxiliares abiertos, Ítems, Unidades de negocio) offers a **Tabla · Árbol** toggle, remembered per user: Tabla is the DataGrid of every node with código, descripción, padre, tipo (grupo / hoja), estado and the period's movement (the selected period, passed as the declared grid parameter `period_id`, main §22.20 OD-2); Árbol is the tree pane with the selected period's figure beside each node and the DataGrid of the node's children on the right. |
| · Plan de cuentas | `/accounting/accounts` | `accounting.ledger` | Tabla · Árbol. Restricted nodes show a lock and no figures to users without view; Seguridad column and quick filter Restringidas. Árbol: PUC tree (search, expand by level, balance of the selected period beside each node) and the DataGrid of accounts under the selected node. Toolbar: Nueva cuenta auxiliar (enabled under a subcuenta), period selector, Importar (chart import template). |
| · Centros de costo | `/accounting/cost-centers` | `accounting.ledger` | Analytic master page (Tabla · Árbol); the tree shows the period's result beside each node; Nuevo. |
| · Auxiliares abiertos | `/accounting/open-auxiliaries` | `accounting.ledger` | Analytic master page, same component; the tree shows the period's net movement beside each node; Nuevo. Hidden while `use_open_auxiliaries` is off. |
| · Ítems | `/accounting/items` | `accounting.ledger` | Analytic master page, same component; Nuevo. Hidden while `use_items` is off. |
| · Unidades de negocio | `/accounting/business-units` | `accounting.ledger` | Analytic master page, same component; Nuevo. Hidden while `use_business_units` is off. |
| · Fuentes | `/accounting/journals` | `accounting.ledger` | DataGrid of journals (fuentes) with their consecutivo; record frame. |
| Períodos | `/accounting/periods` | `accounting.periods` | Fiscal years as cards; inside, the 12 periods as a grid with status, entries count, totals, Cerrar / Reabrir buttons (Reabrir asks for the whole period or one day); Cerrar año / Reabrir año on the year card. |
| Informes | `/accounting/reports` | `accounting.ledger` | Cards for the reports of §6 (eight, Auxiliar por dimensión analítica, Información exógena, Cartera y cuentas por pagar por edades, Conciliación de control, Auditoría de comprobantes manuales); `/accounting/reports/<report>` is the report page: parameter bar, DataGrid with totals footer, export buttons, Guardar vista. |
| Reglas contables | `/accounting/posting` | `accounting.posting` | Tabs: Reglas (grid by event and module, badge Modificada), Mapeo de cuentas (role → account grid, unmapped roles in red), Conceptos exógena (format → concept → accounts grid, accounts with movement and no concept in red, edit under step-up), Pendientes de contabilizar (grid with Reintentar / Reabrir período / Descartar; the item carries the pending count badge), Configuración. |

Records open in the record frame (`/r/<entity>/<id>`) with these tabs:
- **Comprobante**: Datos (header fields including Unidad de negocio when in use; lines grid editor while draft, with a Unidad de negocio column that shows the inherited header value until overridden, read-only after; totals and difference footer; header field Reversar el (acumulación); buttons Enviar a aprobación · Aprobar y contabilizar · Devolver a borrador · Contabilizar · Reversar · Anular borrador according to status and the four-eyes setting), Origen (source document link, event, posting rule, causal chain timeline from the audit), Datos adicionales, Archivos.
- **Cuenta**: Datos, Saldos (per period of the selected year, debit, credit, balance), Movimientos (auxiliar grid), Seguridad (admin: Abierta / Restringida, grants by role or user with ver and contabilizar), Datos adicionales, Archivos. Saldos and Movimientos answer "Sin acceso" to a user without `can_view`.
- **Centro de costo**: Datos (código, descripción, padre, tipo, activo), Resultados (income and expense by period), Movimientos, Datos adicionales, Archivos.
- **Auxiliar abierto**, **Ítem**, **Unidad de negocio**: Datos (same fields), Saldos por cuenta (debit, credit, net per account for the selected period range, descendants included), Movimientos, Datos adicionales, Archivos.
- **Período**: Datos, Resumen (entries by journal, totals), Comprobantes (grid filtered), Cierre (the recorded checks of §4.14 with figures, user and time, plus the close/reopen history).
- **Regla contable**: Datos (event, journal, priority, active), Líneas (template editor as a grid: role, side, amount path, dimension, party, cost center, auxiliar abierto, ítem, unidad de negocio, tax fields), Probar (pick a past event, preview entry), Historial (audit of changes).
- **Fuente**, **Plantilla de comprobante**: Datos, Datos adicionales, Archivos.

Home widgets contributed (phase 2 home gains module widgets, §19a): Resultado del mes (ingresos − costos − gastos), Pendientes de contabilizar (count, link), Períodos abiertos, Comprobantes en borrador.

Cross-module, without the kernel naming the module (rule 4): the manifest gains `recordTabs` contributions (`{ id, label, forEntities: "*" | string[], kind: "grid" | "mapping", source?: view, dimension?: string, roles?: string[], feature }`); accounting contributes a **Contabilidad** tab for every entity (`kind: "grid"`), shown only when `v_entries_for_source` has rows for the record. Owner decision 2026-10-28: accountants must also map accounts on the related entity itself. Accounting therefore contributes a second tab, `kind: "mapping"`, to `core.product_category` with `dimension: "category:<id>"` and `roles: ["revenue"]`: the tab shows **Cuenta de ingresos** as an account lookup (PUC code and name) and saves through `account_role_mapping.update` (step-up, confirmation card), writing the same `account_role_mappings` row that Reglas contables → Mapeo de cuentas edits. Later modules add their dimensions the same way (inventory and COGS by category, tax accounts on the tax record) without touching core. The assistant's confirmation cards list "Contabilidad: asiento en Ventas" among the effects through `PostingProvider.effectsFor(event)` for the events the process declares it emits.

## 9. Security, audit, assistant

- RLS by `company_id` on every table; role permissions per process (rule 13). Party scope of a role does not filter accounting lines: accounting is whole-company; a role that must not see suppliers' balances simply has no accounting consult permission (my call, §10).
- Field visibility: no field is `confidential` by default; the admin may mask `debit`/`credit`/`tax_base` for roles that only need the chart.
- Sensitive by default: every step-up process in §6; the admin may raise `entry.reverse`, `entry.post` for manual journals, `account.update`.
- Audit: every post records the input summary, the resulting number and totals; the engine's runs carry origin `event` and the chain id of the originating process, so the chain of order → invoice → entry is one query.
- Assistant: tools generated from §6 processes filtered by permissions; reports are consult tools with capped rows and masking; writes through confirmation cards; step-up ones ask for the TOTP in chat; the eval set gains Spanish prompts for the reports and for a manual entry.
- Metering: report consults do not call a model; explanations of "qué pasó" do, through the chat policy.

## 10. Calls I made (check these)

1. **Single book, PUC taxonomy.** One ledger per company on the PUC; `niif_group` is informational. Formato 2516 and the NIIF vs fiscal differences are produced from this single ledger plus a yearly reconciliation layer (§5.10); a second ledger dimension on `entry_lines` is only for grupo 1 dual reporting and is not planned. Confirmed by the owner 2026-10-28.
2. **Movement only at subcuenta or auxiliar level**, auxiliaries 8 digits or more, company-defined.
3. **Third party and the four analytic dimensions as account flags**, seeded by the pack (party on 13, 22, 23, 24, 25, 28; cost center on classes 4–7; auxiliar abierto, ítem and unidad de negocio off until the accountant turns them on per account). No default node; missing ones are posting failures.
4. **Seven default journals** (NC, VT, CP, RC, CE, AP, CI) with their own consecutivos assigned at post; drafts carry no number.
5. **Drafts are voided, never deleted** (rule 9 read strictly); posted entries are reversed.
6. **Closed-period documents never move.** Entries carry their document's own date; a document dated in a closed period fails until a user with the permission reopens the period, or just that day, under step-up and retries; balances of later periods follow automatically (§5.5, §5.7). Amended by the owner 2026-10-28 (my draft offered a post into the first open period; dropped).
7. **Rounding tolerance 1 COP to a `rounding` role** so tax rounding never blocks an invoice's posting.
8. **Period close refuses with drafts or pending failures** instead of closing around them; periods close in order; any closed period of an open year may be reopened, whole or for a single day (owner 2026-10-28).
9. **Year close goes through 5905 and lands on 3605 or 3610 by sign**; the move to 3705 / 3710 is a manual templated entry after the asamblea.
10. **The posting engine subscribes to every event** through the accounting module's `"*"` consumer and matches rules per company, so admins may add rules for any event without a code change.
11. **Rule template DSL** is declarative JSON with a JSONPath subset and `{{ }}` interpolation; no expressions beyond path, forEach and sign flip. Anything more is a module computing the figure into its payload.
12. **Dimensions on mappings** (`tax:`, `category:`, `party_kind:`, `payment_method:`) instead of account fields on products, categories or taxes, so core stays free of accounting columns; the mapping is editable both in Mapeo de cuentas and on the owning record through a `mapping` record tab (§8, owner decision 2026-10-28).
13. **Entry templates** for recurring manual entries are in scope (small, high daily value).
14. **Party scope does not filter the ledger.**
15. **Reports are consult processes over SQL** (`v_account_balances` and lines), rendered by DataGrid, drill-down by links; no pivot library needed in phase 2.
16. **Menu: five items with a Maestros group** (Plan de cuentas, Centros de costo, Auxiliares abiertos, Ítems, Unidades de negocio, Fuentes) as in §8, per the owner 2026-10-28, six since Movimientos (owner 2026-10-29, §10b.19); Pendientes de contabilizar inside Reglas contables with a badge plus a home widget, not a top-level item.
17. **Auxiliar abierto and Ítem as analytic dimensions** with the cost center's shape (`code`, `name`, `parent_id`, `kind` group / leaf, `is_active`), optional on any line, required per account flag, filters and breakdowns in reports; every hierarchical master has a Tabla · Árbol toggle. Owner 2026-10-28 (§10b.13). My calls around it: the `use_*` settings that hide an unused dimension, the per-account `requires_*` flags, `kind` replacing `allows_movement` on cost centers, and one shared report `dimension_detail` instead of one report per dimension.
18. **Exógena from the ledger through a concept mapping** (§4.13, §5.11): catalogue, thresholds and XML in the Colombia pack, mapping table and aggregation in accounting, errors block the export. Owner 2026-10-28 after the benchmark (§10b.14).
19. **Aging from the ledger** (`v_open_items`, FIFO per party until the payments module's allocations exist), one report for receivables and payables. Owner 2026-10-28 (§10b.14); the FIFO fallback is my call.
20. **Unidad de negocio as the fourth analytic dimension**, the only one with a header field on the comprobante that its lines inherit and may override; the engine stores the resolved value on every line at post so no report needs the header. Owner 2026-10-28 (§10b.15); storing the resolved value is my call.
21. **Five controls from the best-practice review** (§5.12): four-eyes on manual entries behind a setting, `reverse_on` accruals, subledger tie-out and suspense-zero at close recorded as sign-off rows, auditor extract. Owner 2026-10-28 (§10b.16).
22. **Security by account** (§4.15, §5.13): `access` open / restricted per account with inheritance, grants per role and per user for view and post, enforced in the SQL views so reports aggregate rather than hide money, records mask restricted lines, the engine is exempt. Owner 2026-10-28 (§10b.17).

## 10a. Decisions after the builder check (my calls, 2026-10-28)

1. **Kernel engine, module provider.** The engine stays in the kernel but reaches the ledger only through the `PostingProvider` interface of §5.1; rules, mappings, accounts and failures are `accounting` tables written by `accounting` processes. No kernel code names the module.
2. **Companies without accounting.** The `"*"` consumer is the accounting module's, so events are parked, not lost, while the module is disabled (design §5.12); the dispatcher stops re-claiming parked rows for disabled consumers (kernel task). Events dated before `ledger_starts_on` are acknowledged and counted, never posted: opening balances cover that history.
3. **No step-up where no human is.** `entry.post_from_event` and `posting_failure.record` carry `origins: ["event"]` and cannot be raised to step-up; `chart.seed` runs from the Configurar contabilidad action, not on enable; opening balances import as drafts and a human posts them under step-up.
4. **Journals count their own consecutivos** (`journals.next_number`, locked at post); `core.document_sequences` stays for documents with legal resolutions.
5. **Reports are kernel infrastructure built in this plan.** The kernel gains `ReportDef` (id, parameters schema, consult process, columns from a view or process output, totals) and the grid route accepts a report id as source, with exports over all pages and saved parameter sets per user and per role; rule 20 applies to report grids in full except import. The accounting reports are its first consumers. The phase 2 plan sizes this as its own tasks before the report tasks.
6. **Profit and loss** close through 5905 to 3605 or 3610 (§5.7).
7. **Withholdings suffered are recognised at collection** (`payments.received`), never at invoice issue, because the customer practises them when paying; the receivable is gross until then.
8. **Currency.** A template `amount` is in document currency; the engine converts with the header rate, rounds each line half-up to two decimals in company currency and balances the remainder through `rounding` within tolerance; a line may supply `amountCompany` to override the conversion.
9. **Tax codes encode concept and rate** (`tax_code` from the pack catalogue plus `tax_rate`), so formato 1001 and certificates read lines without guessing.
10. **No foreign keys across module schemas.** `party_id` is validated through `core.v_parties` in the process.
11. **Record-frame tabs and card effects are manifest contributions** (`recordTabs`, `effectsFor`), so the kernel shows accounting without knowing it.

## 10b. Owner decisions (2026-10-28)

The owner reviewed the twelve decisions of the presentation (`2026-10-28-accounting-module-design.html`). Recorded here and, where they change the main design, drafted for its §22.

1. **Revenue account per product category: deprecate `core.product_categories.income_account`, keep the field on the category UI.** The mapping lives only in `accounting.account_role_mappings` (`revenue`, `category:<uuid>`). `chart.seed` reads the core column once per company to create the mappings; the column is no longer written by `core.product_category.*` processes and is dropped in a later migration once every company has seeded (migrations are forward-only, rule 29). The category record shows **Cuenta de ingresos** in a Contabilidad tab contributed by the accounting manifest (§8, `kind: "mapping"`), so accountants map where they work; the global grid in Mapeo de cuentas edits the same row. Main design §5.18 changes: §22 entry drafted below.
2. **Step-up on processes run by event consumers: option A, decided by the owner 2026-10-28 after explanation.** Event-only processes carry `origins: ["event"]` and cannot be raised to step-up. The problem: rule 15 lets an admin mark any process as sensitive, and `runProcess` then demands a fresh TOTP whatever the origin. The posting engine runs `accounting.entry.post_from_event` with origin `event` and no human present (the invoice was issued minutes or hours before by someone else), so a process marked sensitive would fail on every automatic posting, and the same applies to `inventory.movement.post` run by the sale flow. Option A (chosen, this module only): processes that only run from events declare `origins: ["event"]`; the admin page shows them as not raisable with that reason; the human-facing `entry.post`, `period.close`, `posting_rule.*` stay raisable. Option B (platform): a process run with origin `event` is considered verified when the root process of its chain was verified, and the confirmation card of the root process asks for the TOTP upfront when any process in `effectsFor` is sensitive; needs a rule 15 amendment, a kernel task and a review of chain freshness. A is enough for phase 2 and does not preclude B later; B is not planned.
3. **C1 single ledger: confirmed**, with the owner's question answered in §5.10 (2516 and NIIF vs fiscal differences come from the single ledger plus a yearly reconciliation layer, no second book).
4. **C2 events dated in a closed period: amended.** A document's own date decides its period; references to older documents are irrelevant (a credit note of 2026-11-01 against an invoice of 2026-10-30 posts in November). A document dated in a closed period is a `closed_period` failure until a privileged user reopens the period, or the single day needed, under step-up and retries; later balances recompute automatically because they are aggregated, not stored (§5.5, §5.7). The automatic or one-click move into the first open period is removed.
5. **C3 withholdings at collection: confirmed.**
6. **C4 Configurar contabilidad button with TOTP: confirmed.**
7. **C5 ReportDef in the kernel now: confirmed.**
8. **C6 own consecutivo per journal: confirmed.**
9. **C7 menu: amended.** Plan de cuentas, Centros de costo and Fuentes (then called Diarios) under a **Maestros** group; `NavItem.children` is a kernel task (§8).
10. **C8 year close through 5905 then 3605 / 3610: confirmed.**
11. **C9 void drafts: confirmed.**
12. **C10 entry templates in phase 2: confirmed.**
13. **Two more analytic masters (owner comment on the prototype, 2026-10-28).** The owner asked for **Auxiliar abierto** and **Ítem**, "similar to centro de costo", with código, descripción, activo / inactivo and grupo / hoja, attachable to a journal entry line, and for every maestro to offer a table view and a tree view. Recorded in §4.5, §4.7, §6, §8; the prototype shows both masters, the two line columns, the report filters and the Tabla · Árbol toggle on the four hierarchical masters.
14. **Exógena concept mapping and aging pulled into phase 2 (owner 2026-10-28).** A benchmark of ten Colombian packages (Siigo, World Office, Alegra, Helisa, Contapyme, Loggro, Aliaddo, Odoo l10n_co, SAP B1, Softland) showed every one ships exógena with an account → concept mapping and cartera por edades, and the roadmap already lists exógena as a phase 2 exit criterion without designing it. The owner asked for both now: §4.13, §5.11, §6, §8, the prototype's Conceptos exógena tab and the two reports. The rest of the benchmark (certificados de retención, conciliación bancaria, activos fijos, libros oficiales completos, borradores de declaraciones, presupuesto y flujo de caja, diferencia en cambio, RADIAN, 2276 and PILA) stays in phases 3 and 4 as the roadmap has them; RADIAN is not in the roadmap yet and is left for the owner to place.
15. **Unidad de negocio (owner 2026-10-28, after the phone review).** A fourth master "code, description, group/leaf, active/inactive, tree and table view", assignable to comprobantes "at header and/or line". Recorded as the fourth analytic dimension in §4.5 with the header field on `entries` (§4.6) and the inherited line field (§4.7); menu, settings, flags, filters and the prototype follow the same pattern as the other three.
16. **Controls from the best-practice review (owner 2026-10-28).** A review against Fowler's accounting patterns, Helland on immutability, Kieso/Weygandt, Bragg's *Fast Close*, Horngren and Kaplan on allocations, IFRS for SMEs, IAS 1/10/21, COSO and ISA 240 found the design already at best practice on immutability, declarative posting rules, derived balances and continuous posting, and five control gaps worth closing in phase 2. The owner asked for the five (§5.12, §4.14) and sent the rest to the roadmap: posting window per role (2b); scheduled templates, FX revaluation, step-down allocations, deferral schedules, management chart mapping and XBRL export (3); prior-period error marker (later). Recorded in `docs/roadmap.md` the same day.
17. **Security by account (owner 2026-10-28).** "Add security by accounting account (view balance, post journal) at role and user level." Recorded as §4.15 and §5.13: restricted accounts with inherited grants for view and post, resolution user over role, enforcement in the published views and in `entry.*`, aggregation instead of hiding in reports, masking in records, a Seguridad tab on the account and a Cuentas tab on roles and users. Extends main design §6 (roles, field visibility): drafted in the §22 entry below. The prototype has a Ver como switch to review the masking as a restricted user.

18. **Journal master renamed to Fuente (owner 2026-10-28).** "Change the name of the master Diarios to Fuentes." Every user-facing label of `accounting.journal` is **Fuente / Fuentes** (menu item under Maestros, grid title, entry header field, grid columns, period Resumen, posting rules and templates, confirmation cards, messages, user guides); Libro diario keeps its name because it is the legal book, not the master. My call: the identifiers stay English and unchanged (`accounting.journal`, table `journals`, route `/accounting/journals`, processes `accounting.journal.*`, i18n key `accounting.journal` with es-419 "Fuente" and en "Journal"), so nothing in the kernel or the posting engine depends on the Spanish word.

19. **Consulta de movimientos (owner 2026-10-29).** "Add Consulta de Movimiento: a page for querying ledger lines in general, able to filter by all the fields associated to a comprobante's line, including analytic variables (centro de costo, ítem, auxiliar abierto). Allow multi-sort, multi-filter and multi-aggregate." Recorded as §4.16 (the `accounting.ledger_line` query entity over `v_ledger_lines`), §5.14 (behaviour) and §8 (page Movimientos). My calls: it is a top-level bar item between Comprobantes and Maestros (six items; the bar still fits a 1280 px laptop in the prototype) rather than a card under Informes, because it is a working tool, not a statement; it rides on the phase 1 DataGrid and `GridState`, extended with `groupBy: string[]` (max 3) and per-group aggregates in the kernel query builder, instead of a bespoke page, so saved views, exports, RLS and account security come for free; drafts are included only on request; it is not a report in the §6 catalogue.

Entry applied to the main design §22 as item 17 on 2026-10-29, when the owner approved this document (the text below is the applied wording, extended with the Fuente rename of §10b.18 and the Movimientos page of §10b.19):

> 17. **Accounting module (2026-10-29)**: see `2026-10-28-accounting-module-design.md`. `core.product_categories.income_account` (§5.18) is deprecated: the revenue account of a category is an accounting role mapping (`revenue`, dimension `category:<id>`) edited from Contabilidad → Mapeo de cuentas and from a Contabilidad tab on the category record contributed by the accounting manifest; the core column is read once by the chart seed and dropped later. Entries keep their document's own date; a document dated in a closed period waits until a privileged user reopens the period or that day (step-up); entries are never moved to another period. Masters of a module may be grouped in the items bar (`NavItem.children`). Formato 2516 is produced from the single PUC ledger plus a yearly reconciliation layer, not a second ledger. Accounting lines carry four optional analytic dimensions, centro de costo, auxiliar abierto, ítem and unidad de negocio (the last also on the comprobante header, inherited by its lines), each a group / leaf tree with its own master; hierarchical masters offer table and tree views. Información exógena is produced from the ledger through an account → concept mapping, with the catalogue, thresholds and XML writer in the Colombia pack; cartera y cuentas por pagar por edades read open items computed from the ledger until the payments module's allocations exist. Manual entries may require a second person to post them (four-eyes setting), accruals may carry a reversal date that creates the mirrored draft, and a period closes only after the control accounts tie to their subledgers and the suspense role is at zero, each check recorded as a sign-off. Permissions extend to the account level (§6 of this design): an account may be restricted so that only granted roles and users see its balances or post to it; the published views enforce it, reports aggregate what a user may not see into one line, and records mask those lines. The journal master is called **Fuente** in every UI (identifiers stay `journal`). A **Movimientos** page queries ledger lines through a read-only `accounting.ledger_line` entity with multi-filter, multi-sort and grouped aggregates; for it `GridState.groupBy` becomes an ordered array of up to three fields with per-group aggregates in the kernel query builder, available to every grid.

## 11. Left to the builder (phase 2 plan)

- Exact DDL, Zod schemas, indexes, the `v_*` masked views and RLS policies per table; triggers maintaining `total_debit/total_credit`, `period_id`, `parent_id`, `level`; `reopened_for` enforcement in `entry.post`.
- Kernel: `NavItem.children` rendered as a dropdown group in the items bar; `recordTabs` with `kind: "mapping"` (account lookup bound to a dimension, saving through `account_role_mapping.update`); the deprecation path of `core.product_categories.income_account` (stop writing, seed reads once, drop later).
- JSONPath subset parser and the template Zod schema, with property tests on balance and idempotency.
- `v_ledger_lines` (§4.16) and the `accounting.ledger_line` query entity in the registry; kernel: `GridState.groupBy` as an ordered array of up to three fields, `groupAggregateSql` with `group by rollup` sharing the where clause, several aggregate functions per column; DataGrid: shift-click multi-sort with level badges, Agrupar por and Agregados controls, collapsible group rows with subtotals, group path in PDF / Excel / CSV; the Movimientos page (§5.14) with its defaults and the "Ver líneas" drill from a group row.
- `can_view_account` / `can_post_account` as `security definer` SQL functions with the role lookup cached per request; the aggregated "Cuentas restringidas" row in the four statement reports; masking of restricted lines in `v_entry_lines`.
- Pack `co`: `exogenaFormats(year)` catalogue (formats, versions, concepts, columns, thresholds, cuantías-menores NIT), `defaultConceptMappings()`, the XML writer with fixtures from the DIAN prevalidador; `v_open_items` with the FIFO function and its swap to the payments module's allocations.
- The tree component and the Tabla · Árbol toggle shared by Plan de cuentas, Centros de costo, Auxiliares abiertos, Ítems and Unidades de negocio (reuse the DataGrid for the table view and the right pane); one analytic master page parameterised by entity.
- The lines grid editor of the Comprobante record (keyboard-first: Enter adds a line, Tab across account → party → cost center → auxiliar abierto → ítem → unidad de negocio → debit → credit; the last three columns only when their `use_*` setting is on; the unidad de negocio cell shows the header value greyed until overridden).
- PDF layout of libro diario and mayor y balances with the libro header.
- i18n keys (`entity.accounting.*`, `field.accounting.*`, `nav.accounting.*`, `report.accounting.*`) in es-419 and en.
- User guides in `docs/user-guide/es-419/contabilidad/`: `plan-de-cuentas.md`, `comprobantes.md`, `centros-de-costo.md`, `auxiliares-abiertos-e-items.md`, `unidades-de-negocio.md`, `consulta-de-movimientos.md`, `controles-y-cierre.md`, `seguridad-por-cuenta.md`, `exogena.md`, `cartera-por-edades.md`, `periodos-y-cierre.md`, `reglas-contables.md`, `informes.md`, `pendientes-de-contabilizar.md`.
- Review focus for the plan: one event → one entry under redelivery; rollback of audit and outbox when `entry.post` fails; a closed-period post refused from UI, assistant, import and engine, and accepted only on `reopened_for` when a single day was reopened; a credit note dated in an open period against an older invoice posts without touching the old period; reversal links and status; mapping resolution order with dimensions; analytic dimensions accepted only on active leaves and required where the account flag says so, from UI, assistant, import and engine; a line without unidad de negocio takes the header's at post and the stored value never changes afterwards; with four-eyes on, the creator cannot post their own manual entry from UI, assistant or import while a second user can, and automatic postings are unaffected; a `reverse_on` entry always leaves exactly one auto-reversal draft, idempotent under retry; `period.close` refuses on any failed control check and records every check it ran; a user without view on a restricted account gets the aggregated line in every statement, no row in any line report or export, masked lines in records and no option in lookups, from grid, assistant, export and API alike, while totals stay equal to the admin's; a forbidden account on a line is refused by name from UI, template, import and assistant, and the engine's postings are unaffected; report filters and the dimension report equal to the ledger for the same node including descendants; rounding line only within tolerance; period close refusal lists; year close zeroes classes 4–7 and reopens cleanly; report totals equal to the ledger for the same filters; exógena per-party totals equal the mapped accounts' movement and the XML refuses while errors exist; aging totals per party equal the account's balance for that party at `as_of`; tenant isolation on `v_account_balances`, `v_open_items` and `v_ledger_lines`; on Movimientos, every group subtotal equals the sum of its visible lines and the grand total equals the filter's total from grid, export and `data.query` alike, a restricted account contributes no line and no amount to any group for a user without view, and a query with three group levels, five sort levels and mixed and / or conditions returns the same rows as the equivalent SQL on the view.
