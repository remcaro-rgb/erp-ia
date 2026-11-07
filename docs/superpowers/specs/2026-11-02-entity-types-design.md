# ERP-IA · Entity types (Maestro / Documento) · design

Status: decisions taken by the owner on 2026-11-02 (§10): D1–D7 and D9–D12 as proposed, D8 and the approver rule amended, import/export added (§2.5); D13–D14 added during the build. Recorded in the main design §22.23. Next: the phase plan.

Read with: `docs/project-rules.md` (all 37 rules), main design §5 (kernel), §6 (security), §11 (documents and templates), §13 (messaging), §15 (data conventions), §19a (UI), §22.

## 1. Intent

Every business entity in ERP-IA behaves in one of two predictable ways, so users learn one set of screens and buttons and every module built after this (sales and invoicing in 2B, purchases in 3) inherits approvals, history, printing, e-mail and access control instead of re-inventing them per screen. Today each screen does this by hand: accounting entries have their own states and buttons (`EntryStatusBar`), masters have a `status active/inactive` column, there is no print, no e-mail, no per-record access and no document history beyond field diffs.

Success: a new module declares an entity as `maestro` or `documento` and gets, with no extra code, the lifecycle, buttons, import and export, "Datos adicionales" tab, snapshots, PDF printing with admin templates, state e-mails, record-level access and its place in the module menu. `check:rules` refuses an entity that does not declare a type.

## 2. Goals (owner's rules, 2026-11-01/02)

### 2.1 Every entity has a type
Each table entity is `maestro` or `documento`. Read-only query entities (`kind: "query"`) stay as they are and carry no type. Table entities that are neither declare a role without lifecycle (D13): `lines` (rows of a parent maestro or documento, declared by the parent's `typed.lines`; imported and exported with the parent), `parametro` (configuration, listed under Parámetros) or `sistema` (logs, users and other system records).

### 2.2 Maestro
Master data used by documents (parties, products, accounts, cost centres…).
- CRUD.
- Mandatory fields: Activo (sí/no), fecha de creación, fecha de última modificación, usuario que creó, usuario que modificó.
- Boolean `requiere_aprobacion`: when true the maestro needs approval by other user(s) before documents may use it.
- States: Borrador, Grabado, Pendiente de Aprobación (only if `requiere_aprobacion`), No Aprobado, Aprobado.
- Optional record-level access: read, use, modify, delete, granted to roles and/or users (e.g. only role X or user Y may see a given client, and may not use it on documents).
- Optional "Datos adicionales".
- A list report with a PDF template, and a single-record PDF template; both admin-definable (§6).
- Buttons: Grabar, Eliminar, Nuevo, Imprimir.

### 2.3 Documento
Real business documents: invoices, purchase orders, comprobantes, purchase requests, goods receipts…
- Booleans `contabiliza` (generates an automatic comprobante) and `requiere_aprobacion` (valid only after approval by other user(s); the comprobante is generated only after approval).
- States: Borrador, Grabado, Pendiente de Aprobación (only if `requiere_aprobacion`), No Aprobado, Aprobado, Contabilizado (only if `contabiliza`), Anulado.
- Each state has a notification list of e-mail addresses notified when a document reaches it.
- Any data change once the document is past Borrador saves a snapshot of the whole document.
- Optional record-level access: read, modify, void, granted to roles and/or users.
- Optional "Datos adicionales".
- A list report with a PDF template, and a single-document PDF template; both admin-definable.
- Buttons: Grabar, Eliminar, Nuevo, Imprimir, Anular (by state), Aprobar and No Aprobar (by state and user), Notificar (e-mails the document's PDF).

### 2.4 Module menu
Every module has at least these level-1 menu items: Maestros, Documentos, Reportes, Parámetros. Every menu item, at any level, may be restricted by role and/or user.

### 2.5 Import and export (owner 2026-11-02)
Every maestro and documento has import and export. Export: the grid's existing CSV / XLSX / PDF exports (`packages/kernel/src/exports/`), respecting field visibility and record-level access. Import: the phase 1 importer (`packages/ui/src/import/ImportDialog.tsx`, `apps/web/src/app/(app)/import/`), extended to documentos with header + lines; every imported row runs through the entity's create process via `runProcess`, with the same validation, readiness, access and lifecycle rules as the screen. `check:rules` fails a typed entity without both. A maestro declares a natural import key; a documento has none before it is numbered and imports header + lines joined by a file `ref` column (D14).

## 3. Non-goals
- No visual drag-and-drop PDF designer and no AI conversion of a sample PDF into a template in this work (see §6 and decision D4).
- No workflow designer for custom states or multi-level approval chains; the state set is fixed.
- No change to fiscal documents' legal content: DIAN invoice XML/PDF rules stay in `packages/localization/co` (rule 5).
- Not the general messaging centre of design §13 (inbox, WhatsApp, realtime notifications); only state e-mails and Notificar.

## 4. Anti-goals (failure even if it works)
- A hidden button or menu item being the only guard: every restriction is also enforced in RLS or in `runProcess`.
- Any state change or access-rule change that bypasses `runProcess`, the audit log or the outbox (rules 1, 3, 16).
- Hard-deleting a document that has been numbered or seen by anyone (rule 9).
- Snapshots or access rules that can be edited or deleted after the fact.
- The kernel learning module names (rule 4).

## 5. Lifecycle

### 5.1 State codes
| Label (es-419) | code | Maestro | Documento |
|---|---|---|---|
| Borrador | `draft` | yes | yes |
| Grabado | `saved` | yes | yes |
| Pendiente de Aprobación | `pending` | if requiere_aprobacion | if requiere_aprobacion |
| No Aprobado | `rejected` | if requiere_aprobacion | if requiere_aprobacion |
| Aprobado | `approved` | if requiere_aprobacion | if requiere_aprobacion |
| Contabilizado | `posted` | — | if contabiliza |
| Anulado | `voided` | — | yes |

Accounting's existing `reversed` stays as an accounting-only mark on a `posted` entry, shown "Contabilizado · Revertido" (decision D2; label owner 2026-11-02, prototype review).

### 5.2 Transitions (Documento)
- `draft → saved` (Grabar; validates and assigns the document number).
- `saved → saved` (Grabar again; edits allowed, snapshot).
- `saved → pending` (Enviar a aprobación) when requiere_aprobacion; otherwise, when contabiliza, the document posts automatically on Grabar (`draft → saved → posted` in the same run). Posting has two modes, a per-company setting (`accounting.settings.posting_mode`, changed only by `accounting.posting_mode.set` with step-up; owner 2026-11-06, Task 33). **In inline strict mode (the default)** posting is mandatory and part of the same transaction as the action that triggers it (owner 2026-11-02): if the document cannot be posted (closed period, unbalanced, non-ready party…), the whole action is rolled back and refused with the reason; the document keeps the state and data it had before the action (Grabar on a Borrador → stays Borrador, the user's unsaved edits remain in the form; Aprobar on a Pendiente de Aprobación → stays Pendiente de Aprobación until the cause is fixed). No number is consumed and no snapshot or e-mail is produced; without contabiliza it stays `saved` as valid. **In asynchronous mode** the action commits the document and its event without composing the entry (two preconditions stay checked at the action: the ledger has started and, when the document requires one, an active posting rule applies); accounting's consumer then posts the entry and a refusal (mapping, closed period, party, balance) becomes a retryable row of Pendientes de contabilizar instead of rolling the document back. The risk is the owner's to accept: an invoice issued and accepted by the DIAN can exist without its accounting entry until the retry succeeds, and the accounting reports leave it out meanwhile; the document's record says «Pendiente de contabilizar» (or «Contabilización fallida · ver pendientes») until the entry exists. Switching modes rewrites nothing: entries already posted stay and queued events are posted under either mode.
- `pending → approved` (Aprobar) / `pending → rejected` (No Aprobar, reason required). Any user holding the process permission `<doc>.approve` may approve, including the creator and the last editor (owner 2026-11-02).
- `rejected → saved` (edit and Grabar) then resubmit.
- `approved → posted` automatically when contabiliza: in inline strict mode (the default) in the same transaction through the posting seam, so the entry exists when the action returns; in asynchronous mode by the outbox event consumed by accounting (rule 3), with the entry following the action by the consumer's run.
- `draft → (deleted)`: Eliminar only in Borrador (decision D1).
- `saved | pending | rejected | approved → voided` (Anular, reason required). `posted → voided` only through accounting reversal (the comprobante is reversed, then the document is voided) — decision D3.

Maestro: same without `posted`/`voided`; Eliminar allowed in any state if the record is not referenced, otherwise refused with the hint to set Activo = no. A maestro is usable on documents when `is_active` and (state `approved`, or state `saved` when requiere_aprobacion is false). The check reuses the readiness gate pattern of `core.v_party_readiness` (migration 0037) and `entry-validate.ts`.

### 5.3 Which states allow data changes (decision D3)
Documento: `draft`, `saved`, `rejected`. Refused in `pending`, `approved`, `posted`, `voided` (to change an approved document, No Aprobar / void it first). Maestro: every state; a change to an `approved` maestro with requiere_aprobacion returns it to `pending`.

### 5.4 Where the flags live
`requiere_aprobacion` and `contabiliza` are set per document type and per maestro type in a per-company configuration table (`kernel.entity_type_settings`), edited under the module's Parámetros, and copied onto each record when it is created so later configuration changes do not alter existing records.

## 6. PDF templates
- Table `kernel.doc_templates(company_id, entity, scope: 'record' | 'list', name, background_file_id, blocks jsonb, is_default, version)` — extends design §11.
- Each entity ships a seeded default template for both scopes (works with no admin action).
- An admin may: upload a sample PDF used as background/letterhead (first page, optional second page for continuation), and/or add blocks: fixed text, system variable, field of the record, table of lines/rows, image (logo), page number. Blocks have position, size, font, alignment.
- Variables: `empresa.*` (nombre, NIT, dirección, ciudad, teléfono, logo), `usuario.*`, `fecha_impresion`, record fields, line fields, list columns and totals. Field visibility rules apply: a field the printing user cannot see prints empty (rule on views).
- Rendering with the existing `@react-pdf/renderer` stack (`packages/kernel/src/exports/pdf.ts`); money as `$ 1.234.567,00` (rule on formats).
- Editor: a form-based block list with live preview; the visual contract is a prototype HTML to be made before the UI task.
- Templates are edited only through audited processes; each save is a new version.

## 7. Notifications
- Table `kernel.state_recipients(company_id, entity, status, emails text[])`, edited under Parámetros through processes.
- On entering a state, the lifecycle emits an outbox event; a consumer renders the record PDF with the default template and sends it through `Mailer` (`packages/infra/src/mailer.ts`). The cloud transport (Resend) gets wired; Docker uses the SMTP sink.
- Notificar: dialog with recipients (pre-filled from the current state's list, editable), subject and message; sends the PDF; logged as a process run.
- Every send is recorded (`kernel.mail_log`: recipients, template version, status, provider id).

## 8. Snapshots
- Table `kernel.record_snapshots(id, company_id, entity, record_id, status, payload jsonb, reason, chain_id, created_at, created_by, seq)`, append-only with an immutable trigger like `audit_log_immutable` (0002), RLS per company.
- Written in the same transaction by the lifecycle on every data change or state transition once a documento is past `draft`. `payload` holds header + lines + datos adicionales.
- Record tab "Versiones": list of snapshots, view one, compare two.
- Applies to documentos only (maestros keep the audit log diffs).

## 9. Access

### 9.1 Record-level
- Table `kernel.record_access(company_id, entity, record_id, grantee_role_id | grantee_user_id, can_read, can_use, can_modify, can_delete, can_void)`. Maestro uses read/use/modify/delete; Documento read/modify/void.
- Default (no rows for a record): role permissions apply as today. When a record has rows, only listed grantees have the listed rights; rules only narrow, never widen past the role's permissions (decision D7). Company admins always keep access to manage the rules.
- Read enforced in RLS: `kernel.enable_company_rls()` gains `kernel.can_access_record(entity, id, 'read')`; views follow (`security_invoker`). Use/modify/delete/void enforced in `runProcess` guards; "use" checked by document validation when a line references the maestro.
- Record tab "Acceso", admin only, edits through audited processes.

### 9.2 Menu
- Level-1 items Maestros, Documentos, Reportes, Parámetros are mandatory in every module manifest; the nav validator and `check:rules` enforce them. Typed entities place themselves under Maestros / Documentos; their list reports under Reportes; `entity_type_settings`, templates and recipient lists under Parámetros. An empty section shows an empty state.
- Table `kernel.menu_access(company_id, nav_key, grantee_role_id | grantee_user_id, allowed)`. Same narrowing semantics. A hidden item's routes and processes are refused server-side as well.

## 10. Owner decisions (2026-11-02, §22.23)
D1–D7 and D9–D12 accepted as proposed below. D8 amended: contabiliza documents post automatically. Approver rule amended: the creator or last editor may approve.
- **D1 Eliminar on documentos** conflicts with rule 9. Proposed: allowed only in Borrador (never numbered); rule 9 amended to say so.
- **D2 States vs accounting.** Proposed mapping in §5.1; `reversed` kept as an accounting mark; current "Devolver a borrador" (§22.20 OD-1) replaced by No Aprobado.
- **D3 Data changes after Grabado.** The rule lists all later states; proposed: changes only in Grabado and No Aprobado; posted/voided documents are immutable (accounting integrity).
- **D4 "Template from a sample PDF".** Proposed: the sample PDF is a background with blocks on top; AI conversion later.
- **D5 Phase.** Proposed: new phase 2A.5 before 2B, pulling the needed slices of §11 and §13 forward.
- **D6 Maestro "Aprobado only if Contabiliza".** Read as a slip; maestros have no contabiliza.
- **D7 Access rules narrow, never widen.**
- **D8 When contabiliza:** posted automatically, on Grabar when no approval is required, on Aprobar when it is (owner 2026-11-02). Posting is part of the action's transaction: if it cannot post, the whole action is rolled back and the document keeps its previous state (Borrador on Grabar, Pendiente de Aprobación on Aprobar) (owner 2026-11-02).

- **D13 Entities that are neither (owner 2026-11-02, from the Task 1 build).** The registry also holds settings, system and line tables. Each table entity declares one role: `maestro`, `documento`, `lines`, `parametro` or `sistema`. Only maestro and documento carry the lifecycle and the typed checks (extra/extra_free, import, export); `lines` belong to their parent's `typed.lines` and travel with it; `parametro` sits under Parámetros; `sistema` covers logs, users, imports, exports and audit. Support tickets are `sistema` for now.
- **D14 Import keys (owner 2026-11-02).** A maestro must declare a natural import key (uom `code`, price list `code`, entry template `name`, fiscal year `year`, period `year`+`month`, unless the entity is better classed `parametro`). A documento declares header + lines import through the file `ref` column instead of an import key.

- **D15 Saving and sending to approval (owner 2026-11-02, Task 14 prototype review).** When the entity requires approval the action bar shows two buttons, «Guardar» and «Guardar y enviar a aprobación» (save + submit in one action). «Enviar a aprobación» alone appears only on a record already saved without being sent (Grabado). When no approval is required only «Guardar» shows. Same rule for maestros and documentos; an Aprobado maestro whose approval fields change still returns to Pendiente automatically (D10, accepted).
- **D16 Friendly record number (owner 2026-11-02).** Every typed record carries a unique consecutive integer per company and entity, assigned on creation and never reused: it is the existing gap-free `seq` (rule 7), declared a candidate key (unique per company and entity). It is not the document's legal number (D9: comprobantes still number at posting). It is shown as «ID» (label changed from «N.º interno», owner 2026-11-02) in the record frame, grids, search, ⌘K and references, and it is the fallback in the Notificar subject when the document has no number yet.
- **D17 Prototype calls accepted (owner 2026-11-02):** Notificar disabled in Borrador and absent on maestros; Duplicar next to Nuevo and Imprimir (inside «Más ▾» below 768 px); fiscal year and period classed `parametro` (their own open/closed state collides with the lifecycle status); the kept Anular grant covers Grabado, Pendiente, No Aprobado and Aprobado documentos (D2).

- **D18 Masked fields in Versiones (owner 2026-11-02).** A field masked or hidden for the viewer shows as masked in both versions and is never marked as changed, so the viewer learns neither its value nor when it changed (rule 14).

- **D19 Shell v7 (owner 2026-11-02, main design §22.24).** The UI uses shell v7: side menu with module names only; the module's four sections in the top bar (§9.2 unchanged otherwise).
- **D20 Restricted lines in the full grid (owner 2026-11-03).** A stored documento whose lines include rows the caller may not see shows them in the universal lines grid as placeholder rows with «••••» in every masked cell, so the grid's totals equal the document's. Placeholder rows come from the masked SQL view (rule 14), never from the raw table; they do not filter, sort by a masked value or export a hidden value, and they count in pagination.

### 10.1 From the builder check (2026-11-02)
- **D9 Numbering.** Proposed: the lifecycle offers a numbering hook; each entity declares when it numbers. Comprobantes keep gap-free numbering at posting (`accounting.next_entry_number`); DIAN invoices number by their legal resolution in `packages/localization/co`. A voided numbered document keeps its number.
- **D10 Approved maestro edited.** Proposed: each maestro type declares its approval-relevant fields (party: NIT, name, tax data, bank accounts); only those send it back to `pending`. The "use" check runs at Grabar and again at Aprobar/Contabilizar.
- **D11 Record-level read reach.** Proposed: the rule hides the record and its lines and its detail rows in screens and lists; aggregate reports (balances, trial balance) still include its amounts without identifying it, so accounting totals never depend on who looks.
- **D12 Admins.** Proposed: company admins are never narrowed (they can always read and operate); rules narrow other users only.

### 10.2 Settled by the builder (my calls, owner may override)
- `accounting.entries` is a documento whose `contabiliza` is true and whose posting is itself (no outbox comprobante); `requiere_aprobacion` comes from the existing `require_approval_on_manual` setting per journal kind; existing `draft` rows stay `draft`, `pending` stays `pending`.
- Eliminar on a maestro is a soft delete (`deleted_at`, hidden everywhere, audit tombstone); "referenced" = any row in the kernel reference registry, which each module populates for its own foreign keys and published references.
- No four-eyes in the generic lifecycle (owner 2026-11-02: the creator or last editor may approve). The accounting four-eyes setting on manual entries (§5.12 of the accounting design, §10b.16) stays as an optional per-company control, off by default, because it was approved separately; the owner may retire it.
- Imported documentos land in Borrador and imported maestros in Grabado (or Pendiente when requiere_aprobacion); import never skips approval or posting rules.

## 11. Constraints
All 37 rules, especially: processes through `runProcess` (1); outbox for cross-module (3); kernel module-agnostic (4); fiscal logic in localization (5); Mailer seam (6); UUID v7 + `seq` + audit columns + `extra/extra_free` (7); documents voided not deleted (9); RLS on every table; step-up for sensitive processes (15); append-only audit (16); Spanish copy via `packages/i18n`; forward-only migrations (34); a feature without its user guide is not finished.

## 12. Migration of what exists
- Classify every current table entity: core parties, products, categories, accounting masters → maestro; `accounting.entries` → documento; line tables → `lines`; settings tables → `parametro` (Parámetros); logs, users, imports, exports, audit → `sistema` (D13).
- Masters: `status active/inactive` → `is_active` + lifecycle state, forward-only, existing rows `approved`/`saved`.
- Accounting entries: status values migrated per §5.1; `EntryStatusBar` replaced by the standard action bar; the 156 accounting integration tests must stay green.
- "Datos adicionales" uses the existing `extra`/`extra_free` columns and per-company field definitions.

## 13. Left to the builder
Task breakdown and order, table and function names beyond those given, the event names, the template block schema details, the compare view of snapshots, the PDF editor layout (within the prototype to be approved), test fixtures.
