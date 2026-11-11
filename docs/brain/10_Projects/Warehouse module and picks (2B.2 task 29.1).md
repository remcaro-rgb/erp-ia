---
tags: [project, warehouse, inventory, sales, picking, reservations, phase-2b]
date: 2026-11-11
status: built, uncommitted
---

# Warehouse module and picks (2B.2 task 29.1)

Sub-task 29.1 of [[Part G design (2B.2 tasks 28-30)]] (PG §4.1–4.3; owner items 151, 153, 164; rulings RG-7, RG-10), after [[FEFO deliveries and returns (2B.2 task 28.3)]] and in parallel with [[Lot serial and tracking forms (2B.2 task 28.5)]]. New module «Bodega», depends on [[Module inventory]] and core; talks to [[Module sales]] by event. Rules: [[Project Rules]] (rules 3, 4, 7, 12, 16, 35). Owner items 212–221 in [[Plan phase-2b-owner-decisions-pending]] (section AD). Migration 0170 ([[Migrations Catalog]]).

## What was built
- **Package `packages/modules/warehouse`** (`@erp/module-warehouse`), registered wherever modules are: web runtime, worker (same order), agent tests, i18n, scripts, e2e helpers, `vitest.workspace.ts`.
- **Migration `0170_warehouse_core.sql`**: schema `warehouse`; `settings` (auto_pick_on_confirm, delivery_from_pick), `picks` (documento ALI-, stage open / in_progress / confirmed, allocation status), `pick_lines` (pedido line, product, ubicación, lot, serial, requested, picked, short); RLS, row audit, `seq`, `via_process` policies, one open pick per pedido, lines locked once confirmed; `warehouse.next_number`; masked views. Also the published `sales.v_pick_order_lines` and the delete grant on `inventory.reservation_allocations`.
- **Processes**: `warehouse.pick.create` (from `sales.order.confirmed` or the screen; proposes ubicación and lot by FEFO then most free stock), `update`, `start`, `confirm` (emits `warehouse.pick.confirmed`), `void`, `consult`, `record_allocation` (event only), `warehouse.settings.update` (step-up).
- **Inventory**: `inventory.reservation.allocate` (event only, all or nothing per pick, `allocation_short`, idempotent on the event) emits `inventory.reservation.allocated`; a reservation released in full drops its allocations. No stock moves at pick (RG-7).
- **Consumers**: confirmed pedido → pick; cancelled pedido → picks voided; inventory's answer → recorded (short sends the pick back to «En proceso» naming the lines).
- **RG-10**: a confirmation parked `not_entitled:warehouse` and replayed after the purchase answers `before_enabled` (no pick for old pedidos).

## Decisions and findings
- The module has no screen until 29.4: only the kernel's Parámetros pages show; `parametros.md` lists their routes (help index). `bodega.md` comes with 29.3/29.4.
- Demo and e2e drains now skip consumers of modules the company does not have (`moduleGate`), as the dispatcher does; the demo is not entitled to Bodega yet.

## Next
29.2 built: [[Pick-driven delivery (2B.2 task 29.2)]]. 29.3 built: [[Packing and put-away (2B.2 task 29.3)]] (0172–0173). 29.4 (screens, demo).
