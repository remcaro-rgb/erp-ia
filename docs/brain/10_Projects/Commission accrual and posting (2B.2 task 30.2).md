---
tags: [project, sales, commissions, accounting, posting, migration, phase-2b]
date: 2026-11-10
status: built-uncommitted
---

# Commission accrual and posting (2B.2 task 30.2)

Sub-task 30.2 of [[Part G design (2B.2 tasks 28-30)]], after [[Commission plans and bases (2B.2 task 30.1)]]. Modules: [[Module sales]], [[Module accounting]]. Rules: [[Project Rules]] (RG-11, RG-13; rules 1, 5, 10, 34).

## What was built
- Process `sales.commission.accrue` (kind create, origins event; `processes/commission.ts`): input `{ source: "invoice", invoiceId } | { source: "receipt", paymentId, allocations } | { source: "advance", applicationId, allocations }`, output `{ commissionIds }`. One COM- documento per payee and plan of a source, its lines per base, `due_date = date + plan.payment_days`, linked `invoice_to_commission` or `receipt_to_commission`; numbered and posted by the typed lifecycle (`runLifecycle … "save"`, the post hook).
- Amounts in integer cents (BigInt, half away from zero): on_invoice accrues `commission − accrued`; on_collection per base `openAfterDoc ≤ 0 ? remaining : remaining × settled / (settled + openAfterDoc)`, so the last collection closes the base to the cent.
- Consumers in the sales manifest: `sales.commission.due` (on_invoice only), `payments.received`, `payments.advance.applied`; effect «Contabilidad: provisión de comisiones».
- Rules `sales/src/rules/commission-accrued.json` and `commission-reversed.json` (journal NC; Dr `commission_expense` per line with cost center, Cr `commissions_payable` with the payee party and due date, dimension `payee_kind:{{payeeKind}}`), twins in `accounting/src/rules/defaults/`, fixture `accounting/src/rules/fixtures/commission-accrued.json`.
- Colombia pack: mappings employee 520518 / 250505, agent (and no dimension) 523595 / 233520; extra accounts 520518 and 523595; 233520 and 250505 flagged invoice-ready. Provisional, owner items 159–161.
- Migration `0157_sales_commission_accounts.sql`: accounts where the parent exists, the flags, the six mappings for companies with mappings, the two rules for companies with sales entitled and on.
- Guides: `ventas.md` § «Cuándo se causa la comisión y cómo se contabiliza», `contabilidad/reglas-contables.md` § «Reglas de comisiones».

## Decisions taken while building (owner items 176–180)
- Inline-or-pend: `emitAndPostStrict` in a savepoint; a refused posting emits the event so a pending posting failure keeps it (a strict refusal would fail another module's event).
- `settledDoc` = the allocation amount (withholdings already inside it).
- Grouping by payee and plan; an advance application links `receipt_to_commission`; the accounting twins stay out of `ACCOUNTING_DEFAULT_RULES`.

## Gotchas
- A second worktree running integration tests on the same local database re-syncs `kernel.registered_processes` from older code and drops new processes (the links writer then refuses «not a registered create or update process»): run the suites when no other worktree is testing.
- `apps/web` compiles module code below ES2020: no BigInt literals (`BigInt(0)` constants).
- `core.v_party_readiness` filters by party scope: read it with claims.
