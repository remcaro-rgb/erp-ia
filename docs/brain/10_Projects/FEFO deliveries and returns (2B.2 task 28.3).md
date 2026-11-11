---
tags: [project, inventory, sales, lots, serials, fefo, migration, phase-2b]
date: 2026-11-10
status: built, uncommitted
---

# FEFO deliveries and returns (2B.2 task 28.3)

Sub-task 28.3 of [[Part G design (2B.2 tasks 28-30)]], after [[Lot and serial movements (2B.2 task 28.2)]]. Modules: [[Module inventory]], [[Module sales]]. Rules: [[Project Rules]] (rule 3, rule 7; RG-2, RG-4; Review Focus 1 and 2). Owner items 186–190 in [[Plan phase-2b-owner-decisions-pending]] (section Z).

## What was built
- Migration `0164_inventory_sale_stock_lots.sql`: `inventory.lot_sellable(lot, date)`, the one predicate shared by FEFO, `inventory.sale_stock` (now dated, `max_bucket` = all sellable stock for a tracked product) and the reservation availability; `source_line_stock` and `movement_lines_source_key` keyed per bucket (location, lot, serial), so one delivery line can move several buckets.
- Migration `0165_sales_delivery_lots.sql`: `lot_id` / `serial_ids` on `sales.delivery_lines` and `sales.return_lines`; `sales.delivery_line_lots` (sistema) and the published `sales.v_delivery_line_lots`; masked views with a `lots` text column («Lote / Vence / Serie»).
- Inventory `sales-deliveries.ts`: `pickBuckets` issues FEFO (expires asc, produced asc, code), skipping blocked and, with `block_expired`, expired lots; honours a named lot or serials; emits `inventory.sale_issue.allocated` after the movement. Returns re-enter the named or original lot / serial, never more than it issued.
- Sales: `sales.delivery.record_lots` (origin event, idempotent on the event id, no `on conflict` so no seq gaps) records the allocation; ship refuses `lot_expired`; returns default the lot from the delivery's allocation; the PDF prints «Lote / Vence / Serie».
- UI: lot columns on the delivery and return line grids only when a line is tracked. Guide: `docs/user-guide/es-419/entregas.md` («Lotes y seriales: primero lo que vence primero (FEFO)», «Devoluciones»).

## Decisions taken while building
- The reservation never promises stock FEFO cannot issue: both read `lot_sellable` (RG-4).
- Untracked products are byte for byte as before: one bucket per line, same events (RG-2).
- Sales reads lots only through `inventory.v_lots`, `v_serials`, `v_product_tracking` and the allocated event (rule 3).

## Tests
`inventory/src/__tests__/fefo.integration.test.ts` (8), `sales/src/__tests__/delivery-lots.integration.test.ts` (3).

Related: [[Plan phase-2b-sales-stock-chain]], [[Lots and serials maestros (2B.2 task 28.1)]].
