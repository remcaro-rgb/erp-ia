---
tags: [task-34, fx, accounting, aging, close, migration, check-rules, decision]
date: 2026-11-09
status: done-uncommitted
---

# Cartera en dos monedas y diferencia en cambio no realizada (2B.2 task 34.7)

Part of [[Plan phase-2b-sales-stock-chain]] («Task 34», sub-task 34.7), designed in [[Foreign currency design (2B.2 task 34)]]. Builds on [[Recibos en otra moneda y diferencia en cambio (2B.2 task 34.5)]] and [[Tasas de cambio y TRM (2B.2 task 34.1)]]. Owner item 126 (b)–(d); new items 131–133 in [[Plan phase-2b-owner-decisions-pending]].

## What changed
- **Open items in two currencies** (`0153_accounting_open_items_currency.sql`). `accounting.open_items` / `open_items_allocated` return `currency`, `amount_doc`, `open_doc`. Receipts split by `amount_company` (pesos at the invoice's rate), so a COP receipt over two USD invoices at different rates is exact. FIFO (no payments) stays company currency.
- **Revaluation documento.** `accounting.fx_revaluations` + `fx_revaluation_lines` (frozen lines, one posted run per period). `accounting.fx_revaluation.run {periodId}` (step-up) revalues every open foreign invoice at the closing rate (≤ 3 days back), posts an NC entry at period end against `fx_gain`/`fx_loss` with `fx_kind:unrealized`, and its reversal the next day. A rerun voids the previous run ("recalculada"); `.void` mirrors both entries at their own dates (reverseEntry refuses reversed entries). Event `accounting.fx_revaluation.posted`.
- **Attaching lines.** The entry stays in COP (one currency per entry); open items map each revaluation line to its invoice through `fx_revaluation_lines.entry_line_id` + `line_no` across the run's entries.
- **Aging «Moneda».** `currency: "company" | "document"`; document mode groups by currency with «Subtotal USD» rows and no grand total.
- **Close check `fx_revaluation`** with `severity: "warning"`: never blocks; `accounting.period.close` returns `warnings`; the close dialog stays open showing them.
- **check:rules `report-currency`.** Every report money column declares `currency: "company"` or `currency: { field }`.

## Lessons
- Payments refuses future-dated receipts (`receipt_in_future`), so tests of a "later" collection date it today and read the open items from the reversal date.
- The i18n catalogue requires snake_case keys: the namespace is `accounting.fx_revaluation`, not `fxRevaluation`.
- The report grid does not yet format per-row currency (item 132); no screen button runs the revaluation (item 131).
