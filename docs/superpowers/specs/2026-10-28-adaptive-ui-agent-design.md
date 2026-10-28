# Adaptive UI agent: per-user usage evidence → suggested views (design)

**Status:** approved by the owner on 2026-10-28 (including §4.9 productivity report); builder check done (five questions, all settled in §5a). To be planned with phase 3. **Phase:** 3 (needs the background-agent runtime of §7.2 of the main design and the scheduler). **Owner decision:** this is a phase 3 feature entirely; nothing of it ships in phases 1–2.

Companion to `2026-10-26-erp-ia-design.md` (main design). Uses its kernel: entity registry (§5.3), processes (§5.4), field permissions (§6), recommendations inbox and background agents (§7.2), saved views and grids (§9), form layouts (§10), audit (§5.9), user prefs (`kernel.user_prefs`, see §19a and phase 1 plan Task 20).

## 1. Intent

Every user works the app differently: a cashier opens the same three screens all day, a seller always filters terceros by HORECA and sorts by saldo, a buyer opens a product, jumps to its supplier, then creates a ticket. The app should notice that, and when it has **sufficient and significant evidence** that a different screen would make that person's day-to-day work faster, it should **propose** that screen, let them **try** it, and **activate it only when they accept**. Nothing changes under anyone's feet, nobody is told "the app is studying you", and the admin can turn a good personal view into the role's default.

Owner's words: "as soon as the subsystem has sufficient and significant evidence to determine a new suggested UX will make day to day work of that user more productive and efficient"; "the UI will be suggested, offered to use to test, only activated when the user accepts"; "the agent is allowed to propose things that change what data the user sees"; "the admin can promote it to the whole role"; "users can ask for this directly".

## 2. Goals, non-goals, anti-goals

**Goals**
- Capture how each user uses the app with enough detail to detect repeated patterns and estimate time saved.
- Produce proposals that are real, usable artifacts built from the app's existing building blocks (saved views, home layouts, form layouts, action chains, shortcuts), never free-form UI.
- Try before accept, accept per user, measure after accept, revert if it did not help.
- Let a user ask for a proposal on demand through the assistant.
- Let the admin see aggregated adoption and promote an accepted artifact to a role.
- Report the productivity gained per business process and globally (time per completed process before vs after suggested UIs), §4.9.

**Non-goals**
- No page where the user sees what the app has learned about them (owner decision). The evidence appears only inside a proposal, summarized.
- No automatic activation, ever. No A/B experiments run on users without their accept.
- No generation of new React components or code; proposals are data interpreted by existing renderers.
- Not a replacement for the role-based defaults the admin configures; it layers on top.

**Anti-goals (would make it a failure even if it works)**
- A proposal that is wrong or trivial ("agrega la columna Estado") and erodes trust. Thresholds and the "projected saving must be stated" rule exist for this.
- The user feeling watched: per-user navigation detail is never shown to anyone, including admins; retention is short; the whole subsystem can be disabled per role and per user.
- A view that leaks data the role cannot see. Proposals are built inside `field_permissions` and `party_scope`; the renderer re-applies them anyway.
- The UI changing without consent, including after promotion: promotion offers, it does not replace.

## 3. Constraints
- Same stack and kernel rules as the main design: every state change through `runProcess`, RLS on every table, audit with origin `agent` for anything the agent does, Workflow for the background runs, AI SDK with the model policy (classification/summaries on Haiku, proposal composition on the planning model), cost metered against the company's AI allowance (§7.4 of the main design).
- Proposals must be expressible in the existing artifact schemas: `kernel.saved_views.state` (GridState with filters, sort, columns, groupBy, page size, advanced conditions), `kernel.user_prefs.home_layout` (dashboard widgets), `form_layouts` (§10 of the main design, extended to built-in entities per §5a.1: collapsing and reordering sections and fields of the record frame, never hiding required or fiscal fields), `kernel.shortcuts` (new, see §5.4), `kernel.action_chains` (new, see §5.4).
- Evidence is per user per company; a user with two companies has two evidence streams.
- Spanish copy throughout; all strings through `packages/i18n`.

## 4. How it works

### 4.1 Usage events (`kernel.ui_events`)
The web app emits structured events from the shell, the record frame, grids and the assistant: `screen_open(route, tab)`, `tab_switch`, `grid_state(entity, state_hash, columns_visible, filters, sort, page_size)`, `grid_column_scroll(entity, columns_seen)`, `record_open(entity, id, from)`, `record_tab(entity, tab)`, `field_focus(entity, field)`, `field_left_blank(entity, field)` (on save), `action(process_id, origin, duration_ms)`, `search(entity, query_len, picked_from: dropdown|advanced)`, `export(entity, format)`, `assistant_ask(intent)`. Each row: `company_id, user_id, session_id, ts, kind, entity?, route?, payload jsonb, duration_ms?`. No free text from the user is stored (queries are stored as length and hashed tokens, never the text). Batched from the client every 10 s or 50 events through `kernel.ui_event.ingest` (a `telemetry`-kind process, §5a.2: no audit row, never blocks UI), inserted with RLS by `company_id` and a policy that lets a user insert only their own rows and **nobody read raw rows through the API**; only the Workflow runner (service role) reads them.

Retention: raw events 60 days (my call), then deleted by a nightly job; only `kernel.usage_patterns` (aggregates, no timestamps per click) survive.

Opt-out: `kernel.company_modules` feature flag `adaptive_ui` (plan entitlement), `kernel.roles.adaptive_ui bool default true`, `kernel.user_prefs.adaptive_ui bool default true` (the user can switch it off in Perfil › Preferencias; when off, no events are captured, not just no proposals).

### 4.2 Pattern detection (statistics first, LLM second)
A Workflow `adaptiveUiScan` runs nightly per company (and on demand, §4.6). For each user with ≥ 5 active days in the window (my call) it computes `kernel.usage_patterns(user_id, kind, key, occurrences, distinct_days, est_seconds_per_occurrence, est_seconds_saved_per_day, first_seen, last_seen, evidence jsonb)` for these pattern kinds, all computed with plain SQL/TypeScript, no model involved:

| Kind | Evidence | Candidate proposal |
|---|---|---|
| `repeated_grid_state` | same entity + same filter/sort/column set ≥ N times on ≥ M days, re-applied by hand each time (no saved view used) | saved view with that state, pinned to the module bar |
| `unused_columns` | columns never scrolled into view or never sorted/filtered in ≥ 90 % of grid sessions | saved view hiding them (changes what data they see: allowed) |
| `always_blank_fields` | optional fields left blank in ≥ 95 % of saves, ≥ N saves | form layout that collapses those sections/fields behind "Más campos" |
| `always_filled_order` | the user fills fields in a consistent order different from the layout | form layout reordered |
| `action_chain` | sequence of 2–4 actions across records repeated ≥ N times (open tercero → Contactos → new ticket) | one-click chain: a `kernel.action_chains` row that the record frame shows as a button and the assistant as a tool |
| `home_mismatch` | the user leaves Inicio within 3 s in ≥ 80 % of sessions and goes to the same screen | home layout with that screen's grid as the first widget, or "open on X" preference |
| `search_friction` | advanced filter popup used ≥ N times with the same conditions | saved view, or a ⌘K shortcut with those conditions |
| `export_ritual` | same export (entity, state, format) on a schedule-like cadence | a scheduled export / report (uses the phase 3 scheduler) |

**Sufficient and significant** (my call, tunable per company in `kernel.adaptive_ui_settings`): `occurrences ≥ 8`, `distinct_days ≥ 4`, `est_seconds_saved_per_day ≥ 60`, and the pattern still observed in the last 7 days. Estimates use measured durations (`duration_ms` between events) and a fixed cost model (a click 1.5 s, a filter set 6 s, a form section scroll 2 s) stored in settings so finance can be shown "unos 7 minutos al día".

### 4.3 Proposal composition
For each pattern over threshold without an existing proposal (or dismissed in the last 90 days), the Workflow asks the planning model to **compose** the artifact and its explanation, with these guardrails:
- Input: the pattern evidence, the entity's registry metadata filtered by the user's field permissions and party scope, the artifact JSON schema, and the user's existing saved views/layouts (to avoid duplicates).
- Output (structured, validated with Zod before storage): `{ artifact_kind, artifact: <schema>, title ≤ 60 chars, rationale ≤ 300 chars in plain Spanish naming the evidence and the saving, confidence 0–1 }`.
- Validation rejects any artifact referencing a field, process or entity the user cannot see or run, any form layout that hides a required field, and any proposal whose rationale does not state a saving. Rejected compositions are logged (`kernel.llm_usage`) and not shown.
- The model never sees raw events or free text, only the aggregate pattern.

Stored as a normal recommendation (§7.2 of the main design) with `source = 'adaptive_ui'`, `artifact_kind`, `artifact`, `pattern_ids[]` (§5a.3), `status ∈ proposed | trying | accepted | dismissed | reverted | promoted`. At most **2 open proposals per user** at a time (my call), the highest estimated saving first.

### 4.4 Try, accept, measure, revert
The proposal is a recommendation card on Inicio and in the assistant: title, rationale ("Aplicas el mismo filtro de clientes HORECA por saldo 3 veces al día desde hace 2 semanas; esta vista lo deja listo y oculta 6 columnas que no usas. Ahorro estimado: 7 min/día."), and buttons **Probar**, **Aceptar**, **Descartar**.
- **Probar**: opens the artifact as a temporary tab labelled "Prueba · <título>" (saved views and shortcuts), or renders the record frame with the proposed layout marked "Prueba" (form layouts), or shows the proposed home next to a "Volver a mi inicio" button. The original is untouched. Trying can last any number of sessions; the card stays with "En prueba desde el 3 de mar".
- **Aceptar**: process `kernel.adaptive_ui.accept` writes the artifact into its normal home (`kernel.saved_views` as the user's default for that entity, `kernel.user_prefs.home_layout`, `form_layouts` user override, `kernel.shortcuts`, `kernel.action_chains`), audited, origin `ui`, with `recommendation_id` as the causal link.
- **Descartar**: status `dismissed`, feedback optional ("no me sirve", "está mal", "ya lo tengo"); the same pattern is not proposed again for 90 days; the feedback text goes into the composition prompt next time (as in §7.2 of the main design).
- **Measure**: for 14 days after accept, the scan compares the pattern's cost before and after (same cost model). If the saving is < 25 % of the estimate, the agent proposes **reverting** with the numbers ("la vista no ahorró lo esperado"); reverting restores the previous artifact kept in `recommendations.previous_artifact`. Nothing reverts automatically.

### 4.5 Promotion to a role (admin)
Administración › Vistas sugeridas shows, per role, accepted artifacts grouped by similarity (same entity + same artifact kind + ≥ 80 % overlap of filters/columns): "Vista 'Clientes HORECA por cobrar' aceptada por 3 de 5 vendedores · ahorro estimado 25 min/semana cada uno". No per-user navigation detail anywhere in admin. Actions:
- **Promover como predeterminada del rol** (`core.admin.view.promote`, step-up by default): the artifact becomes the role default for new users; existing users of the role get a card "Tu rol ahora tiene la vista X, ¿la adoptas?" and keep their own choice until they accept.
- **Publicar en la lista del rol**: available in the entity's "Vistas" menu for everyone in the role, not default.
- **Retirar** a promoted artifact (users who adopted it keep a personal copy).

### 4.6 On demand
The user can ask the assistant: "optimízame la pantalla de terceros", "hazme una vista para lo que hago cada mañana", "¿qué me propones para ir más rápido?". The assistant calls `kernel.adaptive_ui.propose_now(entity?)`, which runs the scan for that user only, over the same evidence and thresholds **relaxed** (occurrences ≥ 3, no minimum saving), and returns proposals as the same cards inside the chat. If evidence is insufficient it says so in one line and offers to build a view from what the user describes instead (that path is the normal `saved_views.create` through the assistant, not this subsystem).

### 4.9 Productivity report (owner request, 2026-10-28)
A standard report, **Productividad por interfaz sugerida**, shows how much faster business processes run since suggested UIs were adopted, per process and globally.

- **Metric**: time per completed business process, measured from the usage events as the span from the first screen or form open that belongs to the process until the process call succeeds (`action(process_id)` with `duration_ms`), for example `sales.invoice.create`, `core.party.create`, `purchases.order.create`, `support.ticket.create`. Each registered process declares its `screens[]` so the span is unambiguous; abandoned attempts are counted separately and not in the average.
- **Aggregation** that survives the 60-day raw retention: `kernel.process_metrics_daily(company_id, process_id, role_id, date, completions, abandoned, avg_seconds, p50_seconds, p90_seconds, with_suggested_ui bool)` written by the nightly scan, no `user_id` (so the report never exposes a person). `with_suggested_ui` is true when the completing user had an accepted or adopted artifact that touches one of the process's screens at that moment.
- **Baseline and comparison**: the baseline period is the time before the first accepted artifact touched the process (or a period the admin chooses); the comparison period is from that date on. Productivity gain follows the owner's definition, **time reduction**: `gain = (baseline_avg − current_avg) / baseline_avg`. Throughput (`completions per active user per day`) is shown as a secondary column.
- **Detail rows, one per process**, rendered from a template, not by the model: "Hasta diciembre de 2026 los usuarios tardaban en promedio 5 min en crear una factura; desde enero de 2027 tardan 2 min: productividad +60 %." Columns: proceso, periodo base, tiempo base, periodo actual, tiempo actual, ganancia %, completados, usuarios con UI sugerida / sin ella (control group: the same process by users who have no suggested UI, so the admin can see whether the gain comes from the suggestion or from practice), minutos ahorrados por día.
- **Global row**: weighted by completions across all processes: total minutes saved per day and per month, overall gain %, number of artifacts accepted and promoted, share of users with at least one accepted artifact. Example: "Globalmente la empresa ahorra 3 h 20 min al día; la productividad en los procesos cubiertos subió 38 %."
- **Where**: Administración › Vistas sugeridas › Productividad, and in the reports module as a built-in report (so it inherits grid, filters by period, role and process, and PDF / Excel / CSV export, §9 of the main design). The assistant answers "¿cuánto hemos ganado con las vistas sugeridas?" from the same aggregates. Each user sees only the global and per-process rows, never per-person figures; the admin sees the same plus the role breakdown.
- **Honesty rules**: a process with fewer than 20 completions in either period shows "datos insuficientes" instead of a percentage; the report states the measurement method in a footnote; gains are recomputed from the daily aggregates, never stored as a final number.

### 4.7 Data model summary (new tables, schema `kernel`)
- `ui_events` (§4.1), `usage_patterns` (§4.2), `adaptive_ui_settings(company_id, thresholds jsonb, cost_model jsonb, retention_days)`, `process_metrics_daily` (§4.9, kept indefinitely, no user id); processes declare `screens[]` in the registry.
- `recommendations` gains `source, artifact_kind, artifact jsonb, pattern_ids uuid[], previous_artifact jsonb, tried_at, accepted_at, measured_saving_seconds_per_day`.
- `role_artifacts` (§5a.4) for promoted and published artifacts; `form_layouts` extended to built-in entities (§5a.1).
- `shortcuts(id, company_id, user_id|role_id, label, kind: open_view|open_record|run_process, payload jsonb)` surfaced in ⌘K and the module bar.
- `action_chains(id, company_id, user_id|role_id, label, entity, steps jsonb[])` where each step is a registered process or a navigation; executed through the normal pipeline step by step with the usual confirmations.
- Processes: `kernel.ui_event.ingest` (consult), `kernel.adaptive_ui.scan` (system, Workflow), `kernel.adaptive_ui.try`, `.accept`, `.dismiss`, `.revert`, `.propose_now`, `core.admin.view.promote`, `.publish`, `.withdraw`, `kernel.user_prefs.set` (`adaptive_ui` flag).

### 4.8 Security and privacy
- Raw events readable only by the service role inside the Workflow; the `ui_events` table has no SELECT policy for users or admins.
- Everything the model receives is aggregate; prompts and outputs logged in `kernel.llm_usage` with the pattern id, not the events.
- All artifacts pass through the same masking and permission layer at render time, so a stale proposal cannot show more than the role allows today.
- Disabling the feature (company, role or user) stops capture immediately and deletes that scope's raw events within 24 h.
- Audit: every try/accept/dismiss/revert/promote is a process call with origin and causal id.

## 5. UX surface (what the user sees)
- Recommendation card on Inicio and in the assistant with Probar / Aceptar / Descartar and the rationale. Badge "Sugerencia de la app" to distinguish it from business recommendations.
- Temporary tab "Prueba · …" with a bar: "Estás probando una vista sugerida · Aceptar · Volver".
- Perfil › Preferencias: "Sugerencias de pantalla personalizadas" on/off.
- Administración › Vistas sugeridas (adoption, promote, publish, withdraw), the thresholds/cost model editor for the company, and the **Productividad** report (§4.9), also listed among the built-in reports.
- Assistant intents: "optimízame…", "¿qué me propones…?", "quita la vista sugerida".

## 5a. Decisions after the builder check (my calls, 2026-10-28)
1. **Per-user form layouts for built-in entities are a prerequisite delivered inside this feature.** The record frame's Datos tab becomes layout-driven: a `form_layouts` document per entity (sections → fields, with `collapsed` and `order`) that the renderer reads with precedence user override → role → module default. Fields that are required at save time, that count toward `dian_missing` / `invoice_ready` (§5.17 of the main design), or that are `required` custom fields can be reordered but **never collapsed or hidden**; the validator in §4.3 enforces it and the rationale must state "no oculta datos necesarios para facturar". The first cut may ship the other pattern kinds before the form-layout renderer lands; `always_blank_fields` and `always_filled_order` wait for it.
2. **Telemetry is the one audited-process exception.** `defineProcess` gains `kind: "telemetry"` with `audit: "none"`: still permissioned, still RLS, still through `runProcess`, but it writes no `audit_log` row and its input is never stored outside its own table. Only `kernel.ui_event.ingest` uses it. `kernel.adaptive_ui.scan` is a normal system process with `audit: "summary"` (counts per pattern kind, no per-user evidence in the audit row). Both options are documented in the kernel as the only two deviations from full audit.
3. **One proposal combines every over-threshold pattern of the same user, entity and artifact kind.** `recommendations.pattern_ids uuid[]` replaces `pattern_id`; the saving threshold applies to the combined estimate (so `unused_columns` rides along with `repeated_grid_state`); the 2-open-proposals cap, the 90-day cool-down and the 14-day measurement are per proposal, and a dismissed proposal cools down all its patterns.
4. **Role-scoped artifacts live in `kernel.role_artifacts(id, company_id, role_id, kind, entity?, artifact jsonb, is_default bool, published bool, promoted_from uuid?)`.** Personal tables stay as phase 1 defines them. Renderers resolve user artifact → role default → module default. "Adoptar" on the promotion card copies the role artifact into the user's personal table (so "Retirar" leaves personal copies intact), with `promoted_from` as the causal link.
5. See decision 1 for DIAN-required fields: excluded from collapsing, and the proposal's rationale shows the `invoice_ready` impact when any field it touches is fiscal.

## 6. Left to the builder
- Exact event batching and offline buffering in the web client; SQL for pattern computation (window functions over `ui_events`), and how to hash grid states.
- The composition prompt wording and the Zod schemas per artifact kind.
- The similarity measure for grouping artifacts in admin (§4.5) beyond the 80 % overlap rule.
- Whether `action_chains` get their own renderer in the record frame or reuse the assistant's confirmation card; both are acceptable.
- Evaluation set: synthetic event streams for each pattern kind with the expected proposal, run in CI.

## 7. Calls I made (check these)
- Retention 60 days raw, aggregates kept; thresholds 8 occurrences / 4 days / 60 s per day / seen in the last 7 days; at most 2 open proposals per user; 14-day measurement window; 90-day cool-down after dismiss; on-demand thresholds relaxed to 3 occurrences.
- Statistics detect, the model only composes and explains; the model never sees raw events.
- Proposals are limited to five artifact kinds (saved view, home layout, form layout, shortcut, action chain) plus scheduled exports.
- Promotion offers to existing users and defaults for new ones; it never replaces a personal choice.
- Capture is off when the user turns the feature off (not only proposals).
