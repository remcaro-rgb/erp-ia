---
tags: [task-34, fx, payments, accounting, posting, migration, ui, decision]
date: 2026-11-09
status: done-uncommitted
---

# Recibos en otra moneda y diferencia en cambio (2B.2 task 34.5)

Part of [[Plan phase-2b-sales-stock-chain]] («Task 34», sub-task 34.5), designed in [[Foreign currency design (2B.2 task 34)]]. Builds on [[Importes de empresa y reglas con dos importes (2B.2 task 34.4)]] and [[Tasas de cambio y TRM (2B.2 task 34.1)]]. Owner items 125 and 126 (a) (provisional accounts); plan rulings R34-5 and R34-6.

## What changed
- **Method currency.** `payments.methods.currency` (migration `0150_payments_foreign_currency.sql`); a trigger fills in the company currency when none is given. A receipt takes its method's currency (`method_currency_mismatch` otherwise). The method form sets it on create only.
- **Allowed pairs (R34-6).** Same currency, or a receipt in pesos against a foreign invoice. Otherwise `currency_mismatch`. A foreign invoice takes no withholdings (`withholding_foreign_currency`). Advance applications keep `currency_not_supported` until 34.6.
- **Allocation amounts.** `amount` (invoice currency), `amount_receipt` (receipt currency, required for pesos against dollars), `amount_company` (pesos at the invoice's rate). The row check is now `amount_receipt = cash_amount + withholding_total`.
- **Realized fx.** For each allocation, fx = cents(amountReceipt × receipt rate) − cents(amountCompany). The allocation that closes an invoice takes whatever pesos are still open, so the receivable clears to the cent. The rule `Recibo de caja` has fx_loss debit and fx_gain credit lines with `amount: "0"` (pesos only) and dimension `fx_kind:realized`. A line whose company amount is 0 is dropped, so a peso receipt posts exactly as before.
- **Accounts.** fx_gain → 421020 and fx_loss → 530525 «Diferencia en cambio» (Colombia pack, provisional). `0151_payments_rules_currency.sql` adds them, with their mappings, to charts seeded before it, and rewrites unedited rule copies. An edited copy is kept, and the R34-5 recommendation points at it.
- **Reversal currency.** `accounting.entry.reverse` and the auto-reversal now copy `currency` as well as `exchange_rate`. A void of a USD receipt reverses in USD.
- **Screen.** «Registrar pago» follows the method's currency: an optional rate (empty means the rate table's), a «Recibido (COP)» column with the implied rate for a dollar invoice paid in pesos, and no withholdings on foreign invoices. `open_invoices` takes `currency` and returns `openDoc`.

## Decisions and lessons
- `payments.allocated_amounts` (published to invoicing) keeps its signature. The pesos come from a new `payments.allocated_company_amounts`, restricted to payments processes. Changing a published function's result columns broke the 0110/0111 replay test ("cannot change return type"), and it is a breaking change for consumers.
- Test harnesses that run `accounting.chart.seed` must sync the accounting manifest. Without it, the R34-5 recommendation writer refuses on a fresh DB, because `kernel.registered_processes` has no accounting processes. This was latent since 34.4. Fixed in the payments, invoicing, chain, costing, sales and posting-mode harnesses.
