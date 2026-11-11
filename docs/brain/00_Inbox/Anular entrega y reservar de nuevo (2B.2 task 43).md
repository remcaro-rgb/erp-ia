---
tags: [sales, inventory, task-43, decision, reservations]
date: 2026-11-07
status: implemented-uncommitted
---

# Anular entrega y reservar de nuevo (2B.2 task 43)

Part of [[Plan phase-2b-sales-stock-chain]]; owner item 34 and §22.28 in [[Owner Decisions]]. Builds on the nested runs of [[Nested runs configurable (2B.2 task 32)]] and the void of the entrega of Task 14.

- The void screen asks «¿Reservar de nuevo las existencias para el pedido?» (default yes) only for a shipped entrega whose pedido is not cancelled. `RecordActions` got an optional `voidOption`; the answer travels as `option`, the frame maps it to the process input `reReserve` (assistant and API leave it out: today's behaviour).
- Sales decides (R43-5..7): flag on `sales.delivery.voided` only when asked, shipped, pedido not cancelled and `kernel.can_run_process('inventory.reservation.create')` for the caller; otherwise the entrega records `none` / `not_permitted` and the void goes through. Sales never calls inventory (rule 3).
- Inventory's `inventory.sale.void_issue` voids the issue and, nested, runs `inventory.reservation.reserve_again` (nested-only, origin event, no sensitive step): all or nothing per entrega, availability summed per product, an active reservation is topped up (one active row per order line), a released one gets a new active row. A shortage never throws (that would roll back the stock return): status `insufficient` names each product with needed and available.
- The outcome returns by event `inventory.delivery_reservation.restored`; sales' consumer runs `sales.delivery.record_re_reservation` (idempotent) and writes `re_reserve_requested / _result / _note` on the entrega, shown as «Reserva al anular».
- Migrations `0133_sales_delivery_re_reserve.sql` (columns, checks) and `0134_sales_delivery_re_reserve_view.sql` (regenerated `v_deliveries`; split because 0133 was applied alone once). The pair `void_issue → reserve_again` can never be «continue and queue» (Task 32 policy refuses it: stock effects).
- Tests: `reserve-again.integration.test.ts` (inventory), `delivery-void-reserve.integration.test.ts` (sales), entities tests of both modules, `RecordActions.test.tsx`, e2e `sales-chain.spec.ts`. Open owner items 80–83 in the pending-decisions plan (race with a late cancel, trail node, split migration, delayed result).
