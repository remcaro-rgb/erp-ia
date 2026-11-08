---
tags: [project, feature, payments, accounting, phase-2b]
date: 2026-11-07
status: implemented-uncommitted
---

# Aplicar anticipo a factura (2B.2 task 36)

Plan: [[Plan phase-2b-sales-stock-chain]] (Task 36). Owner items 88 to 91: [[Plan phase-2b-owner-decisions-pending]]. Rules: [[Project Rules]]. Related: [[Roadmap]], [[Modules]], [[Migrations Catalog]].

## What it is
An advance (the part of a receipt not applied, Cr 280505) can now be applied later to the customer's invoices. One application is a documento `payments.advance_application` (AP-n) with lines (advance receipt, invoice, amount): many to many, partial or several invoices. It posts inline and strict (Dr customer_advances / Cr receivable, rule `Aplicación de anticipo`), and `payments.advance.undo` («Deshacer aplicación», step-up) voids it and reverses the entry. Anular recibo is refused while a live application draws on it.

## Decisions worth remembering
- Both balances are derived: `payments.advance_applied_amounts` (advance left) and `payments.allocated_amounts` / `ledger_allocations` (invoice open and open items) count posted applications; migration 0138 widens `accounting.open_items_allocated` to the new source. Invoicing's `refreshPaid` is untouched: it runs from the new events `payments.advance.applied` and `unapplied`.
- Link kinds are `invoice_to_application` and `receipt_to_application`: the kernel kind pattern `^[a-z]+_to_[a-z]+$` refuses an underscore inside a word (the brief's names would need a kernel change).
- The screen: the «Anticipos» section lives on the receipt's page (the customer's page belongs to core, owner item 90). The consult `payments.advance.open` and its web loader answer `forbidden` when a field is masked (rule 14), never blanked figures.
- Existing companies need the two new default rules through the posting-rule sync (owner item 91).
- «Registrar pago» shows the owner's DIAN hint once when a listed invoice has reasonCode `invoice_not_accepted`.

## Where
Backend: `packages/modules/payments/src/processes/advance.ts`, migrations 0137 and 0138. Web: `apps/web/src/lib/payments/{record,actions,advances}.ts`, `apps/web/src/app/(app)/payments/advance-applications/page.tsx`, `payments-view.tsx`. UI: `packages/ui/src/payments/{AdvanceApplyPanel.tsx,advance-apply-model.ts}`. Guide: `docs/user-guide/es-419/pagos.md`. Tests: `advance.integration.test.ts` (payments and web), `apps/web/e2e/payments-advance.spec.ts`.
