---
tags: [task-34, fx, invoicing, accounting, posting, pdf, dian, migration, decision]
date: 2026-11-09
status: done-uncommitted
---

# Importes de empresa y reglas con dos importes (2B.2 task 34.4)

Part of [[Plan phase-2b-sales-stock-chain]] («Task 34», sub-task 34.4), designed in [[Foreign currency design (2B.2 task 34)]]. It builds on [[Tasas de cambio y TRM (2B.2 task 34.1)]] and [[Texto de dinero con moneda (2B.2 task 34.2)]]. Owner items 120 and 123; plan rules R34-4, R34-5 and R34-8.

## What changed
- **Company twins.** Migration `0148_invoicing_company_amounts.sql` adds `subtotal_company` to `invoice_lines` and `note_lines`, and `amount_company` to `invoice_taxes` and `note_taxes`. Each is `round(x * exchange_rate, 2)`. They are written at draft time (`writeParts`, `writeNote`) and written again at «Emitir» with the frozen rate, because issued lines are locked. The backfill turns off the lock, touch and audit triggers while it runs.
- **Masking with the twin.** The masked view shows the twin only when the document field is visible too: `viewExpr` nests `kernel.field_visible` for `base` / `amount`.
- **Payload (R34-4).** `invoicing.invoice.issued` and `invoicing.note.issued` now carry `currency`, `exchangeRate`, `subtotalDoc`, `amountDoc` and `totals.totalDoc`. The fields without `Doc` keep company amounts, as before.
- **Rules.** The four default rules post `currency`, `exchangeRate`, `amount` = `*Doc` and `amountCompany` = the company field. The rules are shipped twice and must stay identical; `rules-equal.test.ts` checks it. Migration `0149_invoicing_rules_currency.sql` upgrades default copies that were not modified.
- **R34-5.** A modified copy without a currency still posts in pesos. `syncPostingRules` raises one open recommendation `rule_without_currency` per copy, and closes it once the copy has a currency.
- **Posting engine.** The rounding line has `amountDoc` 0 in a foreign entry, so the document side balances by itself.
- **R34-8.** When the rate is more than 0,005 % off the TRM of the issue date, «Emitir» returns `rateWarning` and the record shows the chip «La tasa difiere de la TRM del día (…)». It is a warning, never a refusal.
- **PDF.** Money prints in the record's currency, and so do the template totals. The `co` pack gives `currencyLegend`, «Equivalente en COP a TRM … del …: $ …», shown above the footer.
- **DIAN checklist.** The checklist moves to version 2. The new item `moneda_extranjera` has `since` 2, so a company that had confirmed the list must confirm it again.

## Choices left open by the plan
- The legend date is in ISO form. A note takes the date of its invoice.
- The recommendation is raised once per rule copy: a second raise merges into the open one.
- Hand-made test payloads use a local `inPesos` helper. Tests do not import it from `scripts/`, because that would pull the scripts into the accounting package's typecheck.
