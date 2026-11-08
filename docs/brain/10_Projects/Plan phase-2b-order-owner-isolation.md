---
tags: [project, feature, sales, security, phase-2b]
date: 2026-11-08
status: implemented-uncommitted
---

# Order owner isolation (2B.2 task 39, owner item 29)

Plan: [[Plan phase-2b-sales-stock-chain]] (Task 39). Owner decision of 2026-11-06, items 94 to 97: [[Plan phase-2b-owner-decisions-pending]]. Rules 12, 13, 14, 16, 34, 35: [[Project Rules]]. Related: [[Module sales]], [[Module crm]], [[User Guide]], [[Migrations Catalog]], [[Roadmap]].

## What it is
A pedido belongs to its salesperson (`sales.orders.owner_id`). A salesperson reads only their own pedidos; whoever may run the new process `sales.order.reassign` (a company admin always) reads all of them, including the ones with no owner. It is the pedido analogue of `crm.opportunity.reassign` for quotes, with one difference: a null owner is visible only to holders.

## Decisions worth remembering
- The record rule is a restrictive `owner_scope` select policy (migration 0139) on `sales.orders` and, through `exists (parent)`, `sales.order_lines`. Every reader (grids, record frame, search, home KPIs, exports, the assistant, `kernel.document_visible`) goes through the views as the caller, so nothing else changed. Event consumers act as the system admin and keep seeing everything. Migration 0140 (review fix, owner item 98) lets the approvers of a pedido that requires approval read it, as the quotes do, and applies the same owner rule inside `sales.lock_orders_for_invoice`.
- Owner on creation: direct create gives the creator; `from_quote` gives the quote's owner, else the converter. `owner_source` records how it was set (not in the view).
- A converter who may not read the new pedido gets the trimmed result `visible: false`; the UI shows «Pedido creado, asignado a <vendedor>» and does not navigate (`apps/web/src/lib/sales/step-result.ts`).
- Deliveries and invoices are not isolated (item 95). They show the order they came from only when the caller reads it; otherwise the plain text «Pedido no disponible», no number, no id, no link. `sales.v_order_owners` publishes the owner for other modules (masked by field visibility); the delivery view has `order_owner_id`; the invoice frame adds «Vendedor del pedido» per readable pedido (item 94).
- Existing roles that already reassign opportunities, ship, or invoice were granted `sales.order.reassign` by 0139 (R39-7); roles created later get nothing.
- Kernel recommendations (final review I-1, migration 0141, 2026-11-08): a process recommendation whose subject has a read view (`<schema>.v_<table>`) shows in `kernel.v_recommendations` only to a caller for whom `kernel.document_visible` shows that record, which is checked in the security-invoker view because a definer reads past RLS. So the «No se creó la factura automática» notice about B's pedido does not reach A. The list's total and `kernel.recommendation.decide` read through the view. Subjects without a read view, and agent rows, are unchanged.
- Grid references: `addRefLabels` marks a readable record that has no name to show with `<field>_found` (`refFoundKey`). `GridCell` then shows «—», and keeps «Pedido no disponible» for a record that is not readable. Versiones also hides `order_line_id` of an unreadable pedido (`unreadableOrderIds`).
- Web: «Cambiar vendedor» (dialog with the active members from `kernel.v_users`, toast «Pedido asignado a …»), the fact «Vendedor» (member name, masked by field visibility), and the pedidos grid column `owner_id` as a named, filterable column (options table `members`).

## Where
Backend (part A): `supabase/migrations/0139_sales_order_owner_isolation.sql`, `0140_sales_order_owner_isolation_fixes.sql`, `0141_kernel_recommendations_subject_visible.sql`, `packages/modules/sales/src/processes/order-owner.ts`. Web (part B): `apps/web/src/lib/sales/{order-owner,step-result,record,actions}.ts`, `apps/web/src/lib/invoicing/record.ts`, `apps/web/src/lib/grid/{options,load,presentation}.ts`, `apps/web/src/app/(app)/r/[entity]/[id]/{sales-view,invoicing-view}.tsx`. Copy: `packages/i18n` (`sales.view.*`, `sales.errors.invalid_owner`, `process.sales.order.reassign`, `invoicing.view.order_*`). Guide: `docs/user-guide/es-419/ventas-visibilidad-de-pedidos.md`. Tests: `order-owner.integration.test.ts` (sales, invoicing, web), `step-result.test.ts`, `apps/web/e2e/order-owner-isolation.spec.ts` (fixture `apps/web/test-support/order-owner-chain.mts`).
