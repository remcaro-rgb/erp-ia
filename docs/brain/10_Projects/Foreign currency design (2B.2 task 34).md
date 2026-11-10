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

## 34.3 built (2026-11-09): foreign drafts, rate defaults, price conversion
- Quote, order and invoice creation in another currency take the typed rate, else `defaultRate(tx, currency, date)` (each module's `common.ts`, reading `core.v_exchange_rates`, 3-day lookback like `core.exchange_rate.for_date`); none → `exchange_rate_missing` (was `exchange_rate_required`). The rate is editable in Borrador through each update process (`invalid_exchange_rate` on a company-currency document).
- `resolveLinePrice` takes the document's `exchangeRate`: a list in the document currency wins, else the product's peso list price **divided** by the rate (pesos per unit), half up to the cent, `source: "converted"` with `convertedFrom`. `convertPrice` uses `toPrecision(12)` so `20100 / 4000` rounds to 5,03, not 5,02.
- Invoices: export only (R34-7) via `assertExportCurrency` at create, update and issue (`foreign_currency_domestic`); reprice uses `resolveLinePrice` in any currency (the `currency_not_supported` branch is gone); `from_orders` groups by party and currency and takes the rate of the invoice's date (item 128).
- The record form gained **Moneda** (new documents) and **Tasa de cambio** (foreign ones). Tests that issued USD invoices to Colombian customers now use a foreign buyer (`foreignBuyer` in the invoicing test helpers; the payments helper moves the buyer abroad while issuing).
- Kept the existing `PriceSource` names and added `"converted"` instead of the plan's `"list" | "converted" | "product"` (no later sub-task reads the other names).

## 34.8a built (2026-11-09): IVA exento por exportación from the pack (owner item 134)
- Found while starting 34.8: the Colombia tax engine had no export exemption (IVA came only from the product's `ivaRate`), so FE-USD of coffee would have carried IVA 5 %. The owner chose a pack sub-task before 34.8 (item 134, [[Plan phase-2b-owner-decisions-pending]]).
- `TaxesPack.computeTaxes` input gains `export?: boolean` (kernel contract). In `co`, an export turns a taxed **good** (19 % or 5 %) into IVA 0 % exento (art. 481 lit. a ET); `EXC` stays excluded, INC and other taxes unchanged, services keep their rate (lit. c conditions are not checked). Rule 5: the decision is in the pack; invoicing only says whether the sale is an export.
- Invoicing: `isExportFor(party, companyCountry)` in `common.ts` is the one test (also used for the frozen `is_export` at «Emitir»); `priceLines` passes it, so create, update, reprice, from_orders and issue all tax the same way, in USD or COP. The stored `invoice_lines.iva_rate` is now the rate the pack applied, not the product's (notes re-tax from it).
- XML: a 5 % good taxed with `export: true` builds `export-invoice-usd.xml` byte for byte (no new golden needed). Guide: `facturacion.md` «IVA exento por exportación». Open with the accountant: whether to require the exporter's RUT responsibility or the CI/DEX. Quotes and orders still show the product's IVA to a buyer abroad (not in item 134's scope).
