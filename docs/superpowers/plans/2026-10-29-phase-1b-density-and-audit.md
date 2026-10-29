# Phase 1b: density decisions, cloning, audit detail, entity links, editable users — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Read `docs/project-rules.md` and the design sections named in each task before starting; follow the task verbatim. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the owner decisions of 2026-10-29 (design §22.11–16): the accepted audit decisions OD-1…OD-7 and OD-9…OD-12, the five open audit frictions (M8, M12, M16, L4, L9), movable grid columns, cloning of any entity, audit before/after with friendly names, entity links everywhere, and editable users.

**Architecture:** Everything stays inside phase 1's kernel: new kernel processes (`kernel.admin.permission.set_many`, `kernel.admin.field_permission.set_many`, `kernel.admin.user.update`), one forward migration `0025_kernel_audit_source_and_user_state`, additions to `EntityDef`/`FieldDef` (`cloneReset`, `ref`), `Kpi.series/asOf`, and UI work in `packages/ui` + `apps/web`. Prototype v6 (`docs/superpowers/specs/2026-10-28-erp-ia-prototype-v6-density.html`) is the visual contract for the density items; prototype v5 for everything else.

**Tech Stack:** as phase 1 (Next.js 16, Supabase, Tailwind v4 + `erp-*` stylesheet over tokens, Vitest, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-26-erp-ia-design.md` §22.11–16, §6, §9, §19a; rules 16, 20, 21, 37; audit `docs/superpowers/reports/2026-10-28-ui-density-audit.md` §2 (diffs per file) and §3.

## Global Constraints
- Rules 1, 12–16, 19–25, 31, 33–37 of `docs/project-rules.md`. Copy through `packages/i18n` (es-419 + en, same keys). No Spanish literals in `apps/web` .tsx. `pnpm check:rules` green.
- Migrations forward-only from `0025`; `pnpm db:migrate:new kernel <topic>`.
- Every state change through `runProcess`; apps/web reads only `v_*` views.
- Test first (RED in the report); each task ends green on: lint, typecheck, check:rules, the package's unit + integration suites, web build, and the Playwright specs it touches (`E2E_BASE_URL=http://localhost:3100` against the running dev server).
- One conventional commit per task on branch `phase-1b`.

## Review Focus
1. A cloned record must never carry the source's unique fields (document number, DV, SKU, seq, files) and must be refused the same way a hand-typed duplicate is — Task 5 tests.
2. Audit before/after values must obey the viewer's field visibility (a masked field shows `••••••` in old and new) — Task 4 tests.
3. Batch admin changes apply atomically: one failing cell rolls back the batch and the UI shows which cell — Task 3 tests.
4. Column order persists per saved view and survives hidden/visible toggles without losing hidden columns — Task 2 tests.
5. Deactivated users cannot sign in or run processes immediately (membership state, not only the token) — Task 7 tests.

---

### Task 1: Tokens, shell and small frictions (OD-1, OD-2, OD-3, OD-6, OD-10, M8, L4, L9)

**Files:**
- Modify: `packages/ui/src/styles/tokens.css` (dark `--primary` #2563EB, `--primary-h` #1D4ED8; `--link` #1D4ED8 light / #60A5FA dark; `--line-input` #8A94A3 light / #6B7686 dark; `--input: var(--line-input)`), `components.css` (inputs use `--line-input`; links use `--link`; `main` padding on grid/admin routes `gap:12px; padding:12px 16px`), `packages/ui/src/shell/TabsBar.tsx` (horizontal scroll, active tab `scrollIntoView`, "+" and "Cerrar todas" pinned right, keyboard ← → unchanged), `AppShell.tsx` (drawer initial state closed when `window.innerWidth < 1280`, persisted in user prefs key `assistant.open`), `packages/ui/src/grid/use-popover.ts` + `SavedViewsMenu.tsx` (focus moves into the popover on open, returns to the trigger on Esc/close; deleting a saved view asks "¿Eliminar {name}?" inline, key `grid.views.confirm_remove`), `apps/web/src/app/(app)/admin/ai-usage/ai-usage-screen.tsx` (allowance bar 12 px with 80 %/100 % ticks and the percentage written: audit §2.32 block), `packages/ui/src/home/Widget.tsx` (header is a real `<button>`: Enter/Space open a "Mover" mode where arrows move/resize, Esc exits; the hint text visible while in that mode).
- Test: `packages/ui/src/styles/__tests__/tokens-contrast.test.ts` (computes WCAG ratios from the token values: `--focus-ring`, `--line-input`, white on dark `--primary` ≥ 3:1 / 3:1 / 4.5:1), `shell/__tests__/TabsBar.test.tsx` (20 tabs: the active one is scrolled into view; "+" visible), `AppShell.test.tsx` (drawer closed at 1200 px, open at 1400 px, pref wins), `grid/__tests__/popover-focus.test.tsx`, `home/__tests__/Widget.test.tsx` (keyboard move mode), `apps/web/.../ai-usage-screen.test.tsx`.

**Interfaces:** Produces tokens `--link`, `--line-input`; pref key `assistant.open`.

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(ui): density tokens, scrolling tabs row, drawer default, popover focus, allowance bar, widget keyboard mode`.

### Task 2: Grid — sticky identity column, tfoot totals, movable columns (OD-4, OD-5, decision 12)

**Files:**
- Modify: `packages/ui/src/grid/DataGrid.tsx`, `GridFooter.tsx`, `ColumnChooser.tsx`, `components.css` (`.erp-grid th.is-pinned, td.is-pinned { position: sticky; left: … }` for the selection cell and the entity's identity column = the first `presentation.title` field; `tfoot` sticky bottom with the filtered money totals under their columns, `tabular-nums`; selection totals stay in the footer), `packages/ui/src/grid/grid-model.ts` (`moveColumn(view, field, toIndex)`; order kept in `view.columns`; hidden columns keep their relative order), header drag-and-drop (HTML5 DnD on `th`, `aria-grabbed`, drop indicator) and keyboard (`Alt+←/→` on a focused header moves it; announce via the status row), the column chooser lists columns in order with ↑/↓ buttons.
- Modify: saved views already persist `columns` (`SavedViewState`) — verify order round-trips; `apps/web/src/lib/grid/*` unchanged.
- Test: `grid/__tests__/column-order.test.tsx` (drag header 3 to position 1 → order and request columns change; Alt+→; chooser arrows; hide column keeps order; saved view round-trip), `DataGrid.test.tsx` (pinned classes on the selection and identity cells; tfoot shows `Suma cupo` under the money column), Playwright `grid.spec.ts` (drag a header, reload, order persists through the saved view).

**Interfaces:** Produces `moveColumn`; CSS classes `is-pinned`, `.erp-grid tfoot`.

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(grid): sticky identity column, footer totals under columns, movable columns`.

### Task 3: Admin batch changes with one step-up (OD-7) and matrix polish (M10)

**Files:**
- Create: `packages/kernel/src/admin/batch.ts` — processes `kernel.admin.permission.set_many` (input `{ changes: { roleId, processId, allowed }[] }`, max 500, kind update, step-up, feature `kernel.admin`; one transaction; refuses the whole batch on the first invalid change with `invalid_input` carrying the failing index; audit input lists the changes) and `kernel.admin.field_permission.set_many` (same shape with `{ roleId, entity, field, mode }`). Register in `kernel-module.ts`; `kernel.sync_sensitive_defaults` covers them (write kind).
- Modify: `apps/web/src/app/(app)/admin/permissions/permission-matrix.tsx`, `admin/fields/fields-screen.tsx` (staged cells with a "N cambios sin aplicar" pill, "Aplicar cambios" → one step-up → `set_many`; "Descartar"; failing index highlighted; module-level "todos/ninguno" stage every cell of the module), i18n keys `common.admin.pending_changes` (ICU plural), `apply_changes`, `discard_changes`, `permissions.all`, `permissions.grant_module`.
- Test: `packages/kernel/src/admin/__tests__/batch.integration.test.ts` (30 grants in one call with one step-up; an invalid change rolls back all; non-admin forbidden; audit has one row listing the changes), web unit tests for staging, Playwright `admin.spec.ts` (stage 3 cells, apply with one code, reload shows them).

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(admin): batch permission and visibility changes with one step-up`.

### Task 4: Audit before/after, friendly names, source record (decisions 13–14, rule 16)

**Files:**
- Create: migration `0025_kernel_audit_source_and_user_state` (`alter table kernel.audit_log add column source_row_id uuid`; `kernel.v_audit_entries` gains `diff`, `input`, `source_row_id` for company admins; `kernel.memberships add column is_active boolean not null default true` (used by Task 7); `kernel.current_role_ids()` ignores inactive memberships).
- Modify: `packages/kernel/src/audit/audit.ts` (`AuditEntry.sourceRowId`), `process/run.ts` (`RunProcessOptions.sourceRowId` → audit row + `erp.audit_source_row_id` GUC so the row trigger's insert entry carries it too), `0002`'s trigger reads the GUC (edit the function in 0025 with `create or replace`).
- Modify: `apps/web/src/app/(app)/admin/audit/*`: the grid shows `Proceso` as the process description + id in mono, `Entidad` as the entity label, `Actor` as a link to `/admin/users/<userId>` (Task 7 creates the page; link target agreed now), `Registro` as a link to `/r/<entity>/<id>`, `Origen` (clonado desde → link); a detail sheet per row lists each changed field as `label · antes → después` using `kernel.field_mode` of the viewer (masked → `••••••`), with the field label from the catalogue and option/code labels (reuse Task 18's label helpers); export of the audit grid keeps excluding `diff`.
- Test: kernel integration (`source_row_id` written by `runProcess({ sourceRowId })` and by the trigger; view returns diff for admins only), web integration (detail renders old/new with labels; masked field shows dots for a non-admin viewer — simulate with a role whose field is masked and `is_company_admin` false reading the detail through a consult), Playwright `admin.spec.ts` (open an audit row, see "Nombre comercial · — → Bosque QA").

**Interfaces:** Produces `RunProcessOptions.sourceRowId`, `audit_log.source_row_id`, `memberships.is_active`.

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(audit): before/after per field with friendly names, source record of clones`.

### Task 5: Cloning any entity (decision 13, rule 37)

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (`EntityDef.cloneReset: string[]` — fields cleared on clone; `defineEntity` validates them), `packages/modules/core/src/entities.ts` (party: `document_number, check_digit, seq, dian_status, invoice_ready`; product: `sku, seq`; category: `name`; contact: none), `packages/modules/support/src/entities.ts` (ticket: `seq, status`).
- Create: `packages/kernel/src/records/clone.ts` — `cloneDraft(registry, entity, record)` → the create input built from the visible record minus `cloneReset` and minus server-managed fields; `apps/web/src/lib/records/clone.ts` server action `cloneRecordAction(entity, id)` → loads through the entity's consult, returns the draft + `sourceRowId`; the record frame gets a "Duplicar" action (keyboard: Ctrl/⌘+D) that opens the create form prefilled, with a banner "Copia de <nombre>"; saving calls `<entity>.create` with `options.sourceRowId`.
- Test: core integration (clone a party → new row, document fields empty, create refused until a new NIT is typed, audit entry `source_row_id` = source; clone a product → sku empty; contacts and files are NOT copied), ui test (banner, Ctrl+D), Playwright `record.spec.ts` (Duplicar Éxito → fill a new NIT → saved → audit shows "clonado desde Almacenes Éxito").

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(records): clone any entity with the source recorded in the audit`.

### Task 6: Entity links everywhere (decision 15, rule 21)

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (`FieldDef.ref?: string` — the entity a field references); core/support entities declare them (`product.supplier_id → core.party`, `product.category_id → core.product_category`, `party_contact.party_id → core.party`, `ticket.reporter_user_id → kernel.user`); register `kernel.user` as a kernel entity with view `kernel.v_users` (id, full_name, email, locale, mobile via `v_memberships` rules) so links and lookups resolve.
- Modify: `packages/ui/src/grid/GridCell.tsx` (a `ref` field renders the label as a link to `recordHref(ref, id)` using the row's `<field>_label` from the view or the lookup table), `assistant/ResultTable.tsx` (same), forms' lookup displays (link beside the magnifier), `home/widgets.tsx` recent (already links), audit (Task 4), users page (Task 7). `apps/web/src/lib/grid/columns.ts` passes `ref`.
- Test: ui tests (GridCell renders a link for a ref field, plain text when the viewer lacks the target's consult), web integration (product grid supplier cell links to the party), Playwright (click the supplier link from the products grid → party record).

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(ui): every entity reference is a link`.

### Task 7: Editable users (decision 16)

**Files:**
- Create: process `kernel.admin.user.update` in `packages/kernel/src/admin/users.ts` (input `{ userId, name?, mobileCc?, mobile?, photo?, locale?, roleIds?, active? }`, step-up; an admin cannot deactivate themselves or the last active admin; `active=false` sets `memberships.is_active=false` and revokes nothing else; roles via the existing `user_role.set` logic), `apps/web/src/app/(app)/admin/users/[userId]/page.tsx` (user page: data, roles, 2FA state, last activity from the audit, "Desactivar"), edit dialog on the users list; `kernel.v_users`/`v_memberships` expose `is_active`; sign-in and `runProcess` refuse an inactive membership (`forbidden`), the shell shows "Cuenta desactivada" and signs out.
- Test: kernel integration (update name/mobile/roles/active; self-deactivation refused; last-admin refused; inactive user's old claims refused by `can_run_process`), Playwright `admin.spec.ts` (edit Marcela's mobile; deactivate and see her login refused; reactivate).

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(admin): editable users with activation state`.

### Task 8: Forms — Enter to next field, DIAN hints toggle, code combobox, read-only DV (OD-11, OD-12, M12)

**Files:**
- Modify: `packages/ui/src/forms/form-parts.tsx` (Enter in an input moves focus to the next field, Shift+Enter back, Ctrl/⌘+Enter saves; DIAN schema hints behind a "ver códigos DIAN" toggle persisted in prefs `forms.dian_hints`), `fields/CodeCombobox.tsx` (new: typeahead over a code table with ↑↓ Enter Esc, used for municipality, department, UoM, category), `PartyForm.tsx`/`ProductForm.tsx` (DV and composed name `readOnly` + copy button, never `disabled`).
- Test: ui tests (Enter order, hints toggle, combobox keyboard, readOnly DV copyable), Playwright `record.spec.ts` (type a municipality by name).

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(forms): enter-to-next, DIAN hints toggle, code combobox, read-only computed fields`.

### Task 9: Import preview errors view (M16) and KPI series (OD-9)

**Files:**
- Modify: `packages/ui/src/import/ImportDialog.tsx` ("Solo filas con error (N)" toggle, fixed row height with the error in a tooltip/expander), `packages/kernel/src/registry/types.ts` (`Kpi.series?: number[]`, `asOf: string` on the home response), providers compute 14 daily points from `created_at` (parties, products, tickets) and from `llm_usage` (tokens) in SQL as the caller; `home/KpiCard.tsx` sparkline (audit §2.27 SVG) and "Actualizado hh:mm".
- Test: kernel integration (series length 14, caller-scoped), ui tests (sparkline scale; errors-only toggle), Playwright `home.spec.ts` (sparkline present).

- [ ] Step 1: failing tests. Step 2: implement. Step 3: `feat(home,import): KPI trends and errors-only import preview`.

### Task 10: Guides, prototype note, e2e sweep

**Files:**
- Modify: `docs/user-guide/es-419/{listados,administracion,terceros,productos,inicio}.md` (movable columns, Duplicar, audit detail, user editing, batch changes, Enter/Ctrl+S), `pnpm help:index`; `docs/superpowers/specs/2026-10-28-erp-ia-prototype-v6-density.html` panel marks OD-1…7, 9–12 as "aplicado" and OD-8 "rechazado"; README accounts unchanged.
- Test: full `pnpm -F web e2e` against the dev server, full unit + integration.

- [ ] Step 1: update guides and index. Step 2: full suites. Step 3: `docs: phase 1b guides and prototype status`.

## Self-review notes
- Interfaces defined once: `RunProcessOptions.sourceRowId` (Task 4) consumed by Task 5; `memberships.is_active` (Task 4 migration) consumed by Task 7; `FieldDef.ref` (Task 6) consumed by Task 4's audit links and Task 7's user page; `/admin/users/[userId]` route (Task 7) linked from Task 4.
- Owner decisions covered: OD-1,2,3,6,10 (T1), OD-4,5 + decision 12 (T2), OD-7 (T3), decisions 13–14 (T4–5), 15 (T6), 16 (T7), OD-11,12 + M12 (T8), OD-9 + M16 (T9); M8, L4, L9 (T1).
