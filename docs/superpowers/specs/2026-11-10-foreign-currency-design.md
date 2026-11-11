# ERP-IA · Foreign currency (phase 2B.2, plan Task 34) — Design

Date: 2026-11-09 · Status: **approved by the owner in chat on 2026-11-09**, items 120–130 as recommended (item 126 (e) with the accountant); plan: expanded Task 34 of `2026-11-03-phase-2b-sales-stock-chain.md` · Source: owner decision item 19 of `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md` (2026-11-06: foreign-currency invoicing and collection are in 2B.2), items 114 and 118 (2026-11-09), main design §8, §8.1, §15, §22.25 (OD-7), §22.28, §22.29, accounting design §5, §5.11, §10a.8. Owner questions: items 120 onwards of the owner-decisions file. Nothing here is in main design §22 until the owner records it.

## 0. Intent, goals, non-goals

**Intent.** Café del Norte sells coffee abroad. It must issue an export invoice in USD with the day's TRM, collect it in USD or in pesos, see what each customer owes in both currencies, and have the ledger show the exchange difference the collection produced, all without a single hand-made journal entry.

**Goals.**
- One document currency per quote, order, invoice, note, receipt and advance application, with the rate snapshot and company-currency amounts stored on the document (rule 8).
- Rates come from a company rate table filled every day from the TRM, with manual rates for other currencies and audited overrides.
- Every automatic entry of a foreign-currency document posts its document amounts and its company amounts. A collection posts the realized exchange difference. A period close may post the unrealized difference of open foreign-currency items.
- Aging and open items show the document currency and the company-currency equivalent. No report sums two currencies into one figure.

**Non-goals (2B.2).** Group consolidation (main design §2). Supplier-side foreign currency (purchases arrive in a later phase; the rate table and the posting pieces serve it then). Hedging and forward contracts. Foreign-currency withholdings (§5). A second functional currency per company.

**Anti-goals.** A COP amount stored where a USD amount belongs (the bug of item 118). A total that adds pesos and dollars. A PUC code in kernel or module source (rule 5). A rate that changes on an issued document.

## 1. What exists today (verified 2026-11-09, file:line)

The task prompt's list is partly out of date: Task 18 already lifted the XML refusal.

| Area | State |
|---|---|
| Company currency | `kernel.companies.currency_code char(3) default 'COP'` (0001:98) |
| Currencies | `core.currencies(code, name, symbol)` (0006:15), seeded COP and USD only |
| Documents | `crm.quotes`, `sales.orders`, `invoicing.invoices`, `invoicing.notes`, `payments.receipts` all have `currency text` (ISO check) and `exchange_rate numeric(18,6) default 1`; headers carry `total_company`; **lines carry no company amounts**; frozen once past Borrador |
| Rate input | create processes of quote, order and invoice require `exchangeRate` for a foreign currency (`exchange_rate_required`, invoice.ts:184, order.ts:389, quote.ts:270); there is **no rate table and no TRM feed** |
| Price lists | `core.price_lists.currency_code` exists (0006:1449); `core.products.list_price` has no currency (implicitly the company's); `resolveLinePrice` skips lists in another currency (sales/src/price.ts:73-104) |
| Reprice | `invoicing.invoice.reprice` refuses a foreign draft with `currency_not_supported` (invoice.ts:329-334, item 118) |
| DIAN XML | `currencyOf()` (xml-builder.ts:406-424) emits `DocumentCurrencyCode` and `cac:PaymentExchangeRate` (Source, SourceCurrencyBaseRate 1.00, Target COP, CalculationRate to 6 decimals, Date); the target `COMPANY_CURRENCY = "COP"` is hard-coded in the pack (:115), acceptable since it is the pack. Export is `InvoiceTypeCode 02` when the party's country differs (invoice.ts:627). `currency_not_supported` in einvoice.ts:327 now only refuses a code outside table 13.3.3 |
| CUFE, resubmit | CUFE hashes document-currency amounts (cufe.ts:56-78); golden files `export-invoice-usd.xml`, `export-annulment-credit-note.xml`; `invoicing.invoice.resubmit_failed` sweeps `currency_not_supported` (einvoice.ts:589-635) |
| Notes | copy the invoice's currency and rate (note.ts:280-297; OD-7) |
| Posting | the engine supports `currency`, `exchangeRate` and per-line `amountCompany` (template.ts:55-75, compose.ts:66-78); a line is dropped only when its **company** amount is 0, and the side flips on a negative company amount. **No shipped rule passes currency**: `invoice-issued.json` and the payment rules post company amounts at rate 1, so `debit_doc = debit` on every automatic entry |
| Payments | receipts take the company currency and rate 1 (receipt.ts:379-406); `payability()` refuses an invoice in another currency (:276); `payments.advance_applications.currency check (= 'COP')`, no rate, no company amounts (0137:26, item 114) |
| Ledger | `accounting.entries.currency`, `exchange_rate`; `entry_lines.debit/credit` company, `debit_doc/credit_doc` document (0032:53-124) |
| Aging | `accounting.open_items` and `open_items_allocated` read company amounts (0112, 0138); `invoicing.v_open_invoices` has `open_company` (0096:295) |
| Roles | no exchange-difference role; PUC seed has `530520 «Diferencia en cambio»` (puc.json:2173); the income twin `421020` is not in `puc.json` |
| Money text | `formatMoney(value, currency)` in `packages/ui/src/money/format.ts:18` (COP `$`, USD `US$`, EUR `€`); `moneyText` (kernel/src/exports/format.ts:122), `pesos` (payments common.ts:99) and close-checks `money` always print `$`; assistant cards go through `moneyText` (labels.ts:31-42), so a USD amount shows as `$` today |
| Demo | no foreign customer, rate or invoice |

## 2. Rate source and the rate table (scope item 2)

**Proposed.**
- New table `core.exchange_rates` (parametro, under Núcleo › Parámetros › «Tasas de cambio»): `currency` (references `core.currencies`), `rate_date date`, `rate numeric(18,6)` (pesos per unit), `source` `trm | manual`, `note`, the rule 7 columns, `unique (company_id, currency, rate_date)`. One row per company: the TRM is national, but rule 7 and rule 12 keep every business row company-bound and RLS-bound, and a company may correct its own copy.
- **TRM feed.** The country pack (rule 5) exposes `CountryPack.exchangeRates.officialRate(currency, date)`: for `co` it reads the Superfinanciera TRM from the datos.gov.co open-data dataset (`32sa-8pi3`, fields `valor`, `vigenciadesde`, `vigenciahasta`) and answers USD only. The HTTP fetch goes through a new `infra` port `RateFeed` with the cloud and the Docker implementation (rule 6; the Docker one reads a fixture file so CI never calls the internet). The kernel scheduler table is phase 3 (`packages/infra/src/scheduler.ts:1-3`), so the daily run is **one more per-company scheduled check** beside the existing ones in `apps/web/src/lib/server/scheduled-checks.ts` (system user with the company's admin role, rule 28): it is due once per company per day after 07:00 tenant time, only for companies with an active currency other than their own, and runs `core.exchange_rate.import_official` with origin `scheduler`. A TRM covers its validity range (a Saturday-to-Monday TRM writes three rows). The import **never overwrites a `manual` row**: it skips that date and the record shows «Tasa manual; la TRM publicada es 4.123,45». `RateFeed` has one HTTP implementation (plain `fetch`, valid on cloud and on Docker/on-premise) and a fixture implementation selected by configuration for tests and CI.
- **Manual rates.** `core.exchange_rate.set {currency, rateDate, rate, note}` writes a manual row or overrides a TRM row. The override keeps the old value in the audit (before/after, rule 16) and sets `source = manual`. Default sensitivity: **step-up** when it overrides a `trm` row, normal otherwise (two process ids so the admin can tune each, rule 15: `core.exchange_rate.set` and `core.exchange_rate.override_official`).
- **Document default.** A document's rate defaults to the table's rate for its currency on its date (invoice: issue date; note: the invoice's rate, OD-7; receipt: receipt date; quote and order: their date). The user may type another rate while the document is in Borrador (it is a field of the document, audited with it). At Emitir (invoice) or Grabar (receipt) the rate is frozen, as today.
- **No rate for the date.** Creation in a foreign currency without a typed rate and without a table row is refused with `exchange_rate_missing` («No hay tasa de cambio para USD el 2026-11-09; regístrala en Tasas de cambio o escríbela en el documento»). `exchange_rate_required` is renamed to it (same code path). The import job's failure raises a kernel recommendation to the admin role (Task 38 API), one open per company and date.
- **Invoice rate differs from the TRM.** The invoice issues, and its record shows a warning chip «La tasa difiere de la TRM del día (4.123,45)». Not a refusal (see item 123).

**Rule or decision it rests on.** Rules 1, 5, 6, 7, 12, 15, 16, 28; Decreto 1453 de 2018 (art. 288 ET: initial recognition at the TRM); main design §5.10 scheduler.

**Open question.** Items 121 (override sensitivity), 122 (rates for non-USD currencies), 123 (typed rate vs TRM on an invoice).

## 3. DIAN XML (scope item 1)

**Proposed.** No builder change for the currency block: it already emits `DocumentCurrencyCode` and `PaymentExchangeRate` with the TRM and date, and the CUFE hashes document amounts. Task 34 adds:
- the rate is read from the frozen invoice (already so) and the date is the **invoice's issue date** for notes too (already so, OD-7);
- a PDF (representación gráfica) that shows each total in the document currency and, below the totals, «Equivalente en COP a TRM 4.123,45 del 2026-11-09: $ 4.123.450,00». The template stays in the invoicing module (`packages/modules/invoicing/src/pdf/invoice-template.ts`); the legend's wording and which totals it lists come from the pack (`einvoice.currencyLegend(...)`, rule 5);
- a domestic (non-export) invoice in a foreign currency: allowed by the builder; whether the company may issue one is item 124.

**Unconfirmed for habilitación** (added to the Task 35 checklist as one new item «Moneda extranjera», admin ticks it): (a) DIAN's position that the invoice is "in COP without prejudice of another currency" (Concepto 905 de 2020, Res. 042 de 2020) versus the annex's `DocumentCurrencyCode` in USD with `PaymentExchangeRate`: the habilitación set must accept a USD export invoice built this way; (b) whether `LegalMonetaryTotal` amounts must be in the document currency (as built) and the CUFE on those amounts (as built); (c) the rounding of `CalculationRate` (6 decimals built; TRM has 2).

**Rule or decision it rests on.** Rule 5; OD-7 (§22.25); Task 18 golden files.

**Open question.** Item 124.

## 4. Posting at the document's rate (scope item 3)

**Proposed.**
- **No kernel interface change** (one behaviour fix, below). `composeEntry` already takes `currency`, `exchangeRate` and per-line `amountCompany`, drops a line only when its company amount is 0 and flips the side on a negative company amount. That is what exchange-difference lines need (document amount 0, company amount ≠ 0).
- **Rules change, payloads grow, old rules stay correct.** Today's payload fields keep their meaning (company amounts), and the payloads **add** document-amount twins (`subtotalDoc`, `amountDoc`, `totals.totalDoc`, …). The new shipped rules (`invoice-issued.json`, the notes', the payment rules) gain `currency` and `exchangeRate` paths, `amount` reads the `*Doc` field and `amountCompany` the existing field. A company still on an old copy of a rule (no currency path, rate 1, amount = company field) keeps posting correct company figures; only its `debit_doc` columns equal the company ones. Adding the rate path to today's rule alone would multiply already-converted pesos by the rate, so the change is one shape, tested.
- **Reaching installed rules.** `accounting.posting_rule.sync` adds only missing rules and never touches modified ones (posting-rule.ts:203-223). A forward-only migration rewrites the company copies still equal to the old default (precedents 0098, 0115, 0142); a company whose copy was edited keeps it, and a kernel recommendation to the accounting role says «La regla X no lleva moneda; las facturas en moneda extranjera se contabilizarán solo en COP». A foreign-currency document whose rule has no currency path still posts (company amounts are right). The rules are shipped twice today (`invoicing/src/rules/` and `accounting/src/rules/defaults/`, the same for payments); both copies change identically, pinned by a test that they are equal.
- **Rounding line.** `compose.ts:118-121` sets the rounding line's `amountDoc = amountCompany`. For an entry in a foreign currency the rounding line's document amount becomes 0 (a behaviour fix in the kernel, no interface change, with a unit test).
- **Company amounts are stored, not recomputed** (rule 8 literal): invoice lines get `subtotal_company`, invoice taxes `amount_company`, note lines and taxes the same, receipt allocations `amount_company` (at the invoice's rate) and `amount_receipt` (in the receipt's currency), advance application lines `amount_company`. Each is filled at Emitir / Grabar with today's `companyAmounts()` rounding (per line half-up to the cent; the receivable is their sum, so it equals `total_company`). A company-currency document stores the same figures (rate 1), so the rule has one shape.
- Migration of existing rows: the forward-only migration backfills the new columns from document amounts × `exchange_rate` with the same rounding (every existing row is COP at 1, so they equal the document amounts).

- **One currency per entry; the foreign side of a collection lives in the allocations.** The ledger keeps one currency and rate per entry (0032:53-54); `entry_lines` gets no line currency. A receipt's entry is in the receipt's currency. When a peso receipt settles a USD invoice, the receivable line is a peso line of a peso entry, and the dollars it settled are the allocation's `amount` (in the invoice's currency). Every open balance in document currency is therefore computed per invoice as the invoice entry's document amount minus the allocations' document amounts (§7), never as a sum of `debit_doc` across entries of mixed currencies. A single peso receipt may settle peso and USD invoices together; each allocation carries its own pair of amounts.

**Rule or decision it rests on.** Rule 8; accounting design §5.2, §10a.8; kernel §5.6.

**Open question.** None for the owner; item 120 covers storing line-level company amounts (my recommendation: yes).

## 5. Exchange differences (scope item 4) · **accountant**

**Proposed.**
- Two new roles declared by the accounting module's manifest (`accountRoles`): `fx_gain` (diferencia en cambio, ingreso) and `fx_loss` (diferencia en cambio, gasto). The Colombia pack maps them in `role-mappings.ts`, proposed `fx_gain → 421020` (added through `extraAccounts()`, since it is not in `puc.json`) and `fx_loss → 530525`; **the codes are the accountant's** (the seed today names `530520` «Diferencia en cambio», which the accountant must confirm or correct). Dimension `kind:realized | kind:unrealized` lets the accountant split them into subaccounts (useful for formato 2516, below).
- **Realized (on collection).** When a receipt or an advance application settles a foreign-currency invoice, the receivable is credited at the invoice's carrying rate and the money at the receipt's rate. The payload carries `fx.gain` and `fx.loss` (non-negative, at most one non-zero) per allocation, and the rule has one `fx_gain` credit and one `fx_loss` debit line with `amount: 0` and `amountCompany` from the payload. Example: invoice USD 1.000 at 4.100 (receivable $ 4.100.000); paid USD 1.000 at 4.000 into a USD account: Dr bank $ 4.000.000 · Dr fx_loss $ 100.000 · Cr receivable $ 4.100.000.
- **Unrealized (at period close).** New process `accounting.fx_revaluation.run {periodId}` (step-up, admin and accountant roles): for each open foreign-currency receivable invoice (foreign bank and cash accounts: item 130) it compares the carrying company amount with the open document amount × the closing rate (the rate table's rate on the period's last day), posts one entry «Ajuste por diferencia en cambio» in the Notas journal with **one line per open invoice** (party, receivable account, company amount only, document amount 0) plus the fx lines, records which invoice each line adjusts in `accounting.fx_revaluation_lines (revaluation_id, entry_line_id, invoice_id)`, which `open_items_allocated` reads so the adjustment and its reversal attach to that invoice (like `invoicing.ledger_note_invoices` for notes) and never become FIFO items of their own, and posts its **reversal dated the first day of the next period**, so a later collection always settles at the invoice's rate. A period close check «Diferencia en cambio no calculada» (warning, not blocking) appears while a period with open foreign items has no run. Rerunning a period voids and reposts.
- **Fiscal side.** Art. 288 ET: exchange differences have no fiscal effect until realized. With the `kind:unrealized` dimension mapped to its own subaccount, the 2516 conversion column of accounting design §5.10 can read it; no fiscal ledger is added.

**Rule or decision it rests on.** Rules 4, 5 (roles in the manifest, codes in the pack); accounting design §5.3, §5.10; NIC 21 / NIIF para Pymes sección 30 (monetary items at the closing rate).

**Open question (accountant, item 126).** (a) the accounts for gain and loss, realized and unrealized; (b) revalue at every month end or only at year end; (c) reverse on day 1 (recommended) or carry the revalued rate; (d) which items are revalued: receivables yes; foreign bank accounts per item 130; **customer advances are non-monetary** (NIC 21) and are not revalued, confirm; (e) IFRIC 22 (CINIIF 22): revenue covered by an advance is measured at the advance's rate; the simplified proposal posts the invoice at its own TRM and the difference against the advance as realized fx; confirm which.

## 6. Receipts and advances in a foreign currency (scope item 5)

**Proposed.**
- A receipt has one currency, the currency of the money received, and its rate (default the table's rate on the receipt date).
- **Allowed pairs**: receipt currency = invoice currency (USD paid into a USD account), or receipt in the company currency against a foreign invoice (the bank monetized the dollars and deposited pesos). A USD receipt against a EUR invoice is refused (`currency_mismatch`).
- **Allocation lines** carry `amount` in the invoice's currency (what it settles of the invoice's open balance, as today), `amount_receipt` in the receipt's currency and `amount_company` at the invoice's rate. Same currency: `amount_receipt = amount`. Pesos against USD: the user types both the USD settled and the pesos received for that invoice; the implied rate is shown and the difference to the invoice's rate is the realized fx of §5. The receipt total is the sum of `amount_receipt`.
- **Partial collection**: the open balance stays in the invoice's currency (`openOf`, unchanged); the invoice is paid when its document-currency open is 0, whatever the pesos.
- **Withholdings on a foreign-currency allocation** are refused in 2B.2 (`withholding_foreign_currency`): an export customer abroad practises none. Domestic foreign-currency invoices depend on item 124.
- **Payment methods** gain `currency` (default the company's). A receipt's method must be in the receipt's currency (`method_currency_mismatch`), so a USD receipt lands in the USD bank account the method maps to through the `payment_method` dimension (no new role).
- **Advances.** Item 114: migration adds `payments.advance_applications.exchange_rate`, `total_company`, drops the `= 'COP'` check (forward-only `alter table … drop constraint`) in favour of the ISO check, and adds `amount_company` on lines. An advance (the `advance` part of a receipt) keeps the receipt's currency and rate. Applying it to an invoice requires the same currency; Dr `customer_advances` at the advance's rate, Cr receivable at the invoice's rate, difference to fx (§5, pending item 126 (e)). An advance in pesos applied to a USD invoice is refused in 2B.2 (`currency_mismatch`).
- **Void** reverses through `reverseOf`, fx lines included (no change).

**Rule or decision it rests on.** Rule 8; item 114; accounting design §5.4.

**Open question.** Item 125 (COP receipt against a USD invoice: in scope as proposed), item 126 (e).

## 7. Aging and open items in both currencies (scope item 6)

**Proposed.**
- `accounting.open_items` and `open_items_allocated` (new versions, forward-only) also return `currency`, `amount_doc` and `open_doc` per invoice item: `amount_doc` from the invoice entry (its `entries.currency`, `debit_doc`), `open_doc` = `amount_doc` − Σ allocations' `amount` (document currency of the invoice) − notes' document amounts.
- **Company figures change for foreign invoices, not for COP.** 0138 splits a receipt's receivable line over its allocations by `ledger_allocations.amount` and compares it with the receipt total (0138:40, 79). With several USD invoices at different rates, or pesos against dollars, that split is wrong. The new version splits by `amount_company` (equal to `amount` for every existing COP row, so today's figures are reproduced, pinned by a regression test on the 2A/2B demo data), and the revaluation lines attach per invoice (§5).
- `accounting.report.aging` gains the parameter «Moneda»: «Equivalente en COP» (default, today's report; the header says «Valores en COP») or «Moneda del documento», which groups rows by currency with a subtotal per currency and **no grand total across currencies**.
- The sales credit check and `v_open_invoices.open_company` stay in company currency (credit limits are in pesos).
- Every report that sums money names its currency in its header or column title; `check:rules` gains a test that the money columns of report definitions declare a currency source.

**Rule or decision it rests on.** Accounting design §5.11; rule 20 (exports carry exactly the visible columns, the currency column included).

**Open question.** None.

## 8. Quotes, orders and «Recalcular precios» (scope item 7)

**Proposed.**
- Quotes and orders already carry currency and rate; they get the table default (§2) and keep their rate frozen once accepted / confirmed (as today).
- **Price resolution for a foreign-currency line**: (1) a price list of the customer or the document **in the document's currency**; (2) otherwise the product's `list_price` (company currency) converted at the document's rate, rounded half-up to two decimals, the line marked «Precio convertido de COP a 4.123,45». The same function serves quote, order and invoice lines and «Recalcular precios»; item 118's refusal is lifted.
- **Invoice from orders**: the invoice's prices stay the order's agreed prices in the order's currency (§22.28); the invoice's **rate is the rate of the invoice's date**, not the order's, since the fiscal value is fixed at invoicing (art. 288 ET). `from_orders` groups by party and currency only.

**Rule or decision it rests on.** Item 118; §22.28 (order-billed lines keep the order's price).

**Open question.** Item 127 (conversion fallback vs per-currency lists only), item 128 (invoice rate from its date vs the order's).

## 9. Notes, CUFE, resubmit, demo (scope item 8)

**Proposed.**
- Credit and debit notes keep the invoice's currency and rate (OD-7, unchanged); their company amounts are their document amounts × the invoice's rate, so a credit note reverses the receivable at the carrying rate and never produces fx.
- No regression: the Task 18 golden files and `resubmit_failed` tests stay green unchanged; one new golden file for a USD export invoice with a converted-price line.
- **Demo seed** (Café del Norte): currency USD rates for the seeded dates (manual rows with `source = trm` copied from the published series, through `core.exchange_rate.set`, origin `ui`, item 56); a USD bank account and payment method «Transferencia USD»; one foreign customer, **Northwind Roasters LLC** (fictional), United States, document type 42 (documento de identificación extranjero), invoice-ready; a USD price list; one export invoice FE-USD of USD 12.500 (green coffee, IVA exento por exportación, pending item 124's tax check); one partial USD receipt of USD 5.000 at a lower rate producing a realized loss; the aging in both modes shows it.

**Rule or decision it rests on.** OD-7; rule 10; item 56.

**Open question.** The export tax treatment of the demo line (IVA exento, art. 481 ET) must come from the pack's tax engine: verify in the plan task that the engine has the export exemption; if not, it is a pack change in the task.

## 10. Visibility, RLS, assistant and copy (scope item 9)

**Proposed.**
- Every new company-amount column declares the same `sensitivity` as its document twin, so `maskedViewSql` masks them together; masked views regenerated (the `entities.test.ts` drift test). `core.exchange_rates` is RLS-bound, not sensitive. No new unmasked view; the guard of Task 40 is unchanged.
- **Money text with currency.** `moneyText(amount, currency?)` in kernel exports, `pesos` in payments and close-checks' `money` take the currency; the assistant's `valueText` passes the input's or the document's currency; grids and PDF exports print the currency for non-company-currency values.
- **Format** (rule 23 covers COP): COP `$ 1.234.567,00`; other currencies the ISO code, a space and the same es-CO digits, `USD 12.500,00`, `EUR 980,50` (item 129; `formatMoney` today prints `US$` and `€`).
- Rates render with up to six decimals, es-CO separators: `4.123,45`.
- All copy through `packages/i18n` in the owning module's namespace with `en` mirrors (rule 24): `core.exchangeRates.*`, `payments.errors.currency_mismatch`, `payments.errors.method_currency_mismatch`, `payments.errors.withholding_foreign_currency`, `*.errors.exchange_rate_missing`, `accounting.fxRevaluation.*`.
- The assistant gets the new processes as tools filtered by permission (rule 17); eval cases: «¿Cuál es la TRM de hoy?», «Registra un recibo de USD 5.000 de Northwind», «Calcula la diferencia en cambio de octubre».

**Rule or decision it rests on.** Rules 14, 17, 23, 24, 30.

**Open question.** Item 129.

## 11. Data model changes

All forward-only, numbered from **0147**, each with its integration test (rule 34). Numbers are indicative; the plan fixes them.

| Migration | Schema | Change |
|---|---|---|
| 0147 `core_exchange_rates` | core | table `core.exchange_rates` (§2), RLS, audit, seq, masked view, entity row; seed EUR in `core.currencies` (item 122) |
| 0148 `invoicing_company_amounts` | invoicing | `invoice_lines.subtotal_company`, `invoice_taxes.amount_company`, `note_lines.subtotal_company`, `note_taxes.amount_company` numeric(18,4) not null, backfilled; masked views re-created |
| 0149 `payments_foreign_currency` | payments | `payment_methods.currency`; `receipt_allocations.amount_receipt`, `amount_company`; `advance_applications.exchange_rate numeric(18,6)`, `total_company`, drop `currency = 'COP'` check, add ISO check; `advance_application_lines.amount_company`; backfills; `allocated_amounts`, `ledger_allocations` re-created with the new columns (grants as 0114) |
| 0150 `accounting_open_items_currency` | accounting | new versions of `open_items`, `open_items_allocated` (split by `amount_company`, `currency`, `amount_doc`, `open_doc`, revaluation lines per invoice); tables `accounting.fx_revaluations` (documento: period, closing rates jsonb, entry ids, status) and `accounting.fx_revaluation_lines` |
| 0151 `accounting_rules_currency` | accounting | rewrites the company copies of the default rules still equal to the old default (§4) |

No scheduler table: the TRM import is a scheduled check (§2).

## 12. Processes (new and changed)

| Process | Kind | Permission / sensitivity | Effect |
|---|---|---|---|
| `core.exchange_rate.set` (new) | create/update | role; normal | writes a manual rate |
| `core.exchange_rate.override_official` (new) | update | role; **step-up** default | replaces a `trm` row, audited before/after |
| `core.exchange_rate.import_official` (new) | create | origin `scheduler` or admin «Traer TRM»; normal | fetches through the pack and `RateFeed`, upserts `trm` rows, recommendation on failure |
| `core.exchange_rate.for_date` (new) | consult | role | answers the rate for a currency and date (used by forms and the assistant) |
| `crm.quote.create/update`, `sales.order.create/update` | changed | unchanged | rate defaults from the table; foreign price resolution (§8) |
| `invoicing.invoice.create/update/from_orders/reprice` | changed | unchanged | rate default and edit in Borrador; conversion; item 118 refusal lifted; group by currency |
| `invoicing.invoice.issue`, `invoicing.note.issue*` | changed | unchanged | store company amounts; payload with both amounts; PDF with COP equivalent |
| `payments.payment.receive`, `open_invoices`, `void` | changed | unchanged | foreign receipts, pairs, `amount_receipt`, realized fx in the payload |
| `payments.advance.apply`, `undo` | changed | unchanged | rate and company amounts (item 114), realized fx |
| `accounting.fx_revaluation.run` (new) | create | role (admin, contador); **step-up** | revaluation entry and next-day reversal per period |
| `accounting.fx_revaluation.void` (new) | update | role; step-up | voids a run (reversal of both entries) |
| `accounting.report.aging` | consult | unchanged | «Moneda» parameter |

Events: payloads of `invoicing.invoice.issued`, `invoicing.note.issued`, `payments.received`, `payments.advance.applied` gain per-line company amounts and `fx`; new `accounting.fx_revaluation.posted`. Effects (`ModuleDef.effects`): «Contabilidad: diferencia en cambio» on receipts and applications.

## 13. User guides that change (rule 35)

New `docs/user-guide/es-419/nucleo/tasas-de-cambio.md`; updated: facturas (moneda extranjera, TRM, equivalente en COP, Recalcular precios convertidos), notas, recibos de caja (recibo en USD, pesos contra factura en USD, diferencia en cambio), anticipos, cartera por edades (moneda), cierre de período (diferencia en cambio no realizada), cotizaciones y pedidos (moneda), medios de pago (moneda), lista de verificación DIAN (moneda extranjera). Each indexed for the assistant.

## 14. Suggested split for the expanded plan task (after approval)

34.1 rate table, TRM feed through the pack and `RateFeed`, processes, scheduler, guide · 34.2 money text with currency in kernel exports, payments, close checks and the assistant · 34.3 invoicing company amounts, rules with both amounts, rate defaults, price conversion and reprice, `from_orders`, PDF equivalent, DIAN checklist item · 34.4 payments: method currency, foreign receipts and pairs, realized fx, advances (item 114) · 34.5 accounting: fx roles in manifest and pack, open items and aging in both currencies, revaluation run and close check · 34.6 demo seed, e2e (USD invoice → partial USD receipt → aging both modes), evals, guides. 34.1 and 34.2 are independent; 34.3 needs 34.1; 34.4 needs 34.3 and the accountant's item 126; 34.5 needs 34.4 and item 126; 34.6 last.

## 15. Calls I made (check these)

1. Rates are stored per company, not in a global table (rules 7, 12).
2. The TRM fetch is a pack function behind an `infra` port, with a fixture in Docker/CI; no internet call in tests.
3. Line-level company amounts are stored (rule 8 literal), not recomputed at posting.
4. No change to the posting engine's contract; the rules and payloads change.
5. One currency per entry; a collection's foreign side is tracked by its allocations, not by a line currency in the ledger (§4).
6. Payload fields keep their company meaning and gain `*Doc` twins; unedited rule copies are rewritten by migration, edited ones get a recommendation (§4).
7. The TRM import is a scheduled check, not a phase 3 scheduler row, and never overwrites a manual rate (§2).
8. Revaluation posts one line per invoice, attached through `fx_revaluation_lines` (§5).
9. The COP-equivalent PDF block stays in the module template with its wording from the pack (§3).
10. Unrealized revaluation reverses on the first day of the next period (proposal pending the accountant).
11. Withholdings on foreign-currency allocations are refused in 2B.2.
12. A foreign receipt lands only through a payment method in its currency; no new bank role.
13. The invoice issued from an order takes the rate of the invoice's date (pending item 128).
14. A typed rate that differs from the TRM warns, never refuses (pending item 123).
15. The demo customer is fictional, «Northwind Roasters LLC».
16. The builder check of 2026-11-09 (nine points) is folded in: calls 5–9 above, §7's company split, item 130.
