---
tags: [review-fixes, task-52, kernel, outbox, accounting, invoicing, recommendations, scheduler, security, decision]
date: 2026-11-08
status: done-uncommitted
---

# Revisiones de la tanda 2B.2 (task 52)

Part of [[Plan phase-2b-sales-stock-chain]] (section «Expanded task of the review-fixes batch»); owner decisions of 2026-11-08 in [[Plan phase-2b-owner-decisions-pending]] (items 47, 48, 50, 52, 53, 67, 74, 100); design §22.28 in [[Owner Decisions]]; rules in [[Project Rules]]. Modules: [[Module accounting]], [[Module invoicing]], [[Module sales]].

Builds on: [[Nested runs configurable (2B.2 task 32)]] (the failure queue 52.2 looked at), [[Modo de contabilización (2B.2 task 33)]] (the asynchronous mode 52.7 watches), task 38's recommendation API (no note of its own; see [[Plan phase-2b-sales-stock-chain]] «Expanded task of the kernel batch» and [[Costo de unidades sin costo conocido (2B.2 task 44)]], a caller of it), task 39's owner isolation ([[Plan phase-2b-order-owner-isolation]], migration 0141 hides a recommendation whose subject the viewer cannot read), task 50's parked events (no note of its own; migration 0120, see [[Migrations Catalog]]).

## 52.1 Dead-letter keeps the other consumers [47, 52]
- `dispatchOutboxRow` (`packages/kernel/src/events/dispatch.workflow.ts`): on `not_purchased` it remembers the first unbought module and goes on; after the loop: a switched-off module pauses the row (`module_disabled`), else the row dead-letters as `not_entitled:<module>` with `delivered_modules` = every consumer that ran, else it is dispatched. A thrown consumer error still dead-letters at once. No migration.
- **R52-1** run every consumer first, park once at the end. **R52-2** two unbought modules on one event park under the first only (owner item 102).

## 52.2 Sweep isolation [53]
- `drainOutbox` wraps `kernel.parked_events_sweep` in try/catch, logs `outbox: parked-event sweep failed` and keeps draining.
- **R52-3** log only: the failure queue of task 32 lists nested runs and takes no row without one.

## 52.3 System claims guard [100]
- `runProcess` refuses the kernel's system user (`SYSTEM_USER_ID`, any spelling Postgres reads as the nil uuid: `isSystemSub`) unless the origin is `event` or `scheduler`: `forbidden`, `details.reason = system_claims_refused`, one `denied` audit row written on the service connection (counted, not audited, in the assistant's preflight dry run). `withClaims` refuses those claims unless `{ allowSystem: true }`.
- **R52-4** the guard lives in `runProcess` (the origin is known there); `withClaims` gets the optional flag, refusing by default. None of the plan's listed callers (inline posting, typed runner, notify, consumers, seeds, worker) needed the flag: they reach the system user through `runProcess` with origin `event` or through `set_config` inside an open transaction.
- **Defence in depth, not a live hole:** web claims come from a verified Supabase JWT and PostgREST drops forged roles; the guard stops a future server-side mistake from running as company admin. Other system-claims contexts outside `runProcess`: owner item 104.

## 52.4 «Recalcular precios» keeps order-billed lines [50]
- `invoiceReprice`: lines billed from a pedido (`orderLineId`) keep their agreed price; free lines take the list price; `price_date` still today. Copy `reprice_hint` and the guides `facturacion.md`, `facturacion-electronica.md`.

## 52.5 Retire `invoice-voided` [48]
- Migration 0142 retires the unmodified default rule per company (`is_active = false, is_modified = true`, never deleted; a modified copy stays and is named in a `raise notice`), re-runnable; `RETIRED_RULES` in `posting-rule.ts` does the same on sync, so order does not matter. The JSON moved to `rules/fixtures/` for the engine tests (installed as a test-owned rule). The demo seed still emits the event: owner item 106.

## 52.6 Order `quote_id` as a reference [67]: blocked
- The ref reads fine through `crm.v_quotes`, but the kernel's fail-closed `registry.entity()` in `maestroRefs` and import validation throws when crm is not loaded, so `sales.order.create` fails without crm. Left unstarted; owner item 105 (record link would be `/r/crm.quote/<id>`).

## 52.7 Aviso de asientos atrasados [74]
- Migration 0143 `accounting.settings.posting_alert_minutes` (default 60, 5–10080) with its field in Reglas contables › Configuración; migration 0144 adds it to `accounting.v_posting_mode`.
- Process `accounting.posting.age_check` (update, `origins: ["scheduler"]`, the system user) acts on `postingAgePlan`: one `posting_age` recommendation per document waiting longer than N (queued, dead or failed), re-raised only when its state changes, closed once the document no longer waits, everything closed in inline strict mode. A Descartar holds while the document waits in the same state (a dismissed row of that state decided after the document's current `since` blocks the raise; read through `kernel.v_recommendations`, no kernel change, R38-5 untouched).
- **R52-5 as built:** audience `audienceProcess: "accounting.posting.retry"` (0123 requires an audience process; one open row per document cannot fan out per role); owner item 108.
- **R52-6:** the trigger is the outbox tick route; `apps/web/src/lib/server/scheduled-checks.ts` runs after the drain, each in its own try/catch; a company is checked at most once per 60 s and the process runs only when the plan has something to raise or close, so a quiet tick writes no audit row (owner item 107; the Vercel Hobby cron is daily, so the demo can be a day late).
- Other rulings: the document's entity is the posting rule's `source.entity` (event names do not map to entities); the alert's minutes are those of the raise («llevaba N minutos al dar el aviso»).
- Guides: `contabilidad/reglas-contables.md` («El aviso de asientos atrasados», Configuración), `pendientes-de-contabilizar.md`.

## Owner items opened by this task
- 102 two unbought modules on one event (R52-2) · 103 a `not_entitled` consumer refusal parks as a bogus module · 104 system-claims contexts outside the dispatcher · 105 `quote_id` ref blocked · 106 demo seed emits `invoicing.invoice.voided` · 107 audit volume of the age check (fixed; Hobby cron lateness remains) · 108 R52-5 through the audience process · 109 `module.test.ts` fails on `accounting.posting_mode.set` (from task 33).
