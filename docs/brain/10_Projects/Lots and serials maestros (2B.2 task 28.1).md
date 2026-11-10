---
tags: [project, inventory, lots, serials, migration, phase-2b]
date: 2026-11-10
status: committed
---

# Lots and serials maestros (2B.2 task 28.1)

Sub-task 28.1 of [[Part G design (2B.2 tasks 28-30)]], plan [[Plan phase-2b-sales-stock-chain]] (items 145, 146; RG-2, RG-3). Module: [[Module inventory]]. Rules: [[Project Rules]].

## What was built
- Migration `0162_inventory_lots_serials.sql`: `inventory.lots` and `inventory.serials` (typed maestros), `inventory.product_tracking` (parametro, one row per product), `inventory.reservation_allocations` (sistema, empty until 29.1), `inventory.movements.party_id`, the serial check `serial_id is null or on_hand between 0 and 1` on `stock_levels`, masked views `v_lots`, `v_serials`, `v_product_tracking`, `v_reservation_allocations`, and `v_movements` re-created with `party_id` appended.
- FKs from `movement_lines` and `stock_levels` `lot_id` / `serial_id` are **composite on `(id, product_id)`**, so a line or bucket can never name a lot or serial of another product.
- Processes: `inventory.lot.create/update/consult`, `inventory.serial.create/update/consult`, `inventory.product_tracking.set` (step-up, refuses `tracking_has_stock`) and `.consult`; helper `trackingOf(tx, productId)` (default none, FEFO on, expiry not required, expired blocked).
- Menu: Maestros «Lotes», «Seriales»; Parámetros «Seguimiento por producto» (grid pages under `/inventory/lots`, `/inventory/serials`, `/inventory/product-tracking`). Grids now show the lot and serial columns of movement lines and Existencias.
- Guide: `docs/user-guide/es-419/inventario.md` § «Lotes, seriales y seguimiento por producto».

## Decisions taken while building (check with the owner)
- **Column names `lot_status` and `serial_status`.** The design calls them `status`, but `kernel.typed_columns` already owns `status` on every maestro (the lifecycle draft…approved). The process inputs keep the plan's names (`status: "active" | "blocked"` on `inventory.lot.update`).
- **A serial registered by hand has `serial_status = null`** («sin recibir»). The design's three values (`available`, `issued`, `scrapped`) stay as they are; `available` is set only by a receipt (28.2).
- Switching tracking is refused only when the **tracking kind** changes; changing FEFO, expiry or block of the same kind is allowed with stock (item 146 is about switching tracking on).
- `expiry_required` is already enforced by `inventory.lot.create` and `update`, so the nested create in 28.2 inherits it.
- Lots and serials have no record frame of their own (no `recordPage`): grid only, because the plan lists no form for them. Rules 21 and 37 want one; raised as owner item 165.

## Gotcha
A restrictive RLS update policy makes a direct `update` by a user session affect **0 rows**, not raise. Tests assert the row count.
