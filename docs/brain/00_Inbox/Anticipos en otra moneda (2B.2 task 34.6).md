---
tags: [task-34, fx, payments, accounting, posting, migration, decision]
date: 2026-11-09
status: done-uncommitted
---

# Anticipos en otra moneda (2B.2 task 34.6)

Part of [[Plan phase-2b-sales-stock-chain]] («Task 34», sub-task 34.6), designed in [[Foreign currency design (2B.2 task 34)]]. Builds on [[Recibos en otra moneda y diferencia en cambio (2B.2 task 34.5)]] and [[Cartera en dos monedas y diferencia en cambio no realizada (2B.2 task 34.7)]]. Owner items 114, 126 (d) and 126 (e): (e) recorded by the owner on 2026-11-09 as proposed, pending the accountant's confirmation.

## Decision applied (item 126 (e))
Revenue covered by an advance stays at the invoice's TRM; the difference against the advance is **realized** exchange difference (not CINIIF 22 at the advance's rate). One posting shape in code; changing it later is a reclassification.

## What changed
- **Migration `0152_payments_advance_applications_currency.sql`** (the number 34.7 left free; it runs before 0153 and reads nothing 0153 creates): drops the `= 'COP'` check for an ISO check; `advance_applications.exchange_rate numeric(18,6)` and `total_company`; `advance_application_lines.advance_company` (pesos at the advance receipt's rate, **added beyond the plan's list** so the draw that empties an advance takes exactly the pesos its receipt credited, rule 8); `advance_applied_amounts` returns `applied_company`; header freeze covers the new columns; unedited copies of «Aplicación de anticipo» rewritten (R34-5); masked views regenerated.
- **`advance.ts`**: one currency per application (the advances'); an invoice in another currency → `currency_mismatch` (was `currency_not_supported`); no more COP-only company check. Per line: `amount_company` at the invoice's carrying rate (`carryingCompany`, exported from `receipt.ts`), `advance_company` at the receipt's rate; `splitCompany` gives the last line the rest. Entry rate = the advances' rate (implied rate if several advances at different rates).
- **Payload / rule** (R34-4): `total`/`totalDoc` (receivable, invoice pesos), `drawn`/`drawnDoc` (customer_advances, advance pesos), `allocations[].amountCompany` and `fx { gain, loss }`, `advances[].amount` (pesos) and `amountDoc`. Rule: Dr customer_advances · Dr fx_loss · Cr receivable · Cr fx_gain (`fx_kind:realized`, amount 0). COP posts byte for byte as before. `advance-unapplied.json` unchanged (reverseOf reverses the fx line too).
- Example: USD 1.000 advance at 4.000 on a USD 1.000 invoice at 4.100 → Dr 280505 4.000.000 · Dr 530525 100.000 · Cr 130505 4.100.000, in USD.
- Advances are not revalued (NIC 21, item 126 (d)): pinned with the 34.7 revaluation run.
- Guide: `docs/user-guide/es-419/pagos.md` «Anticipos en otra moneda».

## Open
- An **edited** old copy of the rule posts `$.total` (invoice pesos) on both sides, so 280505 is off by the fx difference until the admin fixes the rule (the R34-5 recommendation fires). The receipt precedent refuses instead (unbalanced).
- The receipt page's «Anticipos» panel was not touched; money text there for a USD advance is for 34.8 / the UI batch.
