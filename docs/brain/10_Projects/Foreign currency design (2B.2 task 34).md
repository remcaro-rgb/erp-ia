---
tags: [project, design, invoicing, payments, accounting, localization, phase-2b]
date: 2026-11-09
status: in-progress
---

# Foreign currency design (2B.2 task 34, owner item 19)

Design draft: `docs/superpowers/specs/2026-11-10-foreign-currency-design.md`. Plan: [[Plan phase-2b-sales-stock-chain]] (Task 34 expanded 2026-11-09 into 34.1–34.8; prompts in `docs/superpowers/plans/2026-11-09-phase-2b-task-34-prompts/`). Owner questions 120 to 130: [[Plan phase-2b-owner-decisions-pending]]. Rules 5, 8, 14, 23: [[Project Rules]]. Related: [[Module invoicing]], [[Module payments]], [[Module accounting]], [[Roadmap]].

## What it is
Export invoices in USD with the day's TRM, collected in USD or in pesos, aging in both currencies, and the realized (collection) and unrealized (period close) exchange difference posted automatically. The owner approved the design and items 120–130 as recommended on 2026-11-09. Item 126 (e) waits for the accountant and blocks 34.6; items 124 and 129 still need recording in §22 (129 also in rule 23). Execution not yet ordered.

## Found in the code (2026-11-09)
- The DIAN XML already emits `DocumentCurrencyCode` and `PaymentExchangeRate` (Task 18). The old "XML refuses foreign currency" note is out of date.
- Every automatic entry today posts company amounts at rate 1 (`debit_doc = debit`): the shipped rules pass no currency. Adding a rate path alone would convert pesos twice.
- No rate table and no TRM feed; `core.currencies` has COP and USD only; `advance_applications.currency` is checked `= 'COP'` (item 114); reprice refuses foreign drafts (item 118).
- The kernel scheduler table is phase 3, so the TRM import is a scheduled check.

## Decisions worth remembering (proposed)
- `core.exchange_rates` per company; TRM through the Colombia pack behind an `infra` `RateFeed` port; a manual rate is never overwritten by the import.
- One currency per ledger entry; the foreign side of a peso collection lives in the allocations (`amount`, `amount_receipt`, `amount_company`). Open balances in document currency come from invoice minus allocations, never from summing `debit_doc` across currencies.
- Payload fields keep their company meaning and gain `*Doc` twins, so old (edited) rules stay correct.
- Exchange-difference roles `fx_gain` / `fx_loss` in the accounting manifest, codes in the pack, to be confirmed by the accountant (item 126).
