---
tags: [project, plan]
date: 2026-11-07
status: active
---

# ERP-IA Phase 2B: Sales and stock chain (quote → ledger) — Implementation Plan

Source: `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md` (written 2026-11-03).

**Goal:** In the demo company, a quote becomes an order, a delivery moves stock at weighted-average cost, a DIAN-valid electronic invoice is issued and accepted, a customer receipt settles it, and every step lands in the ledger from the manifest posting rules, audited on one causal chain (main design §8.1; roadmap phase 2 exit criteria).

## Parts
- Part A · Foundations
- Part B · Inventory and costing
- Part C · CRM and sales
- Part D · Invoicing and DIAN
- Part E · Payments and the chain
- Part F · Close
- Part G · Subphase 2B.2 (deferred, OD-8)

## Tasks (31)
- Task 1: Posting rules move into the module manifests
- Task 2: Colombia pack · taxes and withholdings engine
- Task 3: Colombia pack · DIAN resolutions and sequences
- Task 4: DIAN port · UBL 2.1, CUFE, amounts
- Task 5: DIAN port · signing, transport seam and certificates
- Task 6: Inventory module · warehouses, stock and movements (no lots or serials: OD-8)
- Task 7: Transfers, adjustments and counts
- Task 8: Costing · weighted average and COGS
- Task 9: Costing · landed costs (FIFO moves to phase 3: OD-5)
- Task 10: Inventory pages (picking, packing and put-away deferred to 2B.2: OD-8)
- Task 11: CRM · leads, opportunities, pipelines, activities
- Task 12: Sales · price resolution and quotes
- Task 13: Sales orders and stock reservation
- Task 14: Deliveries and returns
- Task 15: (moved to 2B.2 as Task 30, OD-8)
- Task 16: Invoices, taxes and the issue process
- Task 17: E-invoice workflow (sign, submit, poll, store)
- Task 18: Credit and debit notes
- Task 19: Invoice PDF, QR and the Parámetros of invoicing
- Task 20: Invoicing pages
- Task 21: Payments · receipts, methods, cash boxes
- Task 22: Open items from allocations
- Task 23: Paid status and the end-to-end chain
- Task 24: Failure paths of the chain
- Task 25: Assistant tools, effects and evals
- Task 26: KPIs, menus, entitlements and demo data
- Task 27: User guides, rules, roadmap and hand-off
- Task 28: Lots and serials
- Task 29: Picking, packing and put-away
- Task 30: Commissions with a CxP provision (OD-6)
- Task 31: Document link table and trail (owner decision 2026-11-06, design §22.27)

Related: [[Roadmap]], [[Project Rules]], [[Design Spec Index]], [[10_Projects]].
