---
tags: [project, design, inventory, warehouse, sales, accounting, phase-2b]
date: 2026-11-10
status: planned
---

# Part G design (2B.2 tasks 28–30)

Design draft: `docs/superpowers/specs/2026-11-10-part-g-design.md`. Plan: [[Plan phase-2b-sales-stock-chain]] (Part G outline, to be expanded after the owner approves). Owner questions 144–164: [[Plan phase-2b-owner-decisions-pending]] (section T). Related: [[Module inventory]], [[Module sales]], [[Module costing]], [[Module invoicing]], [[Module accounting]], [[Localization co]], [[Project Rules]], [[Owner Decisions]].

## What it is
- **Task 28, lots and serials.** `inventory.lot` and `inventory.serial` maestros, per-product tracking in an inventory parametro, FEFO at sales issue, serial buckets of 0 or 1, lots on deliveries, returns and invoice lines (XML only after a DIAN check), recall report. Cost stays per product and bodega (OD-5).
- **Task 29, `warehouse` module.** Picks from `sales.order.confirmed`, a confirmed pick allocates the reservation (no stock move) and creates the Borrador entrega, light packing, put-away suggested by category and confirmed as a relocation. Bins are inventory locations.
- **Task 30, commissions.** Plans name a payee party and the salesperson users; bases frozen at invoice issue; accrual on invoice or pro rata on collection (from `payments.received` and advance applications, not `invoicing.invoice.paid`); CxP provision through new roles `commission_expense` / `commissions_payable` mapped by payee kind; reversals on annulment, credit note and receipt void.

## Key findings from the code (2026-11-10)
- `lot_id` / `serial_id` exist only on movement lines and stock levels, nullable, no FK; reservations and delivery lines have none.
- `invoicing.invoice.paid` fires only at full payment, and the issued event carries no order line or salesperson: commissions need an additive payload change.
- Any `%_payable` role with a party already enters CxP aging, so commissions need no accounting change.

## Proposed order
30 ∥ 28 → 29, migration blocks 0156–0161, 0162–0169, 0170–0177 (item 144).

## Status
Approved by the owner in chat 2026-11-10 (items 144–164 as recommended; 150, 159–161 pending the accountant). Expanded in the plan as twelve sub-tasks (30.1–30.4, 28.1–28.4, 29.1–29.4) with rulings RG-1…RG-14; session prompts in `docs/superpowers/plans/2026-11-10-phase-2b-part-g-prompts/`. Two lanes: A = Task 30, B = Task 28 then 29. Not built; execution not ordered.

## Corrections found while expanding
- Invoice lines copy delivery data when the draft is made (`writeParts`), not at «Emitir»; lots ride `sales.v_invoice_delivery_lines`.
- The country pack has no settings: the XML lot switch is `invoicing.settings.dian_item_instance` (default off).
- No manifest field adds an action to another module's record: «Crear alistamiento» is a warehouse `recordTabs` tab on the pedido.
- `applyStock` ignores lots and `reservation.create` sums every bucket: both change in 28.2 / 28.3.
- Payable accounts 2335/2505 need a party but not `invoice_ready`: the commission subcuentas override it in `extraAccounts()`.

## Task 30 built (2026-11-10)
- **30.1–30.3** (commits c7cc29a, 495c407 and earlier): plans, frozen bases at issue, accrual on invoice or pro rata on collection, CxP posting by payee kind, reversals on annulment, credit notes and receipt or advance voids.
- **30.4** (screens, report, demo; no migration): the plan form `CommissionPlanForm` in the record frame (item 168 decided: payee lookup, kind, rates, validity, a salespeople switch list, category rates); **Ventas › Documentos › Comisiones** (grid and read-only record with its lines, stage pill, PDF default); **Ventas › Reportes › Comisiones por vendedor** (`sales.report.commissions`, one row per base, «Por causar», totals left out when masked, export); the settings box **Base de comisión**; new `sales.commission.consult`; `windowOf` moved to `@erp/kernel` (rule 3).
- **Demo** (seed step 10, `scripts/demo/commissions.ts`): Laura's employee plan (5 %, 7 % «Café molido»), the agent plan for Marcela, a CAF-MOL-250 sale to Catering collected 40 % + 60 % → two COM documents, the payable open in CxP aging. `sales.commission.consult_all` granted to admin, gerente comercial and contador (item 167).
- **Tests**: report and consult cases in `commission-accrual.integration.test.ts` (10); plan form model unit tests; seed assertions; e2e `sales-commissions.spec.ts` (plan on screen, receipt on screen, commission, report, aging, salesperson isolation) with helper `test-support/commission-chain.mts`; two eval cases.
- **Guide**: `docs/user-guide/es-419/comisiones.md`; `ventas.md`, `cartera-por-edades.md` and the index updated.
- Choices for the owner: items 191–198 in [[Plan phase-2b-owner-decisions-pending]].

## Task 28.4 built (2026-11-10)
- **Invoice lots** (migrations 0166, 0167): `sales.v_invoice_delivery_lines.lots` publishes each entrega line's lots as JSON; `invoicing.invoice_lines.lots` copies them in `writeParts` and keeps them through «Emitir» (frozen). The masked view reads them as text `code · expiry · qty`; the invoice grid and its print show «Lote / Vence / Serie».
- **DIAN option**: `invoicing.settings.dian_item_instance` (default off, step-up). On, the co pack writes `cac:ItemInstance` (SerialID, LotIdentification with LotNumberID and ExpiryDate) per lot; off, the XML equals the golden of today. The CUFE does not change. The kernel's `EInvoicePack.buildInvoiceXml(doc, options)` carries `{ itemInstance }`. Checklist row `lotes_en_xml` only while the switch is on (no version bump, item 199).
- **Recall report** `inventory.report.lot_trace` (**Inventario › Reportes › Trazabilidad de lotes**, `/inventory/lot-trace`): movements of a lot or serial with customer (`inventory.movements.party_id`, now written by sale issues and returns), stock by bodega, exports. Uses the kernel `windowOf` (30.4 moved it there).
- **Demo** (`scripts/demo/lots.ts`, seed step 11): CAF-MOL-500 by lot (L-2311, L-2402), grinder ACC-MOL-ELE by serial, a FEFO-split delivery to Distribuciones Andinas del Café, its Borrador with both lots. Eval case «¿A qué clientes fue el lote L-2311?».
- **Tests**: `invoice-lots.integration.test.ts` (3), `lot-trace.integration.test.ts` (5), co pack golden `invoice-item-instance.xml`, checklist tests, seed assertions, e2e `inventory-lots.spec.ts` with helper `test-support/lot-chain.mts`.
- **Lesson**: e2e against the preview server must use `http://localhost:3100`; on `127.0.0.1` the pages do not hydrate and the two-step sign-in hangs (item 205).
- **Lesson**: a maestro `ref` on a system-written historical column is gated by the typed runner's usability check; `inventory.movements.party_id` became `uuid` so a deactivated customer's entrega still ships (item 206).
- **Lesson**: a test that replays an old migration for real must restore today's views in the same transaction (company-amounts replayed 0148 and dropped `v_invoice_lines.lots`).
- **Lesson**: root `pnpm test` skips the module packages' unit tests; run `vitest run` in each touched module.
- Choices for the owner: items 199–208 in [[Plan phase-2b-owner-decisions-pending]]. Guides: [[Module inventory]] (inventario.md), [[Module invoicing]] (facturacion.md, facturacion-electronica.md).

Related: [[Plan phase-2b-sales-stock-chain]], [[Plan phase-2b-owner-decisions-pending]].
