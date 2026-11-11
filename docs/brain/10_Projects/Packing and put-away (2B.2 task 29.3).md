---
tags: [project, warehouse, inventory, costing, packing, putaway, phase-2b]
date: 2026-11-11
status: built, uncommitted
---

# Packing and put-away (2B.2 task 29.3)

Sub-task 29.3 of [[Part G design (2B.2 tasks 28-30)]] (PG §4.3 steps 6–8; owner item 155), after [[Pick-driven delivery (2B.2 task 29.2)]] and [[Warehouse module and picks (2B.2 task 29.1)]]. Modules: [[Module inventory]], [[Module costing]]. Rules: [[Project Rules]] (rules 1, 3, 16, 24, 34, 35). Owner items 230–238 in [[Plan phase-2b-owner-decisions-pending]] (section AF). Migrations 0172 (packs, packages, put-away rules) and 0173 (movement kind `relocation`); 0171 stays free.

## What was built
- **Empaque** `warehouse.pack` (documento, `EMP-`, no approval, never posts) with its packages `warehouse.pack_package` (lines: number, weight, dimensions, `items` jsonb, `contents` text). Processes create (from a confirmed alistamiento, one per pick, starts with one package), update (replaces the packages; `pack_exceeds_pick`), close (locks the packages by trigger), void, consult.
- **«Lista de empaque»** default print (`warehouse/src/print.ts`, `printTemplates`), titled from `warehouse.print.pack_title`.
- **Reglas de ubicación** `warehouse.putaway_rule` (parametro: bodega, categoría or none, ubicación, priority).
- **Put-away**: warehouse consumes `inventory.movement.posted` (receipts only) → `warehouse.putaway.notify` raises the kernel recommendation «Recibido por ubicar»; `warehouse.putaway.suggest` computes lot-together → category rule → catch-all; `warehouse.putaway.confirm` emits `warehouse.putaway.confirmed` and closes the recommendation.
- **Relocation**: inventory consumes `warehouse.putaway.confirmed` → `inventory.relocation.post` (`RU-`, two lines per line, same bodega, lot and serial kept, never negative, not voidable).
- **Costing** ignores kind `relocation` (`IGNORED_KINDS`): the feed advances past it. Accounting lists the relocation in `ASYNC_BY_DESIGN`.
- i18n (es-419 and en) for entities, fields, processes, features, effects, errors, the recommendation and the print title; guide `bodega.md` (new) and a «Reubicaciones» section in `inventario.md`.

## Tests
- `warehouse/src/__tests__/pack.integration.test.ts` and `putaway.integration.test.ts` (new, shared `harness.ts`): RLS, audit and seq of 0172; the kind check of 0173; one package to start, two by hand, the PDF, close and ship; suggestions by rule and lot, the relocation with serials, costing unchanged, redelivery idempotent, cross-bodega refused, RG-10.
- Unit: warehouse and inventory manifest tests (features, events, effects, kinds, print title).

## Decisions and findings
- The costing feed broke on a new movement kind: any new kind must be valued or ignored by costing (item 234).
- The kernel print clips table cells to one line, so `contents` keeps the SKU only (item 236).
- Serials cannot be relocated through `postMovement` (inbound serial already in stock), hence a dedicated poster (item 232).

## Next
29.4 (screens for alistamientos, empaques, reglas and the put-away; order tab; demo entitlement to Bodega; e2e).
