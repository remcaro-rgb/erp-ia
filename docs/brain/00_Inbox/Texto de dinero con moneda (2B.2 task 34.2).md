---
tags: [task-34, fx, money, kernel, ui, payments, accounting, agent, decision]
date: 2026-11-09
status: done-uncommitted
---

# Texto de dinero con moneda (2B.2 task 34.2)

Part of [[Plan phase-2b-sales-stock-chain]] («Task 34», sub-task 34.2); owner item 129 in [[Plan phase-2b-owner-decisions-pending]] (decided 2026-11-09). It extends rule 23 of [[Project Rules]]; the owner records the extension in the design §22. Runs in parallel with 34.1 (rates and TRM).

## What changed
- Format: COP stays `$ 1.234.567,00`; any other currency prints its ISO code, a space and the same es-CO digits: `USD 12.500,00`, `EUR 980,50`. The minus sign goes first: `-$ 1.000,00`, `-USD 1.000,00`. `US$` and `€` are gone.
- `formatMoney(value, currency = "COP", companyCurrency = "COP")` (`packages/ui/src/money/format.ts`): `$` only for COP in a COP company; in a company of another currency every currency, COP included, prints its code. `parseMoney` also reads a leading ISO code.
- `moneyText(amount, currency = "COP")` and `rateText(rate)` (`packages/kernel/src/exports/format.ts`), exported from `@erp/kernel`. `rateText` prints up to six decimals, trailing zeros dropped down to two (`4.123,45`, `4.123,456789`).
- `cellText(…, { paper, currency })` and `valueText` (`ValueLabels.currency`) print the currency; the assistant's confirmation card (`buildPreview`) passes the input's `currency`.
- Payments: `money(n, currency)` replaces `pesos`; the zod amount schema that was called `money` is now `moneyAmount`. `receiptTotals` and `applicationPlan` take a trailing `currency = "COP"`.
- Accounting: close-checks `money(value, currency = "COP")` goes through `moneyText`, which fixes the sign (`Intl` wrote `$ -1.000,00`).

## Left for later sub-tasks
- Grid cells (`cell-format.ts`), the PDF totals row and template totals still print company amounts with `$`. Showing a row's own currency there depends on the company / document column twins of 34.4.
