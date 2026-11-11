---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: phase-2b-plan-draft

_Copied from Claude auto-memory._

Plan at `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md` (27 tasks, Parts A–F, migrations from 0056). Written at the owner's word "draft the plan straight from the roadmap"; no module-level 2B design exists, so its "Calls I made" and OD-1..OD-8 must be confirmed and recorded in design §22 before execution.

**Why:** roadmap 2B (CRM, sales, invoicing + DIAN, inventory/warehouse, costing, payments) had no plan; 2A.5 and the 2A gaps are done.
**How to apply:** do not execute until the owner approves the plan and decides the ODs; see [[Memory - phase-2a-gaps-plan]] for the preceding work.

**2026-11-04: owner approved plan + prototype; decisions recorded in main design §22.25 and roadmap (execution still not ordered).**

**2026-11-04 decisions:** invoice creation parametric (manual default | on_delivery | on_order_confirmation); FIFO to phase 3; commission basis parametric with CxP provision entry; invoice annulment only by credit note (export invoices: CreditNoteTypeCode 02, same TRM; exact DIAN code tables unconfirmed); lots/serials, picking/packing, commissions deferred to 2B.2. OD-1/3/4 proceed on recommendation. Prototype: `docs/superpowers/specs/2026-11-04-erp-ia-prototype-2b-sales-chain.html`.

Index: [[Memory Notes]].
