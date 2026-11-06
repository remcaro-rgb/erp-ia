# ERP-IA Phase 2B: Sales and stock chain (quote → ledger) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Enforcement (owner order, 2026-10-28):** every implementer and reviewer reads `docs/project-rules.md` and the design sections the task touches before starting, and the brief given to any subagent says: "Read `docs/project-rules.md` and the design sections for X before starting; follow the plan task verbatim." Work that passes its tests but breaks a rule or deviates from the design is rejected. A task that would need a deviation stops and reports; the fix is an owner decision in the main design §22, never a workaround.
>
> **Draft status (2026-11-04):** written straight from the roadmap and main design §8 / §8.1 at the owner's word, for review. There is no module-level design for 2B yet. The owner took OD-2, OD-5, OD-6, OD-7 and OD-8 on 2026-11-04 (see "Decisions taken"); this plan applies them. The owner approved the plan and prototype on 2026-11-04 and the decisions are recorded in main design §22.25 and the roadmap. Do not execute until the owner orders it.
>
> **Subphase split (OD-8):** lots and serials, commissions, and picking/packing/put-away are deferred to subphase **2B.2** (Part G). This plan (2B.1) covers one warehouse model without lots/serials, the full quote-to-cash chain, and no commissions.

**Goal:** In the demo company, a quote becomes an order, a delivery moves stock at weighted-average cost, a DIAN-valid electronic invoice is issued and accepted, a customer receipt settles it, and every step lands in the ledger from the manifest posting rules, audited on one causal chain (main design §8.1; roadmap phase 2 exit criteria).

**Architecture:** Six new modules (`crm`, `sales`, `inventory`, `costing`, `invoicing`, `payments`), each a manifest with its own schema, typed entities (maestro / documento, phase 2A.5), processes through `runProcess`, published views and outbox events; none writes another module's tables (rule 3). Fiscal logic (taxes, withholdings, DIAN resolutions, UBL, CUFE, signature) is the Colombia pack's second part, ported from Serena's `src/lib/dian`; the transport sits behind an `EInvoiceTransport` seam with a mock for CI. Each module's `postingRules` are the 2A fixtures relocated unchanged; accounting consumes them, so no module names accounting.

**Tech Stack:** as phase 2A (TypeScript, Next.js 16, Supabase Postgres, Zod 4, Workflow DevKit, `@react-pdf/renderer`, Vitest, Playwright) plus `xml-crypto`/`xmldom` equivalents already used by Serena's signer.

**Spec:** `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (§5.4–5.8b, §5.17, §8, §8.1, §9, §18a, §22.17, §22.22, §22.23), `docs/superpowers/specs/2026-10-28-accounting-module-design.md` (§4.12, §5.2, §5.4, §5.5, §8), `docs/superpowers/specs/2026-11-02-entity-types-design.md` (all). Visual contract: `docs/superpowers/specs/2026-11-04-erp-ia-prototype-2b-sales-chain.html` (quote → payment on shell v7, invoice creation mode, DIAN trail, annulment by credit note, ledger entries, causal chain). Roadmap: phase 2, item 2B. Serena sources: `/Volumes/SATECHI2TB/Serena/serena-app/src/lib/dian/*`, `docs/superpowers/specs/2026-04-05-dian-invoicing-design.md`.

## Scope and sub-plans

2B is five subsystems. Each part below ships working, tested software on its own and can be reviewed and merged separately; the parts run in the order of the table.

| Part | Content | Tasks | Depends on |
|---|---|---|---|
| A | Foundations: manifest posting rules, Colombia pack part 2 (taxes, withholdings, resolutions), DIAN port | 1–5 | 2A, 2A.5 |
| B | Inventory and costing (weighted average, landed costs) | 6–10 | A |
| C | CRM and sales (quotes, orders, deliveries, returns) | 11–14 | A, B (reservations, deliveries) |
| D | Invoicing and DIAN | 16–20 | A, C |
| E | Payments and the chain | 21–24 | D |
| F | Close: assistant, KPIs, demo, guides | 25–27 | all |
| G | **2B.2 (deferred, OD-8):** lots and serials, picking/packing/put-away, commissions with CxP provision | 28–30 | 2B.1 |

## Global Constraints

- Migrations forward-only from `0056`, `NNNN_<module>_<topic>.sql`, each covered by an integration test (rule 34). One schema per module: `crm`, `sales`, `inventory`, `costing`, `invoicing`, `payments` (rule 3); no foreign key across schemas; cross-module reads only through views the owner publishes.
- Every table: `id uuid` v7, `company_id`, audit columns, `seq` from `core.next_seq`, `extra`, `extra_free`; `kernel.enable_company_rls()` and `kernel.enable_row_audit()` (rules 7, 12, 16). Money `numeric(18,4)` with document currency, company currency and the exchange-rate snapshot (rule 8).
- Every entity declares `maestro`, `documento`, `lines`, `parametro` or `sistema`; documentos declare `contabiliza` / `requiere_aprobacion`, numbering, import (header + lines through `ref`), export, PDF default templates and the four menu sections (entity types spec §2, §9.2). `check:rules` stays green.
- Every state change is a registered process; the assistant gets no tool outside the registry; writes only behind confirmation cards that list the module effects (`effectsFor`, accounting design §5.1) (rules 1, 17).
- A party or product with `invoice_ready = false` is refused on every document line of quote, order, delivery and invoice (rule 10, main §5.17), with the reasons in the error.
- Fiscal logic only in `packages/localization/co` (rule 5). DIAN certificates and provider keys in Vault (rule 12). No Vercel-only APIs (rule 6); durable work only through `DurableRunner`.
- Posting is mandatory and in the same transaction as the lifecycle action for `contabiliza` documentos (entity types D8). Event-driven postings go through the 2A engine; a failure becomes a `posting_failure`, never a lost event.
- Money `$ 1.234.567,00`; Spanish copy through `packages/i18n` with an `en` mirror; each module's page copy in its own namespace (`sales.*`, `inventory.*`, … rule 24).
- Step-up processes: `invoicing.invoice.void`, `inventory.adjustment.post`, `invoicing.settings.update` (resolution and certificate), `payments.payment.void`. The admin may raise others.
- Test first (rule 31); no commit or push unless the owner asks (rule 33); a feature without its guide in `docs/user-guide/es-419` is not finished (rule 35). Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Stock never goes negative or double-moves.** Two deliveries of the last unit at once, a redelivered `sales.delivery.shipped`, and a delivery voided after invoicing must leave on-hand = receipts − issues exactly, one movement per delivery line (Tasks 6, 13, 24).
2. **An invoice is never issued twice or lost.** A resubmitted `invoice.issue`, a DIAN timeout after submission, a rejected document and a Workflow retry leave exactly one invoice number, one CUFE, one status trail and no gap in the resolution range except by an explicit void (Tasks 16, 18, 19).
3. **Numbers follow the law.** The DIAN resolution's prefix, range and validity: issuing past the range or after the validity date is refused with the resolution's data; a voided invoice keeps its number; credit notes use their own sequence (Tasks 3, 16).
4. **Taxes and withholdings add up to the cent.** Per-line rounding, IVA 19/5/0/excluido, INC, mixed lines, free samples and withholdings suffered reproduce the totals the DIAN validator and the ledger both accept; ledger debit = credit for every shape (Tasks 2, 16, 22).
5. **One causal chain, nothing out of order.** Confirming an order, delivering, invoicing and paying produce entries whose chain id is the originator's, dated by their own documents; a delivery in a closed period fails as `closed_period` without moving stock, and reopening then retrying posts once (Tasks 14, 23, 25).

---

## Part A · Foundations

### Task 1: Posting rules move into the module manifests

**Files:**
- Modify: `packages/modules/accounting/src/rules/defaults.ts` (keeps only rules no 2B module owns), `packages/kernel/src/module/define.ts` (`postingRules` already validated), the chart-seed process of accounting that installs per-company rules
- Test: `packages/modules/accounting/src/__tests__/posting-rules-sync.integration.test.ts`

**Interfaces:**
- Produces: `accounting.posting_rule.sync` (create, normal, not raisable) installs, per company, the `postingRules` of every module enabled for it, additive and never overwriting `is_modified` rules; `chart.seed` calls it; `kernel.module.enable` of a 2B module triggers it through the outbox event `kernel.module.enabled`.

- [ ] **Step 1: Failing integration test** — a company with `invoicing` enabled gets the three invoicing rules after `sync`; a second run changes nothing; a rule the admin modified keeps its template; a disabled module's rules are inactive, not deleted.
- [ ] **Step 2–4:** FAIL → implement `sync` over the registry's manifests → PASS; the seven 2A fixtures stay as tests' payload samples.
- [ ] **Step 5: Commit** `feat(accounting): module manifests ship posting rules`.

### Task 2: Colombia pack · taxes and withholdings engine

**Files:**
- Create: `packages/localization/co/src/taxes/{iva.ts,inc.ts,withholdings.ts,compute.ts,index.ts}`
- Modify: `packages/kernel/src/localization/country-pack.ts` (`CountryPack.taxes`), `packages/localization/co/src/index.ts`
- Test: `packages/localization/co/src/__tests__/taxes.test.ts`

**Interfaces:**
- Produces: `computeTaxes(input: { lines: TaxLineInput[]; party: PartyTaxProfile; date: string }): TaxedDocument` with per-line `{ base, ivaRate, iva, incRate, inc, otherTaxes[] }`, document totals and `withholdingsSuffered: { code: "RTEFTE"|"RTEIVA"|"RTEICA"; rate; base; amount }[]` (informational: recognised at payment, accounting design §5.4); `ROUNDING = "per_line_half_up_2"` pinned by the Serena `amounts.ts` tests.

- [ ] **Step 1: Tests** — IVA 19 / 5 / 0 / `EXC` lines; a line with INC 8; free sample (base from reference price, payable 0); mixed document total; withholding thresholds by UVT of the document date (table in the pack); rounding case `3 × 33,3333`; excluded product yields no tax line.
- [ ] **Step 2–4:** FAIL → implement reading rates from the product's `iva_rate`/`inc_rate`/`other_taxes` and the party's responsibilities → PASS.
- [ ] **Step 5: Commit** `feat(co): taxes and withholdings engine`.

### Task 3: Colombia pack · DIAN resolutions and sequences

**Files:**
- Create: `packages/localization/co/src/einvoice/resolution.ts`, `supabase/migrations/0056_core_document_resolutions.sql` (`core.document_sequences.resolution` gets a validated shape and a `core.next_document_number(type)` function)
- Test: `packages/localization/co/src/__tests__/resolution.test.ts`, `packages/modules/core/src/__tests__/document-number.integration.test.ts`

**Interfaces:**
- Produces: `Resolution = { number: string; prefix: string; from: number; to: number; validFrom: string; validTo: string; technicalKey: string }`; `nextInvoiceNumber(tx, companyId, type: "invoice"|"credit_note"|"debit_note", issuedAt): Promise<{ prefix; number; full }>` locking the row; refuses `out_of_range` and `expired` with the resolution's data.

- [ ] **Step 1: Failing tests** — range end, validity end, concurrent callers (two transactions) get distinct consecutive numbers, credit notes draw from their own sequence.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(co): DIAN resolutions and invoice numbering`.

### Task 4: DIAN port · UBL 2.1, CUFE, amounts

**Files:**
- Create: `packages/localization/co/src/einvoice/{amounts.ts,cufe.ts,nit.ts,xml-builder.ts,constants.ts}` ported from Serena `src/lib/dian/` with their tests
- Test: `packages/localization/co/src/__tests__/{cufe,xml-builder,amounts}.test.ts`

**Interfaces:**
- Produces: `buildInvoiceXml(doc: EInvoiceDocument): string`, `buildNoteXml(doc: EInvoiceNote): string`, `computeCufe(doc): string`, `EInvoiceDocument` mapped from `TaxedDocument` + party + company (Anexo FE 1.9 fields of main §5.8a/§5.8b). Ported tests keep Serena's fixtures; adds a test per product `id_scheme`.

- [ ] **Step 1–4:** port tests first (they fail on missing modules), port the code adapting types to the pack's party/product shapes, PASS. **Step 5: Commit** `feat(co): UBL 2.1 builder and CUFE`.

### Task 5: DIAN port · signing, transport seam and certificates

**Files:**
- Create: `packages/localization/co/src/einvoice/{signer.ts,ws-security.ts,soap-client.ts,certificate.ts}`, `packages/infra/src/einvoice-transport.ts` (interface + `MockEInvoiceTransport` from Serena `mock.ts`), Vault access through the existing secrets seam
- Test: `packages/localization/co/src/__tests__/signer.test.ts`, `packages/infra/src/__tests__/einvoice-transport.test.ts`

**Interfaces:**
- Produces: `EInvoiceTransport { submit(signedXml, meta): Promise<{ trackId; status: "accepted"|"rejected"|"pending"; errors: string[]; applicationResponse?: string }>; poll(trackId): Promise<…> }`; `signInvoice(xml, cert): string`; the Docker stack and CI use the mock, the hosted demo the DIAN habilitación endpoint behind the same interface (call made, §19 "Left to the builder": direct submission first, provider later).

- [ ] **Step 1–4:** failing signature-verification test (signed output verifies against the cert), transport contract test run against the mock (accepted, rejected with errors, pending then accepted), implement → PASS.
- [ ] **Step 5: Commit** `feat(co): DIAN signing and transport seam`.

---

## Part B · Inventory and costing

### Task 6: Inventory module · warehouses, stock and movements (no lots or serials: OD-8)

**Files:**
- Create: `packages/modules/inventory/**` (manifest, entities, processes, views), `supabase/migrations/0057_inventory_core.sql`
- Test: `packages/modules/inventory/src/__tests__/{movement,stock-level}.integration.test.ts`, `…/entities.test.ts`

**Interfaces:**
- Entities: `inventory.warehouse`, `inventory.location` (maestros), `inventory.movement` (documento, `contabiliza` false, numbering `on_save`) with lines `inventory.movement_line(product_id, location_id, qty signed, uom)`. The line and stock tables keep nullable `lot_id` / `serial_id` columns unused until 2B.2 so that task needs no rewrite.
- Produces: process `inventory.movement.post` (event-callable, origin `ui|event|agent`) writing `inventory.stock_levels` (on-hand per product/location) in one transaction under `select … for update`; refuses stock < 0 unless the warehouse allows backorders (`negative_stock_refused`); a service product is refused (`kind=service`); emits `inventory.movement.posted { movementId, kind, lines[], date }`; view `inventory.v_stock(company_id, product_id, warehouse_id, location_id, on_hand, reserved, available)` published for sales; `inventory.reservation.create / release { sourceEntity, sourceLineId, productId, warehouseId, qty }` (event-callable; refuses over-reservation beyond `available`), used by Task 13.

- [ ] **Step 1: Failing tests** — receipt then issue leaves the right on-hand; two concurrent issues of the last unit: one succeeds, one `negative_stock_refused`; `track_stock=false` product moves nothing; redelivered event posts one movement (idempotency key = source line id).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(inventory): warehouses, stock levels and movement posting`.

### Task 7: Transfers, adjustments and counts

**Files:**
- Create: `packages/modules/inventory/src/processes/{transfer,adjustment,count}.ts`, `supabase/migrations/0058_inventory_transfers_counts.sql`
- Test: matching integration tests

**Interfaces:**
- `inventory.transfer.create/ship/receive` (two movements, in-transit location), `inventory.adjustment.post` (**step-up**, kind `adjustment`, requires a reason; emits `inventory.movement.posted` kind `adjustment` for the 2A rule `inventory-adjustment`), `inventory.count.create/record/apply` (applying a count creates the adjustment).

- [ ] **Step 1–4:** failing tests (transfer in transit visible; adjustment without step-up refused; count difference posts one adjustment with the right sign; ledger entry via the engine on the demo chart) → implement → PASS. **Step 5: Commit** `feat(inventory): transfers, adjustments and counts`.

### Task 8: Costing · weighted average and COGS

**Files:**
- Create: `packages/modules/costing/**`, `supabase/migrations/0059_costing_core.sql`
- Test: `packages/modules/costing/src/__tests__/{average,cogs}.integration.test.ts`

**Interfaces:**
- Consumes: `inventory.movement.posted`. Entities: `costing.cost_layer` (sistema; per product/warehouse: qty, avg cost), `costing.cost_event` (sistema).
- Produces: consumer recomputes the moving average on receipts (qty-weighted), values issues at the current average, and for `kind: "sale_issue"` emits `costing.cogs.posted { movementId, sourceRef, lines[{ productId, categoryId, qty, unitCost, amount }], date, costCenterId? }`, which the 2A rule `cogs-posted` posts (Dr cogs / Cr inventory). Products without cost: the issue posts at 0 and raises a `costing.cost_missing` recommendation row (main §5.8b: a missing cost never affects `invoice_ready`).

- [ ] **Step 1: Tests** — receipts 10@100 and 10@120 → average 110; issue 5 → COGS 550; issue after another receipt; negative-cost refused; a returned unit re-enters at the original issue cost; missing cost flagged.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(costing): weighted average cost and COGS`.

### Task 9: Costing · landed costs (FIFO moves to phase 3: OD-5)

**Files:**
- Create: `packages/modules/costing/src/processes/landed-cost.ts`, `supabase/migrations/0060_costing_landed.sql`
- Test: matching integration test

**Interfaces:**
- `costing.landed_cost.allocate { movementId, amount, basis: "value"|"quantity"|"weight" }` (documento, `contabiliza` true: Dr inventory / Cr the offset role the user names). `costing.settings` carries `method: "average"` as the only accepted value; the column and the cost-layer table are shaped so the phase 3 FIFO adds a method without a data migration.

- [ ] **Step 1–4:** failing tests (allocation by value raises the layer's average and the sum of line increments equals the amount to the cent; allocation by quantity and by weight; `method: "fifo"` is refused with "disponible en la fase 3") → implement → PASS. **Step 5: Commit** `feat(costing): landed costs`.

### Task 10: Inventory pages (picking, packing and put-away deferred to 2B.2: OD-8)

**Files:**
- Create: `apps/web/src/app/(app)/inventory/**` pages (Existencias, Movimientos de inventario, Conteos, Transferencias), menu with the four sections (entity types §9.2)
- Test: `apps/web/e2e/inventory.spec.ts`

- [ ] **Step 1: Failing e2e** — create a warehouse and a receipt in the UI, see the stock grid with the receipt; a transfer shows in transit then received; a count applies an adjustment behind step-up; the movement record has the Contabilidad tab for adjustments.
- [ ] **Step 2–4:** FAIL → implement → PASS (page copy under `inventory.*`, user guide `inventario.md`). **Step 5: Commit** `feat(inventory): stock pages`.

---

## Part C · CRM and sales

### Task 11: CRM · leads, opportunities, pipelines, activities

**Files:**
- Create: `packages/modules/crm/**`, `supabase/migrations/0062_crm_core.sql`
- Test: `packages/modules/crm/src/__tests__/{lead,opportunity}.integration.test.ts`

**Interfaces:**
- Maestros `crm.lead`, `crm.pipeline` (+ `crm.stage` lines), documentos `crm.opportunity`, `crm.activity` (sistema). Processes `crm.lead.create/update/convert` (creates a `core.party` through the core create process, so DIAN validation applies, and an opportunity), `crm.opportunity.stage_move`, `crm.activity.create`. Consumes `sales.order.confirmed` (opportunity won) and `invoicing.invoice.paid` (activity logged).

- [ ] **Step 1–4:** failing tests (convert creates a party with `dian_status` missing, not `invoice_ready`; stage move audited; won on order confirmed) → implement → PASS. **Step 5: Commit** `feat(crm): leads, pipelines and opportunities`.

### Task 12: Sales · price resolution and quotes

**Files:**
- Create: `packages/modules/sales/**` (manifest, `price.ts`), `packages/modules/crm/src/entities/quote.ts` (quotes are CRM per main §8), `supabase/migrations/0063_sales_quotes.sql`
- Test: `packages/modules/sales/src/__tests__/price.test.ts`, `packages/modules/crm/src/__tests__/quote.integration.test.ts`

**Interfaces:**
- `resolveLinePrice(ctx, { productId, partyId, qty, date }): Promise<{ unitPrice; priceListId?; discountPct }>` (party price list → default → product `list_price`); `crm.quote` documento (`contabiliza` false, `requiere_aprobacion` by discount threshold setting) with lines; `crm.quote.create/update/send/accept/expire`; `accept` emits `crm.quote.accepted`. Line gate: product and party `invoice_ready` (reasons in the error); totals through `computeTaxes` (Task 2).

- [ ] **Step 1–4:** failing tests (price list beats list price; non-ready product refused with reasons; discount over threshold needs approval; accepted quote locks its lines; Imprimir uses the seeded template) → implement → PASS. **Step 5: Commit** `feat(crm): quotes with price lists and taxes`.

### Task 13: Sales orders and stock reservation

**Files:**
- Create: `packages/modules/sales/src/{entities,processes}/order*.ts`, `supabase/migrations/0064_sales_orders.sql`
- Test: `packages/modules/sales/src/__tests__/order.integration.test.ts`

**Interfaces:**
- `sales.order` documento (numbering `on_save`; `requiere_aprobacion` by credit-limit or discount setting) with lines; `sales.order.create/update/confirm/cancel`; `confirm` (the §8.1 step 1–2) reserves stock through `inventory.reservation.create` via event, never directly, and emits `sales.order.confirmed { orderId, lines[], customer, dates }`; a quote converts with `sales.order.from_quote`.

- [ ] **Step 1–4:** failing tests (confirm emits one event; a credit-limit breach goes to Pendiente; cancel releases reservations; replay of confirm with the same key answers the first result; `from_quote` copies prices, not live lookups) → implement → PASS. **Step 5: Commit** `feat(sales): orders and reservations`.

### Task 14: Deliveries and returns

**Files:**
- Create: `packages/modules/sales/src/processes/{delivery,return}.ts`, `supabase/migrations/0065_sales_deliveries.sql`
- Test: `packages/modules/sales/src/__tests__/delivery.integration.test.ts`

**Interfaces:**
- `sales.delivery` documento (lines reference order lines; partial deliveries allowed), `sales.delivery.ship` emits `sales.delivery.shipped { deliveryId, orderId, lines[], date }`, consumed by inventory (`movement.post`, kind `sale_issue`) which feeds costing (Task 8); `sales.return.create/receive` emits `sales.return.received` (stock back at the original cost). Void of a delivery reverses its movement (and cost) only if no invoice references it.

- [ ] **Step 1–4:** failing tests (partial then final delivery; over-delivery refused; shipped event produces one issue movement and one COGS entry in the delivery's period; delivery in a closed period: the stock movement still posts, its COGS entry is recorded as a `closed_period` posting failure, and `period.reopen` + `posting.retry` posts it once) → implement → PASS. **Step 5: Commit** `feat(sales): deliveries and returns`.

### Task 15: (moved to 2B.2 as Task 30, OD-8)

Commissions are not part of 2B.1. Migration `0066` stays free for the next task that needs it.

---

## Part D · Invoicing and DIAN

### Task 16: Invoices, taxes and the issue process

**Files:**
- Create: `packages/modules/invoicing/**`, `supabase/migrations/0067_invoicing_core.sql`
- Test: `packages/modules/invoicing/src/__tests__/{invoice,issue}.integration.test.ts`

**Interfaces:**
- `invoicing.invoice` documento (`contabiliza` true, numbering `on_save` by resolution through `nextInvoiceNumber`, payment form/means, due date) with `invoice_line` and `invoice_tax` lines; `invoicing.invoice.create/update/issue/void`; `issue` runs `beforeInvoiceIssue` (pack: party/product `invoice_ready`, DIAN totals via `computeTaxes`), assigns the number and CUFE, sets state `issued` pending DIAN acceptance (sub-status `dian_status: draft|submitted|accepted|rejected`), and emits `invoicing.invoice.issued` whose payload matches the `invoice-issued` fixture; `void` is **step-up**, allowed only when DIAN-accepted invoices have a credit note path (OD-7), otherwise before submission.
- **Invoice creation is parametric (OD-2).** `invoicing.settings.invoice_creation: "manual" | "on_delivery" | "on_order_confirmation"`, default `manual`, changed through `invoicing.settings.update` (step-up). `manual`: invoicing only flags delivered lines "por facturar" and the user runs `invoicing.invoice.from_orders { orderIds }`. `on_delivery`: a consumer of `sales.delivery.shipped` creates the invoice for exactly the shipped lines and issues it. `on_order_confirmation`: a consumer of `sales.order.confirmed` does so for the whole order (services and non-stock goods; a stock good is invoiced at confirmation anyway, the delivery then only moves stock). In the automatic modes a non-ready customer or product leaves the draft invoice in `draft` with a recommendation row instead of failing the order or the delivery. The consumers call the same `invoice.create` / `issue` processes, so audit, readiness and DIAN rules are identical.
- **Voiding is a credit note (OD-7).** `invoicing.invoice.void` (step-up) on an invoice of Colombian origin that already has a number does not edit it: it issues a full credit note with the DIAN annulment concept (Task 18) and marks the invoice `voided` only once the DIAN accepts the note; the number is never reused. Before a number is assigned (state `draft`) the invoice is simply deleted under the entity-types Eliminar rule.

- [ ] **Step 1: Failing tests** — issue produces one number/CUFE; reissue with the same key answers the stored result; non-ready customer refused with reasons; fixtures round-trip: the issued payload posts balanced through the engine on the demo chart; void of an issued invoice creates exactly one annulment credit note and the invoice stays `issued` until the DIAN accepts it; each of the three `invoice_creation` values yields exactly one invoice for a two-delivery order (partial deliveries invoice only what shipped in `on_delivery`; `manual` invoices nothing until asked); a non-ready customer under `on_delivery` leaves a draft and a recommendation, the delivery still ships.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(invoicing): invoices and the issue process`.

### Task 17: E-invoice workflow (sign, submit, poll, store)

**Files:**
- Create: `packages/modules/invoicing/src/workflows/einvoice.workflow.ts`, `supabase/migrations/0068_invoicing_einvoice.sql` (`invoicing.einvoice_submission`, sistema)
- Test: `packages/modules/invoicing/src/__tests__/einvoice-workflow.integration.test.ts`

**Interfaces:**
- Consumes: `invoicing.invoice.issued`. Workflow steps: build XML → sign → `EInvoiceTransport.submit` → poll until `accepted|rejected` (backoff, `FatalError` after the limit) → store XML, ApplicationResponse, CUFE and PDF in `FileStore` → process `invoicing.invoice.dian_result` sets `dian_status` and emits `invoicing.invoice.accepted` or `.rejected`.

- [ ] **Step 1–4:** failing tests on the mock transport (accepted; rejected with errors surfaced on the invoice; timeout after submit retries by `trackId` and never resubmits; redelivered event creates one submission) → implement → PASS. **Step 5: Commit** `feat(invoicing): DIAN submission workflow`.

### Task 18: Credit and debit notes

**Files:**
- Create: `packages/modules/invoicing/src/{entities,processes}/note*.ts`, `supabase/migrations/0069_invoicing_notes.sql`
- Test: `packages/modules/invoicing/src/__tests__/note.integration.test.ts`

**Interfaces:**
- `invoicing.note` documento (`kind: credit|debit`, reason from the DIAN concept tables 13.2.4 / 13.2.5, reference to an issued invoice); `invoicing.note.issue` emits `invoicing.note.issued` (fixtures `note-issued`), flows through the same workflow with `buildNoteXml`; a credit note cannot exceed the invoice's remaining value; a note dated in a later month against an older invoice posts in its own month (accounting §5.5). Credit and debit notes never adjust each other (DIAN Oficio 129/2023): a note may reference only an invoice.
- **Annulment (DIAN, Resolución 165/2023, Anexo Técnico 1.9):** `invoicing.invoice.void` issues a credit note whose `cac:DiscrepancyResponse/cbc:ResponseCode` is the annulment concept (code `2` of table 13.2.4) and whose `cbc:CustomizationID` is `20` (rule CAD02a: with the annulment concept the operation type must be `20`, a note that references the invoice); it carries the invoice's CUFE in `BillingReference`. The annulled invoice's number is not reusable.
- **Export invoices (international sale, `InvoiceTypeCode 02`):** the same mechanism applies. The note is a credit note with `cbc:CreditNoteTypeCode = "02"` (the annex applies to it the export validation set, e.g. the buyer's `PartyTaxScheme` group, as for the invoice), in the invoice's currency with the TRM (`PaymentExchangeRate`) and the reference to the export CUFE; foreign buyers carry no Colombian address. The note must be authorized under the same numbering resolution family the company has for notes. Customs side (DEX/declaración de exportación, DIAN Muisca) is outside electronic invoicing and outside this plan. **Open point:** the exact values of tables 13.2.4 and 13.1.5.2 live in the DIAN toolbox spreadsheet (not in the annex text); Task 18's first step downloads `Caja_de_herramientas_Factura_Electronica_Validacion_Previa.zip` into `packages/localization/co/src/einvoice/tables/` and pins the codes in tests before the builder is finished.

- [ ] **Step 1: Failing tests** — a credit note referencing an invoice of 2026-10-30, dated 2026-11-01, posts in November; credit above remaining value refused; a note referencing a note refused; annulment note XML carries `ResponseCode 2`, `CustomizationID 20` and the invoice CUFE (golden file); an export invoice in USD annulled by a note with `CreditNoteTypeCode 02`, same currency and the invoice's TRM; foreign-buyer export passes the pack validation without a Colombian address.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(invoicing): credit and debit notes, annulment and export notes`.

### Task 19: Invoice PDF, QR and the Parámetros of invoicing

**Files:**
- Create: `packages/modules/invoicing/src/pdf/invoice-template.ts`, Parámetros pages (resolution, certificate upload to Vault, habilitación/producción switch, auto-invoice setting)
- Test: `packages/modules/invoicing/src/__tests__/pdf.test.ts`, `apps/web/e2e/invoicing-parametros.spec.ts`

**Interfaces:**
- Default `kernel.doc_templates` for the invoice (record scope) with CUFE, QR payload and resolution legend printed from the pack; `invoicing.settings.update` **step-up**.

- [ ] **Step 1–4:** failing tests (QR payload matches the DIAN format; legend shows number range and validity; non-admin cannot open Parámetros) → implement → PASS. **Step 5: Commit** `feat(invoicing): invoice PDF and settings`.

### Task 20: Invoicing pages

**Files:**
- Create: `apps/web/src/app/(app)/invoicing/**` (Facturas grid, record with the DIAN status chip and its error list, "Reintentar envío", Notas, Por facturar), copy under `invoicing.*`
- Test: `apps/web/e2e/invoicing.spec.ts`

- [ ] **Step 1: Failing e2e** — create an invoice from a delivered order, issue it, see Aceptada (mock), print the PDF, issue a credit note, see both in the ledger tab (Contabilidad). **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(invoicing): invoice pages`.

---

## Part E · Payments and the chain

### Task 21: Payments · receipts, methods, cash boxes

**Files:**
- Create: `packages/modules/payments/**`, `supabase/migrations/0070_payments_core.sql`
- Test: `packages/modules/payments/src/__tests__/receipt.integration.test.ts`

**Interfaces:**
- Maestros `payments.method`, `payments.cash_box`; documento `payments.receipt` (`contabiliza` true) with `receipt_allocation` lines `(invoice_id, amount, withholding[])`; `payments.payment.receive` emits `payments.received` (fixture `payment-received`: Dr cash/bank per method dimension, Cr receivable, Dr withholdings suffered with code/rate/base); `payments.payment.void` is **step-up** and emits `payments.payment.voided`.

- [ ] **Step 1–4:** failing tests (allocation cannot exceed the open amount; one receipt over several invoices; withholdings reduce the cash but settle the receivable fully; unallocated remainder becomes `customer_advances`; void reverses) → implement → PASS. **Step 5: Commit** `feat(payments): customer receipts and allocations`.

### Task 22: Open items from allocations

**Files:**
- Create: `supabase/migrations/0071_accounting_open_items_from_allocations.sql` (replaces the FIFO computation of `accounting.v_open_items` for companies with `payments` enabled)
- Test: `packages/modules/accounting/src/__tests__/open-items-allocations.integration.test.ts`

- [ ] **Step 1–4:** failing tests (aging report equals the sum of allocations; a company without payments keeps the FIFO view; both agree on the demo ledger) → implement → PASS. **Step 5: Commit** `feat(accounting): open items follow payment allocations`.

### Task 23: Paid status and the end-to-end chain

**Files:**
- Create: `packages/modules/invoicing/src/consumers/payments.ts`, `packages/modules/sales/src/__tests__/chain.integration.test.ts`
- Test: that file

**Interfaces:**
- Invoicing consumes `payments.received` / `.voided` and sets `paid_amount`, state `paid`, emitting `invoicing.invoice.paid`.

- [ ] **Step 1: Failing chain test** (§8.1): quote → accept → order → confirm → deliver → invoice → mock-accept → receipt, run once under each `invoice_creation` value. Assert: one chain id across every process run and event; entries in Ventas (invoice), Notas (COGS), Recibos de caja; trial balance balanced; stock and average cost correct; opportunity won; `what happened when order N was confirmed` answered from the audit by chain id.
- [ ] **Step 2–4:** FAIL → fix wiring → PASS. **Step 5: Commit** `test: quote-to-ledger chain`.

### Task 24: Failure paths of the chain

**Files:**
- Test: `packages/modules/sales/src/__tests__/chain-failures.integration.test.ts`

- [ ] **Step 1–3:** failing tests then fixes for: delivery in a closed period (posting failure recorded, `period.reopen` + `posting.retry` posts once); DIAN rejection then corrected resubmission with the same number rules; concurrent delivery vs second order on the last unit; an annulled invoice (credit note) whose DIAN acceptance arrives after a retry; module `payments` disabled (events parked, then drained on enable); company without accounting (events parked).
- [ ] **Step 4: Commit** `test: chain failure paths`.

---

## Part F · Close

### Task 25: Assistant tools, effects and evals

**Files:**
- Modify: `packages/agent` evals set; each module's `postingProvider`-facing `effectsFor` copy
- Test: `packages/agent/src/__tests__/evals.test.ts` (structural + mock), nightly model run unchanged

- [ ] **Step 1:** add Spanish prompts → expected calls: «cotiza 10 café a Distribuidora X» (`crm.quote.create`), «confirma el pedido 12», «factura lo entregado», «registra el pago de la factura FE-1234» (each ends in a confirmation card listing effects: "Inventario", "Facturación DIAN", "Contabilidad: asiento en Ventas"); refuses a non-ready customer; refuses `invoice.void` without step-up code. **Step 2–4:** FAIL → registry/effects → PASS. **Step 5: Commit** `feat(agent): sales tools and evals`.

### Task 26: KPIs, menus, entitlements and demo data

**Files:**
- Create: each module's `home.ts` KPIs (Por cobrar, Por facturar, Pedidos abiertos, Stock bajo mínimo, Pipeline), features `crm.*`, `sales.*`, `inventory.*`, `invoicing.*`, `payments.*`, demo seed for Café del Norte (products with stock, price list, customers `invoice_ready`, a resolution in habilitación, one full chain posted)
- Test: `apps/web/e2e/sales-chain.spec.ts`, `apps/web/e2e/accounting-smoke.spec.ts` (preconditions unchanged)

- [ ] **Step 1: Failing e2e** — log in as the demo admin; run quote → payment in the UI; home KPIs show the figures; Información exógena and the aging report include the sale; export XML downloads.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat: 2B demo data, KPIs and chain e2e`.

### Task 27: User guides, rules, roadmap and hand-off

**Files:**
- Create: `docs/user-guide/es-419/{ventas,cotizaciones,inventario,costos,facturacion-electronica,pagos}.md` with screenshots (`pnpm --filter web guide:shots`); update `navegacion.md`, `terceros.md`, `productos.md`, `contabilidad/informes.md`
- Modify: `docs/roadmap.md` (2B done), `docs/project-rules.md` only if an owner decision changed a rule

- [ ] **Step 1:** guides indexed by the help chunker. **Step 2: Full gate** — `pnpm lint && pnpm typecheck && pnpm check:rules && pnpm test && pnpm test:integration && pnpm --filter web e2e && pnpm build`; CI green on push (owner's word). **Step 3: Commit** `docs: phase 2B guides and roadmap`.

## Order and parallelism

1 → (2 ∥ 3 ∥ 4) → 5. Part B after 1: 6 → (7 ∥ 8) → 9 → 10. Part C after 2 and 6: 11 ∥ 12 → 13 → 14 (needs 8). Part D after 2–5 and 13: 16 → 17 → 18 → (19 ∥ 20). Part E after 16: 21 → 22 → 23 → 24. Part F last: 25 → 26 → 27. Part G (2B.2) after 2B.1 closes: 28 ∥ 29 → 30. Parts B and D (16–18) can run in parallel worktrees after Task 5; they share only `packages/i18n/messages/*.json` and the `apps/web` navigation (serialise those merges).

## Part G · Subphase 2B.2 (deferred, OD-8)

Outlined here so 2B.1 leaves the seams; each task is detailed and approved when 2B.1 closes.

### Task 28: Lots and serials
`inventory.lot`, `inventory.serial` maestros; the nullable `lot_id` / `serial_id` columns of Task 6 become used; expiry-aware issue (FEFO as a per-product rule), serial quantity ±1, lot/serial on delivery and invoice lines (DIAN lot data), traceability report. Tests: serial issued twice refused; FEFO picks the earliest expiry; a recall query lists every delivery of a lot.

### Task 29: Picking, packing and put-away
`warehouse` module: `warehouse.pick.create` from `sales.order.confirmed`, `pick.confirm` (emits `warehouse.pick.confirmed`, feeds the delivery), packing lists, `putaway.suggest` by product category. Tests as the old Task 10.

### Task 30: Commissions with a CxP provision (OD-6)
- `sales.commission_plan` (maestro: percentage by category or flat, payee), `sales.commission` (documento, **`contabiliza` true**).
- **Basis is parametric:** `sales.settings.commission_basis: "on_collection" | "on_invoice"`. Accrual happens on `invoicing.invoice.paid` (pro rata on partial payments) or on `invoicing.invoice.issued`.
- **Accounting:** the accrual posts a provision: Dr commission expense (`commission_expense`, cost center of the sale) / Cr commissions payable (`commissions_payable`, party = the payee, a payable line that enters aging as CxP). New roles are declared by the sales manifest in `accountRoles`; the Colombia pack must map both (suggested PUC: 5205 gastos de personal / 5235 servicios for external agents, and 2335 costos y gastos por pagar or 2380 acreedores varios; the pack chooses by payee type). The rule ships as the module's `postingRules` entry for `sales.commission.accrued`, with `sales.commission.reversed` through `reverseOf`.
- Reversal: a voided receipt (collection basis) or an annulment credit note (invoice basis) reverses the unpaid accrual; a paid commission is not reversed automatically but flagged for the user. Paying the commission belongs to the phase 3 disbursements.
- Tests: accrual shapes under both bases, partial payments, annulment, the provision appears in the aging payable report for the payee, ledger balanced.

### Task 31: Document link table and trail (owner decision 2026-11-06, design §22.27)
- Kernel or core table `document_links` (company, from entity and id, to entity and id, link kind, creating chain id, `seq`, RLS per rule 12), written by the processes that create links: quote→order, order→delivery, delivery→invoice, invoice→receipt allocation. Many-to-many.
- Read side: a published view or consult process that walks the links upstream and downstream from a record to a depth limit (default 6) with a size cap, masked per rule 14; the record frame gains a «Documentos relacionados» section, each entry a link (rule 21).
- Backfill: one forward-only migration fills the table for existing 2B.1 data from the payload ids and the allocation tables.
- Tests first: many-to-many cases (one quote to two orders, two orders in one delivery, one invoice from two deliveries, one receipt over two invoices), depth and size caps, masking, backfill on the demo company.
- The per-action chain id is unchanged.

## Decisions taken (owner, 2026-11-04)

- **OD-2** invoice creation is parametric: `manual` (default) | `on_delivery` | `on_order_confirmation` (Task 16).
- **OD-5** FIFO moves to phase 3; 2B ships weighted average only (Task 9; roadmap phase 3 gains "FIFO costing").
- **OD-6** commission basis is parametric (`on_collection` | `on_invoice`) and accrues an accounting entry as a CxP provision (Task 30, in 2B.2).
- **OD-7** an issued invoice is annulled by a credit note with the annulment concept for invoices issued in Colombia; export invoices follow the same mechanism with `CreditNoteTypeCode 02` (Task 18; research below).
- **OD-8** lots/serials, picking/packing/put-away and commissions are deferred to 2B.2 (Part G).
- **Not answered, plan proceeds on the recommendation (say if otherwise):** OD-1 direct DIAN submission behind `EInvoiceTransport`; OD-3 negative stock refused by default with a per-warehouse backorder switch; OD-4 a delivery in a closed period moves stock and leaves its COGS entry as a retryable posting failure.

### DIAN research for OD-7 (international invoices)

Sources: DIAN Resolución 000165 de 2023, Anexo Técnico 1.9 (read directly: CAD02a, CreditNoteTypeCode "02", PaymentExchangeRate/TRM); Resolución 000008 de 2024 (adoption of 1.9); DIAN Oficio 129/2023 and Concepto 126/2025 (credit note is the annulment mechanism, the number cannot be reused, notes do not adjust notes). Findings: (1) annulment of an issued electronic invoice is always a credit note, never an edit or deletion; (2) with the annulment concept (code 2 of table 13.2.4) the note's `CustomizationID` must be `20`; (3) the annex gives credit notes of export operations `CreditNoteTypeCode = "02"` and applies the export validations to them; (4) an export invoice carries currency and TRM, the note must keep them; (5) the customs declaration is a separate Muisca process. **Not confirmed from the text:** the exact code lists (tables 13.2.4, 13.1.5.2 live in the DIAN toolbox spreadsheet) and any export-specific term for submitting a note after the invoice's acceptance; Task 18 pins them from the toolbox, and a written DIAN opinion or the habilitación test set should confirm them before production.

## Calls I made (check these)

- Quotes live in `crm` (design §8 table), orders/deliveries/returns in `sales`, locations in `inventory`; the `warehouse` module arrives in 2B.2.
- The chain emits the same event ids as the 2A fixtures, so no posting rule changes shape.
- A delivery posts stock and COGS even if its period is closed for the ledger (OD-4 default).
- DIAN: direct submission to habilitación/producción behind `EInvoiceTransport` (OD-1 default); a technology provider is a second implementation of the same seam.
- Numbering as entity types D9: invoices by DIAN resolution on save; movements, orders, quotes by company sequence.
- Reservations are an inventory process driven by the order event (Task 13), never a cross-module write.

## Self-review

- **Roadmap coverage.** CRM → 11, 12; sales (orders, deliveries, returns) → 13–14, commissions → 30 (2B.2); invoicing with DIAN, `invoice_ready` on every line → 16–20 (gates in 12, 13, 14, 16); inventory/costing → 6–10, warehouse picking and lots/serials → 28–29 (2B.2); payments (receipts, allocations, cash boxes) → 21–22; Colombia pack part 2 (taxes, withholdings, sequences and resolutions; exógena/ fiscal reports consume `v_tax_lines`) → 2, 3, 26; assistant tools and home KPIs → 25, 26; exit criterion chain → 23.
- **Not pulled in:** purchases, bank reconciliation, supplier-side withholdings (phase 3), POS (phase 5), opening balances and connectors (2C).
- **Type consistency.** `computeTaxes` / `TaxedDocument` (Task 2) are the inputs of 12, 16, 18 and the XML builder (4); `nextInvoiceNumber` (3) is called only by 16 and 18; `EInvoiceTransport` (5) only by 17; the events `inventory.movement.posted`, `costing.cogs.posted`, `invoicing.invoice.issued`, `invoicing.note.issued`, `payments.received`, `payments.payment.voided` are exactly the ids of the 2A fixtures.
- **Open risks.** Tasks 5 and 17 depend on DIAN habilitación credentials the owner must supply; migration numbers shift if other work lands first; exact file paths inside new modules follow the 2A module layout and may be adjusted by the implementer without changing interfaces.
- **Effort (rough).** A 2–3 days · B 3–4 · C 4–5 · D 5–6 · E 3 · F 2–3 (≈ 4–5 weeks of agent time with review).
