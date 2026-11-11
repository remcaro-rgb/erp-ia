---
tags: [project, design, invoicing, payments, accounting, localization, phase-2b]
date: 2026-11-09
status: built
---

# Foreign currency design (2B.2 task 34, owner item 19)

Design draft: `docs/superpowers/specs/2026-11-10-foreign-currency-design.md`. Plan: [[Plan phase-2b-sales-stock-chain]] (Task 34 expanded 2026-11-09 into 34.1–34.8; prompts in `docs/superpowers/plans/2026-11-09-phase-2b-task-34-prompts/`). Owner questions 120 to 130: [[Plan phase-2b-owner-decisions-pending]]. Rules 5, 8, 14, 23: [[Project Rules]]. Related: [[Module invoicing]], [[Module payments]], [[Module accounting]], [[Roadmap]].

## What it is
Export invoices in USD with the day's TRM, collected in USD or in pesos, aging in both currencies, and the realized (collection) and unrealized (period close) exchange difference posted automatically. The owner approved the design and items 120–130 as recommended on 2026-11-09; item 126 (e) was answered and 34.6 built. All sub-tasks 34.1–34.8 (with 34.8a and 34.8b) are built on branch `phase-2b-sales-chain`. Items 124 and 129 still need recording in §22 (129 also in rule 23) by the owner; items 131, 132, 133 and 136 wait for a decision.

Sub-task notes: [[Tasas de cambio y TRM (2B.2 task 34.1)]], [[Texto de dinero con moneda (2B.2 task 34.2)]], [[Importes de empresa y reglas con dos importes (2B.2 task 34.4)]], [[Recibos en otra moneda y diferencia en cambio (2B.2 task 34.5)]], [[Anticipos en otra moneda (2B.2 task 34.6)]], [[Cartera en dos monedas y diferencia en cambio no realizada (2B.2 task 34.7)]]. Earlier work it builds on: the DIAN XML and notes (Task 18) and payments with the method-kind ruling (Task 21) in [[Plan phase-2b-sales-stock-chain]]; [[Lista de verificación DIAN (2B.2 task 35)]]; [[Aplicar anticipo a factura (2B.2 task 36)]]; the recommendation API (Task 38, used by the TRM import failure) and [[Revisiones de la tanda 2B.2 (task 52)]].

## Rulings R34-1…R34-9 (plan, Task 34)
- **R34-1** Order: 34.1 ∥ 34.2 → 34.3 → 34.4 → 34.5 → 34.6 (after the accountant) → 34.7 → 34.8.
- **R34-2** Rates reach other modules only through `core.v_exchange_rates`; each module has its own `defaultRate` (3-day look-back).
- **R34-3** The TRM import runs only for companies that have a rate row or a price list in another currency.
- **R34-4** One payload shape: existing fields keep their company meaning, document twins end in `Doc`.
- **R34-5** Old rule copies stay correct: no `currency` path posts company amounts at rate 1; migrations rewrite only unmodified defaults.
- **R34-6** Receipt currency pairs: same as the invoice, or company currency against a foreign invoice; else `currency_mismatch`.
- **R34-7** Export only (item 124): a foreign-currency invoice to a customer in Colombia is refused `foreign_currency_domestic`.
- **R34-8** Rate vs TRM (item 123): more than 0,005 % off the issue date's TRM row issues with the warning chip, no refusal.
- **R34-9** The rates guide is `docs/user-guide/es-419/tasas-de-cambio.md`.

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

## 34.8b built (2026-11-09): the bank account of one medio de pago (owner item 135)
- Found while starting 34.8: a receipt's cash line resolved by the method's **kind** only (`payment_method:<kind>`, Task 21 ruling), so «Transferencia USD» would post dollars into the peso bank account. The owner chose a sub-task before 34.8 ([[Plan phase-2b-owner-decisions-pending]] item 135).
- Kernel: a rule line's `dimension` may be an ordered list (`RuleLine`, max 4); `composeEntry` keeps the first as `dimension` and the rest as `dimensionFallbacks`; `lineDimensions(line)` (exported) gives the list; `PostingProvider.resolveAccount` takes one or a list.
- Accounting: one query, `roleAccountQuery` in `processes/mapping.ts` — `m.dimension = any(list)` ordered by `array_position`, then the role's own mapping — used by the provider, posting-failure retry and the rule preview (they were three copies).
- Payments: `payment-received.json` (and the accounting twin) names `["payment_method_id:{{methodId}}", "payment_method:{{method}}"]`. Keyed by the method's **id**, not its code: user codes could collide with kind keys (`cash`), and the id survives a renamed code; like `category:{id}`. The method record contributes the mapping tab `payments.method_account` (role cash). Migration `0154_payments_rules_method_account.sql` rewrites unedited copies still equal to 0151's template.
- Kept: `payment.receive` still checks the kind is pack-mapped (`method_kind_unmapped`), since payments cannot read accounting's mappings (rule 3); a method's own account only refines a mapped kind. The Mapeo grid shows the raw `payment_method_id:<uuid>`, as it does `category:<uuid>`.

## 34.8 built (2026-11-09): the export sale in the demo, e2e, evals, guides
- Seed (`scripts/demo/sales.ts` step 9, idempotent): **Northwind Roasters LLC** (US, document type 42 `NWR884120`, RUT and Cámara attached through the shared `scripts/demo/files.ts`), three manual USD rates through `core.exchange_rate.set` (origin ui), the list «Exportación USD» (café en grano USD 25), the method **TRF-USD «Transferencia USD»** mapped by `payment_method_id` to **11101001** ([[Plan phase-2b-owner-decisions-pending]] item 135), FE-USD of USD 12.500 at 4.123,45 (IVA 0 % exento, item 134, DIAN mock accepted) and a receipt of USD 5.000 at 4.050: Dr 11101001 $ 20.250.000, Dr 530525 $ 367.250 realized loss; USD 7.500 left open.
- Tests: the seed test asserts the rates, FE-USD (export, USD, rate, iva 0, accepted), its entry balanced in both currencies and the receipt's bank and loss lines; `apps/web/e2e/foreign-currency.spec.ts` (rates screen, FE-USD total `USD 12.500,00`, no rate chip, PDF legend «Equivalente en COP a TRM», a USD receipt through the form, aging in both modes, the receipt voided with step-up so the demo stays at USD 7.500); `smoke.spec.ts` now counts 42 terceros. Evals: `payments-receive-usd` and `fx-revaluation-october` ([[Evals]]).
- Fixed on the way: «Tasas de cambio» had no grid presentation, so «Origen» read `manual`; `presentation.ts` gained `core.exchange_rate`. Number cells still print the stored value (`4123.450000`): owner item 136.
- E2E on the dev server must use `http://localhost:3100`: from `127.0.0.1` the dev server refuses the client's dev connection and the MFA page never hydrates (the guides README says so too).
- Guides: `pagos.md` «La diferencia en cambio» has the demo example; `tasas-de-cambio.md` names the demo rates; `pnpm help:index` run.

