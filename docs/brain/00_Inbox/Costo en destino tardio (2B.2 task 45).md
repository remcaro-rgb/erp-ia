---
tags: [costing, landed-cost, cogs, accounting, phase-2b]
date: 2026-11-10
status: built
---

# Costo en destino tardío (2B.2 task 45)

A landed cost (freight, duties) that arrives after some of the receipt's units were sold now sends the sold units' share to **cost of sales in the current period** (owner item 37; items 137–139 decided as recommended, pending the accountant). Nothing in a past period is rewritten.

## How it works
- Per receipt line: `onHand = min(received, layer qty now)`; lines of one product share their layer, so units on hand go to the lines in order (item 141).
- `splitShare` (`packages/modules/costing/src/allocation.ts`): stock part = share × onHand / received, half-up to the cent; cost of sales part = the remainder. The two always add up to the share.
- Stock part: layer value up, cost event `landed_cost` (as before).
- Cost of sales part: new cost event kind `landed_cost_cogs` (qty 0, layer unchanged), and a `Dr cogs` line per receipt line in the same entry, on the request's `costCenterId` (item 140: no category cost center exists; the allocation takes one, like a sales delivery).
- Layer invariant: `value = Σ events except landed_cost_cogs`.
- Void reverses both kinds; the whole entry is reversed by the existing `reverseOf` rule.
- Nothing sold: identical entry to before (the engine drops the zero cogs line).

## Migration 0155
`supabase/migrations/0155_costing_landed_cogs.sql`: kind and cost-source checks, qty and amount-sign checks, `landed_cost_lines.amount_stock` / `amount_cogs` (backfilled), `landed_costs.cost_center_id`, regenerated masked views, the cogs line added to unedited copies of the five allocation rules, and `cogsAdjustment: 0` on parked events written before it (item 143). Re-runnable.

## Where
- Process: `packages/modules/costing/src/processes/landed-cost.ts`; rule: `rules.ts`; tests: `landed-cost-late.integration.test.ts`.
- Guide: `docs/user-guide/es-419/costos.md` «Costo en destino que llega tarde».

Related: [[Foreign currency design (2B.2 task 34)]], [[000_Index]].
