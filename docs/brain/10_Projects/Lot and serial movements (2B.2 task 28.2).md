---
tags: [project, inventory, lots, serials, movements, migration, phase-2b]
date: 2026-11-10
status: committed
---

# Lot and serial movements (2B.2 task 28.2)

Sub-task 28.2 of [[Part G design (2B.2 tasks 28-30)]], after [[Lots and serials maestros (2B.2 task 28.1)]]. Module: [[Module inventory]]. Rules: [[Project Rules]] (RG-2, RG-3, Review Focus 1).

## What was built
- Migration `0163_inventory_lines_lots.sql`: `transfer_lines` and `count_lines` gain `lot_id` / `serial_id` (composite FKs on `(id, product_id)`, a serial line moves or counts one unit), the count bucket key includes lot and serial, `count_lines_guard` lets an open count take a found lot or serial line, masked views re-created.
- `processes/tracked-lines.ts`: `resolveTracked` turns what a line names (`lotId`, `lot.code`, `serialIds`, `serials`) into buckets, creates new lots and serials nested through `ctx.runProcess` (same chain), and expands a serial line into one line per serial; `moveSerials` and `serialsAfterVoid` keep `serial_status` (inbound available, outbound issued, adjustment out scrapped).
- `movement.ts`: buckets keyed `product|location|lot|serial` in `lockStock` / `applyStock`; tracked buckets never go negative (`lot_short`, `serial_not_in_stock`); event lines carry `lotId?` / `serialId?` only when set (untracked payload unchanged, RG-2).
- Transfers carry lot and serials through transit; counts list one line per lot or serial and `record` takes `found`.
- UI: Lote / seriales column in the movement and transfer forms (only for tracked products), lot or serial column on the count sheet and the line grids only when a line is tracked.
- Guide: `docs/user-guide/es-419/inventario.md` § «Lotes y seriales en entradas, salidas, traslados, ajustes y conteos».

## Decisions taken while building (owner items 170–175)
- Manual salidas and traslados name their lot (`lot_required`); FEFO only for sale issues (28.3).
- Lot and serial buckets never go negative, even with backorders allowed.
- A serial's bucket has no lot; a receipt naming an existing lot code reuses it.
- 28.3 must widen `movement_lines_source_key` to the bucket.

## Gotchas
- Lock order: stock locks (lockStock) first, then a transaction advisory lock per serial number in order, then the nested creates. Transfers lock both legs first, so the order holds.
- `count_lines_guard` (0069) blocked any insert on a saved count: found lines needed the trigger changed in 0163.
- RG-6 test lives in `packages/modules/costing` (inventory does not depend on costing).
