---
tags: [project, sales, commissions, accounting, posting, phase-2b]
date: 2026-11-10
status: built-uncommitted
---

# Commission reversals (2B.2 task 30.3)

Sub-task 30.3 of [[Part G design (2B.2 tasks 28-30)]], after [[Commission accrual and posting (2B.2 task 30.2)]]. Modules: [[Module sales]], [[Module accounting]]. Rules: [[Project Rules]] (RG-11, RG-12; rules 1, 3, 24, 35). No migration (0156 had the columns).

## What was built
- `sales.commission.reverse` (update, origins event + ui, input `{ commissionId, reason }`, output `{ commissionId, reversed, refused? }`): stage `reversed`, each base's `reversed += line amount`, emits `sales.commission.reversed` (rule reverseOf the accrual) through `postOrPend`. Already reversed → answers `reversed: true`, writes nothing. Paid → raises recommendation reason `commission_paid_reversal` (audience `sales.commission.reverse`, one open per commission) and answers `refused: "commission_paid"` (an answer, not an error, so the recommendation is kept and the event does not fail).
- `sales.commission.adjust_for_note` (update, origins event; key `annul:<invoice>` or `note:<note>`): annulment → nested reverse of every posted/paid commission of the invoice, bases `closed`; partial credit note → base −= note subtotal per `invoiceLineId`, commission recomputed at the frozen rate; what was accrued beyond the new commission (net of reversals) goes back in a COM- of `source_kind note` with negative lines (linked `note_to_commission`).
- Consumers: `invoicing.note.issued` (credit notes only), `payments.payment.voided`, `payments.advance.unapplied` (one reverse run per commission of that source); `onInvoiceAnnulled` (delivery.ts) runs the reversal as a second run after `record_invoiced`.
- Fix in the accrual: `remaining = commission − (accrued − reversed)`; the 30.2 text `commission − accrued − reversed` would count a voided receipt's reversal twice.
- Tests: `sales/src/__tests__/commission-reversal.integration.test.ts` (8); async case in `accounting/src/__tests__/posting-mode.integration.test.ts`.
- Guide: `ventas.md` § «Cuándo se revierte una comisión».

## Decisions (owner items 181–185)
See `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md` section Y.
