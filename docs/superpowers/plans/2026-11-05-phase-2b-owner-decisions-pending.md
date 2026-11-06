# Phase 2B.1 · Owner decisions pending (to record in design §22)

Date: 2026-11-05 · Source: the 2B.1 run ledger `.superpowers/sdd/2026-11-03-phase-2b-sales-stock-chain/progress.md` (every `Ruling`, `Owner`, `OWNER` line) and the task reports next to it · Plan: `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`.

This file lists what the 2B.1 implementation decided or met that the design does not yet say. Nothing here is recorded in the design (`docs/superpowers/specs/2026-10-26-erp-ia-design.md` §22 is the owner's) and no rule in `docs/project-rules.md` was changed. Each item gives what was built, then a one-line **recommended §22 wording**. The owner ratifies it (it becomes the next §22 item, dated), or orders a change (it becomes a task). Items marked **Decide** need a choice before 2B.2. The rest record what is already shipped.

Housekeeping: §22 has two items numbered 25 (plantillas de comprobante, 2026-11-03; phase 2B decisions, 2026-11-04). The next item should be 26, and the duplicate should be renumbered.

## A. Kernel additions (rule 1, rule 3, rule 4 and design §5)

1. **Nested process runs (`ctx.runProcess`).** Task 11. A handler may run another registered process in the same transaction and causal chain: the nested run checks its own permission, refuses a nested step-up, and is limited to depth 4. It replaced a direct call to another handler (CRM lead conversion → `core.party.create`).
   Recommended: «A process may run another registered process inside its own transaction through `ctx.runProcess` (same chain and audit, own permission check, no nested step-up, depth ≤ 4); calling another process's handler directly is never allowed.»
2. **`nestedOnlyFrom`.** Task 18. A process may declare that it runs only nested in named parent processes (for example `invoicing.note.issue_annulment` from `invoicing.invoice.void`). It skips the role check (the matrix cannot grant it), and the parent's role and step-up cover it. The assistant never gets it. **Decide** (rule 13 and rule 15 review).
   Recommended: «A process declared `nestedOnlyFrom: [parents]` runs only inside those parents' runs; its permission is the parent's (no own role grant, no own step-up), and no UI, assistant, API or scheduler origin can start it.»
3. **`ModuleDef.effects`.** Task 25. A module declares, by event name only, the side effects its consumers produce (for example «Inventario: reserva existencias», «Costo de ventas»). Confirmation cards show them without one module naming another. Design §5.1 names only `PostingProvider.effectsFor`.
   Recommended: «Manifests may declare `effects` keyed by event name (with `effectsFor(payload)`); the confirmation card lists the effects of every module subscribed to the events the write emits.»
4. **`ModuleDef.printTemplates`.** Task 12. A module ships default PDF templates for its documentos (quote, order, delivery, invoice, receipt).
   Recommended: «Manifests may ship default print templates for their entities; a company template marked default overrides them.»
5. **Inline strict posting (`emitAndPostStrict`).** Task 9, reused by Tasks 16, 18 and 21. A documento that contabiliza (landed cost, invoice and note issue, cash receipt) writes its event to the outbox and posts it through the `PostingProvider` in the same transaction. A ledger refusal rolls the whole action back. The asynchronous consumer finds the entry already posted and does nothing. When accounting is off, the action succeeds and the event parks until accounting is enabled. A ledger that was never started is refused. An event dated before the ledger start is skipped. The entity-types design §5.2 says contabiliza documents post through the outbox consumer, which contradicts this and D8. **Decide** (rule 3 exception wording).
   Recommended: «A documento that contabiliza posts inline: `emitAndPostStrict` writes the event and posts its rules through the company's `PostingProvider` in the action's transaction (refusal rolls back; the consumer is then a no-op). This is the one sanctioned synchronous cross-module effect (rule 3 exception). The entity-types design §5.2 is amended to match.»
   Security note: inline posting acts as the system admin user, the same as the engine.
6. **`when` on posting-rule templates.** Task 7. A `RuleTemplate` may carry a condition on the payload (`equals`, `in`, `notEquals`), so that the 2A default `inventory-adjustment` rule fires only for `kind = adjustment` and not on every movement.
   Recommended: «A posting rule may carry a `when` condition on event payload fields (equals / in / notEquals); a rule whose condition fails produces no entry and no posting failure.»
7. **Assistant dry-run preflight and refusal scrubbing.** Task 25. Before a confirmation card is offered for a write that is not step-up (2A writes included), the write is dry-run as the caller. A run that would fail is not offered, and the refusal goes back to the model. Refusal messages are scrubbed by default-deny with an allowlist, so a refusal cannot leak unmasked data. Cost: the handler runs twice, and a denial in the dry run writes a `denied` audit row. Hooks: `onDryRunEvents`, `effectsFor(payload)`.
   Recommended: «The assistant offers a write card only after a dry run of the write as the caller succeeds; dry-run refusals reach the model only through an allowlist of codes and safe parameters (default deny).»
8. **One causal chain per user action, with links through payload ids.** Task 23. The plan's exit line says «one chain id across every process run and event». What was built is one chain per user action: the quote acceptance, the order confirmation, the delivery, the invoice issue and the receipt each start their own chain. Each step links to the one before it through ids in the event payload, and there is no causation column. The automatic invoice on order confirmation shares the confirmation's chain (confirm → invoice → DIAN). A DIAN resubmission runs on the resubmit action's chain. **Decide**: ratify, or order a kernel root-chain change (`rootChainId` in payloads or causation columns).
   Recommended (ratify): «The causal chain is per user action; a business flow across actions (quote → order → delivery → invoice → payment) is followed through the document links carried in event payloads. The phase 2 exit criterion "one causal chain" reads this way.»
9. **Module gating: never bought vs switched off.** Task 24. The dispatcher gates only on `enabled = false`. A consumer of a module the company never bought dead-letters `not_entitled` or skips. The inline poster treats a module that was never bought as switched off. **Decide**.
   Recommended: «A module the company never bought behaves as switched off everywhere: its consumers are skipped (not dead-lettered) and its posting parks; one entitlement resolver serves the dispatcher and inline posting.» (Then fix the code and the `inline.ts` comment.)
10. **Kernel `PostingProvider.post` may return `entryId: null`** (Task 14) for a skipped post (before ledger start, disabled rule). Outbox payload indexes were added in migration 0090.
   Recommended: «`PostingProvider.post` returns `{ entryId: null }` when the event is legitimately not posted; callers treat null as "nothing to reverse", never as success of a post.»

## B. Deviations from the 2A accounting module (accounting design)

11. **`provider.reverse` became `accounting.posting.reverse_source`.** Task 14. Reversing a voided source also dismisses its pending posting failures, and a tombstone table `accounting.voided_sources` stops a late event of a voided source from posting.
    Recommended: «Voiding a source reverses its entries through `accounting.posting.reverse_source`, which also dismisses its pending failures and records the source in `accounting.voided_sources` so no later delivery posts it.»
12. **The note rule is split in three.** Task 18. The single 2A credit/debit note rule became three rules: annulment credit note, partial credit note and debit note. The default rules are now nine. A company whose admin modified the old note rule keeps it, and the split rules arrive disabled for review (migration 0098).
    Recommended: «The invoicing note postings are three default rules (annulment, partial credit, debit); companies with a modified 2A note rule keep it and get the new rules disabled.»
13. **The cash receipt rule changed.** Task 21. The cash account is chosen by payment method kind through role `cash` with dimension `payment_method:<kind>`. An anticipos line (280505) was added. An admin-modified 2A receipt rule without that line refuses a receipt with an advance as unbalanced.
    Recommended: «The receipt rule maps cash by payment method kind and credits customer advances (280505) for any unapplied amount.»
14. **The `cogs-posted` rule source is the inventory movement.** Task 8. The source changed to `inventory.movement` / `$.movementId`, so the entry links to a record (rule 21). The cogs-posted and inventory-adjustment rules still live in the 2A defaults and should move to the owning manifests (costing, inventory).
    Recommended: «The COGS entry's source is the sale-issue inventory movement; each module's default rules live in its own manifest.»
15. **No `invoicing.invoice.voided` rule.** Task 16. The annulment credit note posts the reversal, so the 2A invoice-voided default is not shipped.
    Recommended: «An issued invoice is reversed in the ledger only by its annulment credit note; there is no separate invoice-voided posting.»
16. **Withholdings suffered are not customer items in the aging when Pagos is on.** Task 22. In allocations mode, accounts mapped to a `withholding_*_suffered` role (for example 135515) are left out of the receivable items. FIFO mode (Pagos off) still shows them in the customer's row.
    Recommended: «With payments enabled, withholding-suffered accounts are not customer receivable items in the aging; without payments the FIFO aging is unchanged.»

## C. Invoicing, DIAN and the Colombia pack

17. **`issue_date` is the company's today at «Emitir».** Task 16. At issue, the date becomes today in the company's time zone, and the invoice is re-priced and re-taxed on that date. The Borrador's date moves to `service_date` («Fecha de entrega o servicio»). A cash invoice falls due today. A credit invoice keeps its term, counted from today. Notes are dated the company's today too (Task 18).
    Recommended: «An invoice or note takes the company's today as issue date at «Emitir» (DIAN numbering follows dates); the draft date is kept as service date.»
18. **Free-sample IVA is excluded from the document tax total** (Task 2). To be confirmed against the DIAN validator.
19. **Foreign-currency invoices.** Task 17 refused them in the XML builder (`currency_not_supported`, COP only). Task 18 added CUFE parity and a resubmit sweep for invoices already issued in a foreign currency. Payments accept COP only (Task 21). **Decide** whether foreign currency is in scope for 2B.
    Recommended: «2B issues and collects in COP; foreign-currency invoicing and collection (with company-currency columns, rule 8) arrive in a later phase.»
20. **Unconfirmed DIAN items.** Mock transport only (ruling of Tasks 5/17). None of these is verified against habilitación. The production guard refuses `produccion` until `dian_defaults_confirmed` is set (Task 19).
    - National CreditNoteTypeCode `91`; CustomizationID `10` for export invoices and notes (the DIAN v1.9 example uses `04`/`11`); no export DebitNoteTypeCode; no `InvoiceControl` extension on notes; notes reuse a resolution-shaped sequence row.
    - The third element of SoftwareSecurityCode is the document number (Serena used the NIT); no `sts:QRCode` in the DianExtensions (Anexo 1.8+ may require it).
    - Signature canonicalization as written (Serena); the status code map (00 / 66 / 90 / 98 / 99), and whether code 90 means "never received"; GetStatus with the CUFE as trackId; resend of a rejected document with the same number and CUFE; async test set ZipKey loss → `submission_in_doubt`; the poll backoff (20 polls, ≈ 2.5 h).
    - Free-sample `TaxTotal` and `AlternativeConditionPrice`; per-unit other taxes (`PerUnitAmount` / `BaseUnitMeasure`); `TaxExclusiveAmount` with excluded lines and ZZ.
    - Payment means is a subset of table 13.3.4.2 (1, 10, 20, 42, 47, 48, 49, 71, ZZZ); foreign buyer IDs are reduced to digits; export detection is customer country ≠ company country.
    - The issuer fiscal profile (O-13 / R-99-PN, tax scheme 01 / ZZ, DANE) is checked only by the builder.
    - `DurableRunner.status` on the Vercel and Postgres Worlds (tested only on the in-process World).
    - UVT 2023 / 2024 values from memory (unused); other-tax tariff tables (bolsas, ICL, IBUA, ICUI, carbono) are not loaded.
    Recommended: «Before producción, every item of the 2B DIAN unconfirmed list is verified in habilitación and `dian_defaults_confirmed` is set by an admin; until then companies run habilitación only.»
21. **Accounting mappings to confirm with the accountant.** INC and the other consumption taxes post to **249505 «Impuesto nacional al consumo»** (Task 16, migration 0094). Payment method kinds: cash and check → 110505, transfer and card → 111005, other → unmapped (refused) (Task 21). The annulment revenue reversal goes to the `note_reason` mapping, falling back to 413595, not to the original line's category account (Task 18). Advances go to 280505, and retención en la fuente suffered to 135515.
    Recommended: «The Colombia pack's default mappings for INC (249505), payment kinds (110505 / 111005), note revenue (413595) and advances (280505) are confirmed by the company's accountant and editable in Mapeo de cuentas.»
22. **Withholdings on receipts are not validated against the pack's tables** (Task 21). Only base × rate within $ 0,50, and not above the allocation, is checked. A kind the company maps itself is not consulted by payments.
    Recommended: «Receipt withholdings are checked for arithmetic only in 2B; validation of concept, rate and threshold against the pack arrives with the withholding tables.»
23. **Only DIAN-accepted invoices are payable** (Task 21). An invoice with an annulment note in progress is not payable.
24. **The resolution registry is a core process** (`core.document_sequence.register`, Task 19), because core owns `core.document_sequences`. The technical key moved to `core.document_resolution_keys` (admin-only), and replaced resolutions are kept as history. Open: `resubmit_failed` is not admin-guarded; old audit rows that contain the key are hidden by policy, not rewritten (append-only); the QR environment follows the company's current environment and is not frozen on the invoice.
25. **Vault.** Certificate and PIN live in Supabase Vault (rule 12) behind a `SecretStore`. Real DIAN transports refuse to build without an injected store (no environment fallback). The Vault write cannot join the process transaction: it is done last, and the next upload or send reconciles a narrow failure (Task 19).
    Recommended: «DIAN certificates and PINs are written to Vault after the settings transaction commits; a mismatch is reconciled on the next upload or send.»
26. **Auto-create refusals answer `skipped`** (Task 16). No recommendation row is written when no draft exists, because the kernel has no "raise recommendation" API. OD-2 asked for a recommendation. **Decide** whether to add a kernel recommendation API (also wanted for costing's `cost_missing`).
27. **Partial notes do not change `invoiced_qty`** (Task 18). Only the full annulment returns deliveries to «por facturar». A voided invoice keeps `status = posted`, and only `stage` becomes `voided`.

## D. Security and visibility (rules 13, 14)

28. **Approvers see pending quotes they do not own** (Task 12, migration 0083). The approval queue is the reason. **Decide**.
    Recommended: «A user who may run `crm.quote.approve` sees every quote that requires approval, whoever owns it.»
29. **Orders have no salesperson owner isolation** (Task 13). Quotes and opportunities have it. Every user with order read access sees every order under the record rules. **Decide**.
30. **Unmasked published views** (rule 14 exception by design). They are security_invoker, so RLS and record rules apply, but field masking does not: `crm.v_quote_offers` / `crm.v_quote_offer_lines` (Task 13), `sales.v_invoice_order_lines` (Task 16), `invoicing.v_receivable_invoices` and `payments.v_invoice_allocations` (Task 21). `payments.payment.open_invoices` reads the unmasked receivables for the «Registrar pago» screen, and is excluded from the assistant (Task 25). **Decide**: accept as a module-to-module exception, or mask the screen path.
    Recommended: «Views a module publishes for another module's processes are unmasked but RLS-bound; no screen or assistant output reads them directly.» (This needs the Registrar pago screen to move to masked reads.)
31. **The invoicing settings page is admin-only, enforced in processes** (Task 19). Inventory reads `costing.average_costs()` without declaring costing (documented in the inventory manifest).

## E. Product decisions and prototype deviations

32. **Quotes stay at `/crm/quotes`** (CRM › Documentos). The prototype shows them under Ventas (Task 14b).
33. **«Remisión» is named «Entrega»** (prefix `ENT-`), following the prototype wording (Task 14b). Carrier and tracking fields and Notificar on deliveries are not built.
34. **A voided delivery does not re-reserve stock** for its order (Task 14).
35. **CRM module dependency direction:** crm depends on sales, and sales must not depend on crm (Task 12). The two directions talk only through published views and events (rule 3).
36. **Costing's `cost_missing` is costing's own table** (Task 8). `kernel.recommendations` is agent-shaped and service-role only. Uncosted units enter at 0 and dilute later averages. This is deliberate and is corrected by an adjustment.
37. **Landed costs restate nothing already issued** (Task 9). A void removes exactly what was added. Weight basis has no product field, so the request gives the line weights, and the screen offers value and quantity.

## F. Data and environment

38. **Exógena on the demo company.** Format 1007's XML cannot be generated on the demo, because a 2A sample line (NC-18 on 421005) has no tercero (Task 26). Fixing it means editing the 2A demo data. **Decide** (owner OK needed).
39. **Demo seed gaps** (Task 26): no price list is seeded; the resolution is registered with origin `ui`; there is no certificate or PIN (`not_configured`; the mock accepts); the dev database was never reset with the full chain. Task 27 replayed the migration chain 0001..latest on a scratch database (see the Task 27 report), but not `db:reset` + `DEMO_SEED=1 pnpm db:seed` from scratch.
40. **The worker** (`apps/worker/src/modules.ts`) now loads the same ten modules as the web runtime, and a test keeps the two lists equal (Tasks 14 and 16). There is nothing to decide. The note is here so the worker image is rebuilt with the 2B modules before the hosted outbox runs on it.
41. **Local migration tracking.** `supabase migration up` fails at 0061 on the local stack (its tracking is behind), so migrations 0061–0114 were applied with psql. A fresh `db reset` applies them in order. The hosted project must be migrated with the CLI on a clean history.
