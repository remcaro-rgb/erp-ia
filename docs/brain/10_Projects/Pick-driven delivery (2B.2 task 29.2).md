---
tags: [project, warehouse, sales, inventory, picking, deliveries, phase-2b]
date: 2026-11-11
status: built, uncommitted
---

# Pick-driven delivery (2B.2 task 29.2)

Sub-task 29.2 of [[Part G design (2B.2 tasks 28-30)]] (PG §4.3 steps 4–5; owner item 152; ruling RG-8; Review Focus 3), after [[Warehouse module and picks (2B.2 task 29.1)]] and [[FEFO deliveries and returns (2B.2 task 28.3)]]. Modules: [[Module sales]], [[Module inventory]]. Rules: [[Project Rules]] (rules 1, 3, 10, 24, 35). Owner items 222–229 in [[Plan phase-2b-owner-decisions-pending]] (section AE). No migration (0171 stays free).

## What was built
- **Sales consumes `inventory.reservation.allocated`** (`onReservationAllocated`, effect «Ventas: crea la entrega en borrador»): on `allocated` with `createDelivery` it runs `sales.delivery.create` (origin event) with the allocated lines grouped per pedido line (`deliveryLinesFromPick`: one lot or the serials when they apply). `short`, `createDelivery` off, or a pedido that moved on: nothing. Sales still `dependsOn: ["core"]`.
- **`sales.delivery.create` gains `pickId?`** (event origin only, `pick_event_only` otherwise): writes `pick_to_delivery` (from `warehouse.pick`) next to `order_to_delivery`, and keys the run `from_pick:<pickId>` so one alistamiento makes one entrega.
- **Inventory ships from the allocation**: `pickBuckets` takes the reservation's allocations first (ubicación, lot, serial), then RG-4 / RG-2 as before; `inventory.sale.issue` uses the allocations up (cut or deleted) once the issue posts.
- i18n: `sales.effects.pick_delivery`, `sales.errors.pick_event_only`, `record.related.kind.pick_to_delivery` (es-419 and en).
- Guide: `entregas.md` «Entrega desde un alistamiento».

## Tests
- `warehouse/src/__tests__/pick-delivery.integration.test.ts` (new): entrega with lots and serials linked to pick and pedido; setting off → none; ship equals the allocations (Review Focus 3); manual entrega by FEFO; short → none; void restores the allocated buckets and re-reserves; partial ship leaves the rest allocated.
- `sales/src/__tests__/pick-delivery-lines.test.ts` (new, unit); sales manifest test lists the new consumed event; 29.1's pick test voids the auto entrega before cancelling.

## Decisions and findings
- Event consumers have no `ctx.links`: the link is written inside the create (item 222).
- An untracked line picked from two ubicaciones still leaves from one bucket (item 227).

## Next
[[Packing and put-away (2B.2 task 29.3)]] (built 2026-11-11, 0172–0173), 29.4 (screens, order tab, demo, e2e).
