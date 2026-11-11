---
tags: [project, inventory, lots, serials, ui, forms, count, phase-2b]
date: 2026-11-11
status: built, uncommitted
---

# Lot, serial and tracking forms (2B.2 task 28.5)

Sub-task 28.5 of [[Part G design (2B.2 tasks 28-30)]] (owner items 165 and 175), after [[FEFO deliveries and returns (2B.2 task 28.3)]]. Module: [[Module inventory]]. Rules: [[Project Rules]] (rules 15, 20, 21, 24, 35, 37; RG-2). Owner items 209–211 in [[Plan phase-2b-owner-decisions-pending]] (section AC). No migration.

## What was built
- Record pages `/r/inventory.lot/<id>`, `/r/inventory.serial/<id>`, `/r/inventory.product_tracking/<id>` (`recordPage: true` on the three entities; entries in `apps/web/src/lib/records/entities.ts`), so «Nuevo» appears on Lotes, Seriales and Seguimiento por producto and every lot or serial reference (movement, transfer and count lines, Existencias) becomes a link.
- `StockFormKind` gains `lot | serial | tracking`; `masterStockDraft` / `masterStockCopy` / `masterStockInput` / `masterStockMissing` / `createProcess` cover them (lot and serial product and code fixed once stored; a serial never sends its status; tracking sends the product and its four settings to `inventory.product_tracking.set`, step-up).
- `StockMasterForm` draws the three forms; «Duplicar» of a lot copies product, dates and note and clears the code.
- Count sheet «Agregar encontrado» (`count-found.tsx`): product, ubicación, a lot of the product or a new code with expiry, a serial box (Enter opens the next row), quantity 1 for a serial; sent as `found` of `inventory.count.record`; refusals shown on the row (`splitFoundMessages`). The action allowlists the keys of `foundInput`.
- «Trazabilidad de lotes» heading names the lot or serial and links to its record (`lot-trace-heading.tsx`).
- Guide: `docs/user-guide/es-419/inventario.md` (crear, duplicar y bloquear un lote; registrar un serial; cambiar el seguimiento; agregar lo encontrado).

## Decisions taken while building
- A parametro keyed by another field: `RecordEntity.keyedBy` resolves the product from `inventory.v_product_tracking` as the caller and calls the consult with `productId`; no «Duplicar» and no extra-data save for it (item 209). The frame title of a record named by a reference reads the referenced record's name.
- Kernel fix: `cloneDraft` dropped every date (a `Date` has no own keys, so it looked empty); dates now clone as `yyyy-mm-dd`, timestamps as ISO (item 210).

## Tests
`packages/ui/src/inventory/__tests__/stock-form-model.test.ts` (+5), `packages/kernel/src/records/__tests__/clone.test.ts` (+1), `apps/web/src/lib/records/entities.test.ts`, `apps/web/e2e/inventory-lot-forms.spec.ts` (5).

Related: [[Plan phase-2b-sales-stock-chain]], [[Lots and serials maestros (2B.2 task 28.1)]], [[Lot and serial movements (2B.2 task 28.2)]].
