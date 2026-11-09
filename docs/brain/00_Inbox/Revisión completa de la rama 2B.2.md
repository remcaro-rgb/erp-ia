---
tags: [review, phase-2b, 2b2, kernel, accounting, payments, invoicing, sales, security, decision]
date: 2026-11-09
status: fixes-committed
---

# Revisión completa de la rama 2B.2

Whole-branch review of `phase-2b-sales-chain`, range `5d36bb9..dabefc7` (Tasks 31–33, 35–44, 46–48, 50–53), for [[Plan phase-2b-sales-stock-chain]]. Six parallel slice reviewers (kernel, posting and ledger, invoicing and DIAN, sales and inventory, web and UI, data and migrations) checked [[Project Rules]], the owner lines of [[Plan phase-2b-owner-decisions-pending]] (items 1–110), security, correctness, tests and docs. Follows [[Ref tolerante a módulo no cargado y semilla de FE-1015 (task 53)]] and [[Revisiones de la tanda 2B.2 (task 52)]].

## Outcome
- 1 Critical, 12 Important, 29 Minor. Findings and rulings are in the git-ignored SDD workspace (`wbr-merged.md`).
- **Critical, fixed:** in [[Modo de contabilización (2B.2 task 33)]]'s asynchronous mode, a void whose reversal hit a closed period became a pending with no rule, which could never be retried. The reversal pending now carries its rule, and `accounting.posting.retry` re-runs the reversal once the period is reopened.
- **Important, fixed (test first):**
  - A record-rights refusal inside a «continuar y encolar» nested run now propagates instead of being queued ([[Nested runs configurable (2B.2 task 32)]]).
  - `payments.payment.open_invoices` and `payments.advance.apply` apply field visibility inside the process (rule 14; this supersedes ruling R40-2).
  - «Recalcular precios» refuses a foreign-currency draft.
  - The pedido credit line needs the all-orders permission.
  - The Task 40 guard now covers the credit views, with a per-view marker.
  - Catalogue keys added for the advance processes on the posting-mode card.
  - Strict-mode badge wording fixed in the guides.
  - Re-seeding a pre-Task-53 demo no longer annuls FE-1015 twice.
- **Re-review:** all 10 fixed findings addressed. It found one new Important: the credit fix broke `e2e/sales.spec.ts`, now fixed and green on a production build. It also found 9 new Minor, listed only.
- **Owner items 111–119** (not fixed): never-bought posting module skipped silently (9b vs 52); Inventario ⇄ Costos disable deadlock; item 57 not recorded as decided; rule 8 on advance applications; handler RLS `not_found` in nested runs; ratify the guard list, the process-level masking and the reprice refusal; five minor decisions (returns vs owner isolation, approver writes, re-reserve cap, producción notes, parked-module mark).

## Lessons
- A file-level guard («the file calls some visibility helper») cannot prove a specific gate exists; pin the gate per view.
- Masking enforced only in a web helper leaves the process channel open; put the check in the process.
- Changing an event name for the same business fact breaks name-keyed idempotency of the seed.
