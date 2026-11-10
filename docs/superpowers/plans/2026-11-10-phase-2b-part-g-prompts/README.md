# Phase 2B.2 · Part G (Tasks 28, 29, 30) · one prompt per sub-task

Generated 2026-11-10 from «Expanded tasks of Part G» in `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, after the owner approved the design `docs/superpowers/specs/2026-11-10-part-g-design.md` in chat with items 144–164 as recommended. The owner has not yet ordered execution. Items 150, 159, 160 and 161 are the accountant's, taken as recommended pending confirmation (they change mappings and a setting, not code). Item 151 is still to be recorded by the owner in §22.

The plan is the authority; each prompt copies its sub-task's text, the rulings and the global constraints verbatim, so an edit to the plan must be mirrored here (or the prompts regenerated).

| # | File | Sub-task | Starts when |
|---|---|---|---|
| 30.1 | [`task-30-1-plans-and-bases.md`](task-30-1-plans-and-bases.md) | Plans, settings, bases and the payload fields commissions need | At once (lane A), in parallel with 28.1 in a separate worktree. |
| 30.2 | [`task-30-2-accrual-and-posting.md`](task-30-2-accrual-and-posting.md) | Accrual and posting on both bases, roles and the Colombia mappings | 30.1 is merged. |
| 30.3 | [`task-30-3-reversals.md`](task-30-3-reversals.md) | Reversals | 30.2 is merged. |
| 30.4 | [`task-30-4-screens-report-demo.md`](task-30-4-screens-report-demo.md) | Screens, report, assistant, demo, guide, e2e | 30.3 is merged. |
| 28.1 | [`task-28-1-lot-serial-maestros.md`](task-28-1-lot-serial-maestros.md) | Maestros, tracking parametro and the seams | At once (lane B), in parallel with 30.1 in a separate worktree. |
| 28.2 | [`task-28-2-inbound-internal-movements.md`](task-28-2-inbound-internal-movements.md) | Inbound and internal movements by lot and serial | 28.1 is merged. |
| 28.3 | [`task-28-3-fefo-deliveries-returns.md`](task-28-3-fefo-deliveries-returns.md) | FEFO issue, availability, deliveries and returns | 28.2 is merged. |
| 28.4 | [`task-28-4-invoice-dian-recall-demo.md`](task-28-4-invoice-dian-recall-demo.md) | Invoice, DIAN option, recall report, demo, guides, e2e | 28.3 is merged. |
| 29.1 | [`task-29-1-warehouse-module-picks.md`](task-29-1-warehouse-module-picks.md) | Module, picks and reservation allocation | 28.4 is merged. |
| 29.2 | [`task-29-2-pick-driven-delivery.md`](task-29-2-pick-driven-delivery.md) | Pick-driven delivery and ship from the allocation | 29.1 is merged. |
| 29.3 | [`task-29-3-packing-putaway.md`](task-29-3-packing-putaway.md) | Packing and put-away | 29.2 is merged. |
| 29.4 | [`task-29-4-screens-order-tab-demo.md`](task-29-4-screens-order-tab-demo.md) | Screens, order tab, report, assistant, demo, e2e | 29.3 is merged. |

Lanes (RG-1): **A** 30.1 → 30.2 → 30.3 → 30.4 · **B** 28.1 → 28.2 → 28.3 → 28.4 → 29.1 → 29.2 → 29.3 → 29.4. A and B run in parallel in separate worktrees; the sales manifest, sales entities, `delivery.ts`, invoicing's `invoice.ts` / `common.ts`, the i18n catalogues, the demo seed and the guide index are shared, so their merges go one at a time (the later one rebases).
