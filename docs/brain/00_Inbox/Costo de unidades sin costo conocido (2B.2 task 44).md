---
tags: [costing, task-44, decision, settings]
date: 2026-11-07
status: implemented-uncommitted
---

# Costo de unidades sin costo conocido (2B.2 task 44)

Part of [[Plan phase-2b-sales-stock-chain]]; owner item 36 and §22.28 in [[Owner Decisions]]; same shape as [[Modo de contabilización (2B.2 task 33)]]. Builds on the cost_missing recommendation of Task 38 and the weighted average of Task 8.

- Migration `0130_costing_unknown_cost_mode.sql`: column `costing.settings.unknown_cost_mode` (`zero` default | `last_known`), `cost_source` check widened with `last_known`, trigger `guard_unknown_cost_mode` (only `costing.unknown_cost.set` changes it for a user session), `v_settings` regenerated.
- Process `costing.unknown_cost.set` (step-up, upserts the settings row, output `{ id, mode, previous }`); `costing.settings.update` is untouched, `costing.settings.consult` adds `unknownCostMode`.
- `catchUp` reads the mode once per run under the feed lock; `valueMovement` estimates only a line that would be valued at 0 for want of cost (receipts, returns without original, adjustments without line cost, issues, transfer outs). Line cost, average and standard cost win. `lastKnownCost`: the product's newest real event (`unit_cost > 0`, not cost_missing, source line/average/standard/original_issue/transfer), same bodega first, then any.
- An estimate is `cost_source = last_known` plus `cost_missing = true`, so the cost_missing row, the recommendation, resolve and void work unchanged; an estimate is never a source. `transfer_in` and `sale_return` inherit an estimated leg.
- An exit estimate applies only when the layer holds no units (`exitEstimateFits`, R44-6 as amended in fix round 1); units held at value 0 leave at 0, flagged. The estimate is not stored as the layer's average.
- Fix round 1 (migration `0131_costing_cost_missing_estimated.sql`): `cost_missing.estimated` marks an open row that took an estimate; while open, the layer's average is an estimate, so average-valued entries and exits become `last_known` + flagged, traslados and returns inherit it, and `lastKnownCost` skips them (and events reversed by a void). Fix round 2 (migration `0132`): `average_costs()` is back to its 0075 body (hiding it broke ledger = layer for adjustments); an adjustment is never estimated, and one valued at the estimated average is flagged (R44-14); voiding the real entry that resolved an estimated row reopens it. Known limit: a void of the estimated occurrence with zero-valued ones left keeps the marker until a real cost (over-flags).
- COGS and ledger need no change: the cost event's amount is what `costing.cogs.posted` carries, so Dr cogs / Cr inventory equals the layer movement.
- Screen: Parámetros › Costeo, second section with its own Guardar and step-up. Guide: `docs/user-guide/es-419/costos.md`. Owner items 75 to 78 in the pending decisions file.
- Tests: `unknown-cost.integration.test.ts`, `entities.test.ts`, `average.test.ts`, e2e `costing-unknown-cost.spec.ts`.
