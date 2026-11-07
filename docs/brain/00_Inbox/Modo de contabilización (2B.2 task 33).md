---
tags: [accounting, posting-mode, task-33, decision, web]
date: 2026-11-07
status: in-progress
---

# Modo de contabilización (2B.2 task 33)

Part of [[Plan phase-2b-sales-stock-chain]]; owner decision item 5 of [[Plan phase-2b-owner-decisions-pending]] (2026-11-06) and §22.28 in [[Owner Decisions]]. Module: [[Module accounting]]. Rules read: [[Project Rules]] (1, 3, 4, 14, 15, 24, 35). Stage A (backend) is `task-33-A-report`; this note covers stage B (web, docs, e2e).

## What the owner sees
- **Reglas contables › Mapeo de cuentas** opens on the card «Modo de contabilización»: «Inmediata y estricta (recomendada)» or «Asíncrona con reintentos», a radio group. Choosing the other opens a dialog (the red warning, role `alert`, shows there before choosing asynchronous and stays on the card while it is the mode), then the TOTP through the standard `useAdminAction` step-up. Without `accounting.posting_mode.set` the radios are disabled.
- Two counts under it, in both modes: documents awaiting their entry and failures in the retry queue (link to Pendientes), and the list of documentos the mode applies to, derived from the registry (`inlinePostingProcesses`), named through `accounting.pages.posting.mode.document.*`.
- A badge in the record frame of invoice, note, receipt and landed cost: «Pendiente de contabilizar» (queued), «Contabilización fallida · ver pendientes» (failed, links to `/accounting/posting?tab=pending`), or queued plus the reason «Contabilidad desactivada» / «Módulo contable no contratado» when accounting is switched off or not bought (Task 50.9 gate).

## How it is built
- `apps/web/src/lib/accounting/posting.ts` adds `postingMode` (from `accounting.settings.consult`) and `can.postingMode`; the pure `posting-mode.ts` shapes it (unit-tested).
- `pending.ts` `loadPendingPostings(caller, sourceIds)` reads the view `accounting.v_pending_postings` (new migration `0129`, over stage A's definer function `accounting.pending_postings`, because the web layer reads views only, rule 14) and the posting module's gate (`moduleGate`); the pure `pending-state.ts` maps rows to `queued | failed | dead | parked` (unit-tested). The shared record page `r/[entity]/[id]/page.tsx` is the one frame loader of the four documentos; `PendingPostingBadge` renders it in the frame's chip.
- The e2e helper `test-support/deliver-event.mts` now records the `kernel.outbox_deliveries` row after the consumer, as the dispatch workflow's step does; without it a delivered event would still read as queued.

## Decisions and traps
- Switching never rewrites anything: queued events post under either mode; the counts stay visible after switching back to inline strict.
- The card shows to whoever reads the mapping (R33-9): migration `0129` also publishes `accounting.v_posting_mode` (company_id and posting_mode only, security_invoker), so no other setting is unmasked; counts come from `v_pending_postings` and `v_posting_failures`. Both new views are covered by `posting-mode-views.integration.test.ts` (anon refused, member sees own rows, company B nothing).
- In the e2e stack no worker runs, so events of consumer-posted documents (stock movements) read as «esperan su asiento» until delivered: tests read the count as a difference.
- Guides: [[User Guide]] `reglas-contables.md` (mode, risk, switching), `pendientes-de-contabilizar.md` (awaiting versus failed), one paragraph each in invoicing, payments and costing; entity-types design §5.2 amended (both modes).
