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
- **Expanded 2026-11-07: see «Expanded task of the trail batch (Task 31)» below.**

### Tasks 32–50: scope added by the owner's decisions of 2026-11-06 (design §22.28)
Each is detailed and approved when 2B.2 starts (stubs only; source: `2026-11-05-phase-2b-owner-decisions-pending.md`, item numbers in brackets). Test first, per rule 31.
- **32** Configurable nested runs [1]: per pair (parent → nested) «parent TOTP covers it» (default off) and «on failure: roll back all | continue and queue»; continue via savepoint and a visible failure queue (retry, admins and granted roles), never for ledger or stock processes; global depth, default 4, hard max 8.
- **33** Posting mode setting [5]: per company, inline strict (default) or asynchronous with the retry queue; warning in Mapeo de cuentas; amend entity-types §5.2; tests of the asynchronous path.
- **34** Foreign currency [19]: needs its own design section first (XML rate, TRM source, posting at rate, exchange differences, receipts, aging in both currencies).
- **35** DIAN verification checklist [20]: admin ticks each item (who, when, audited); `dian_defaults_confirmed` needs all ticked.
- **36** Aplicar anticipo a factura [23]: new process and screen hint; ledger reclass 280505 to the receivable.
- **37** Resolution and certificate hardening [24, 25]: admin guard on `resubmit_failed`; QR environment frozen on the invoice at issue; DIAN settings warning when the certificate fingerprint and Vault disagree.
- **38** (expanded below) Kernel recommendation API [26, 36]: role-addressed recommendations (title, reason, link, status), one open per document and reason, masked, dismissed by hand; used by auto-invoice refusals and costing.
- **39** Order owner isolation [29]: salesperson sees own orders; «all orders» permission for warehouse, billing, managers; settle owner on quote conversion and inheritance by deliveries and invoices.
- **40** Unmasked-view guard test [30]: fails when a page reads a listed unmasked view without a visibility check.
- **41** Declare inventory's dependency on costing [31].
- **42** «Cotizaciones» shortcut under Ventas from CRM's manifest [32].
- **43** Void delivery offers re-reserve, default yes, only if stock suffices [34].
- **44** Costing setting for units without a known cost: 0 (default) or last known cost [36].
- **45** Landed cost arriving late: sold units' share booked as a COGS adjustment in the current period, void reverses both; accountant confirms the policy first [37].
- **46** Exógena demo fix: tercero on the NC-18 line, rerun 2A tests, e2e downloads the real 1007 XML [38].
- **47** Demo seed: price list, resolution with origin `seed`, `db:reset` plus `DEMO_SEED=1 pnpm db:seed` from zero, rerun the e2e [39].
- **48** Worker startup module-list check [40].
- **49** Hosted migration pre-check, CLI dry run, local tracking repair [41].
- **50** Small fixes batch: test that every subscribed event has an effect line [3]; warning for a `when` rule that never matched [6]; dry-run denials not audited, counted as telemetry (needs rule 16 wording) [7]; never-bought modules visible, one entitlement resolver, inline poster aligned [9]; move cogs-posted and inventory-adjustment rules into their own manifests [14]; «Recalcular precios» action, Emitir no longer re-prices, warning on a stale price date [17]; delivery PDF title «Remisión de entrega» [33].
- **51** Price list processes [55]: `core.price_list.create` and `core.price_list_item.set` (permissions, audit, i18n, user guide), then the demo seed creates a price list through them; the e2e checks a price from it. Test first.

### Expanded tasks of the 2B.2 small batch (Tasks 40, 41, 42, 48, 50; expanded 2026-11-06)

Source of every decision: `2026-11-05-phase-2b-owner-decisions-pending.md` (each item's "Decided by the owner, 2026-11-06" line). Rulings of the expansion are in the run ledger as `Ruling:` lines. Every brief: "Read `docs/project-rules.md` and the design sections for X before starting; follow the plan task verbatim." Migrations from `0117`, forward-only. Commits are not made unless the owner asks (rule 33); each task ends with its tests green and a report.

#### Task 40: Unmasked-view guard test [item 30]

**Files:**
- Modify: `scripts/check-rules.ts` (new rule id `unmasked-view-read`, function `checkUnmaskedViewReads`, added to `RuleId` and to the `checkRules` spread); `apps/web/src/lib/payments/actions.ts` and `packages/modules/payments/src/processes/receipt.ts` only as the guard demands (see Ruling R40-2)
- Test: `scripts/__tests__/check-rules.test.ts` (new `describe("check-rules: unmasked module views")`, `put()` style)

**Interfaces:**
- `UNMASKED_VIEWS` (exported const): `crm.v_quote_offers`, `crm.v_quote_offer_lines`, `sales.v_invoice_order_lines`, `invoicing.v_receivable_invoices`, `payments.v_invoice_allocations`; `UNMASKED_PROCESSES`: `payments.payment.open_invoices`.
- Rule: a `.ts`/`.tsx` file under `apps/web/src` (non-test) that names one of the views in a `from`/`join`, or names a listed process in a `runProcess(...)` call, must also contain a field-visibility marker: a call to `gridPageAccess(`, `creditVisibleTo(`, `linkableEntities(` or the SQL helper `kernel.field_visible(`, or the line comment `// visibility-checked: <reason naming the helper>` is NOT accepted (no escape hatch). Allowed readers outside `apps/web` (module processes) are unchanged: only pages, route handlers and `apps/web/src/lib` are scanned.
- The three gated screens pass: `apps/web/src/lib/sales/credit.ts` + `record.ts` (creditVisibleTo), `packages/modules/inventory/src/home.ts` is outside the scan but has a test asserting `kernel.field_visible(` in its SQL, `apps/web/src/lib/payments/record.ts` `receiptsOfInvoice` (gridPageAccess).
- `openInvoicesAction` (`apps/web/src/lib/payments/actions.ts`) reads `payments.payment.open_invoices` with no check today: the guard fails on it; fix it by gating the action with `gridPageAccess` on `invoicing.invoice` (fields total, balance, number) and returning masked rows' ids only for visible fields, or by refusing when a field is not `visible` (Ruling R40-2: refuse with a typed `forbidden` result).

- [ ] **Step 1: Failing tests** — fake repo with `put()`: (a) a page reading `from invoicing.v_receivable_invoices` with no helper → violation `unmasked-view-read` with file and line; (b) same file calling `gridPageAccess(` → clean; (c) each of the five views and the process name flagged; (d) a test file and a file under `packages/modules` are not scanned; (e) the real repo passes `checkRules(root)` with zero violations of this rule after the fix; (f) integration test in `apps/web/src/lib/payments/__tests__` (or the existing receipt integration file): a role with `invoicing.invoice.total` masked gets `forbidden` from `openInvoicesAction`, a visible role gets rows.
- [ ] **Step 2–4:** FAIL → implement rule and the `openInvoicesAction` gate → PASS; `pnpm check:rules` green.
- [ ] **Step 5:** user guide note in `docs/user-guide/es-419/pagos.md` (Registrar pago hides open invoices when the amounts are masked). Commit message when the owner asks: `test(rules): guard unmasked module views`.

#### Task 41: Inventory's dependency on costing [item 31]

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (new optional `ModuleDef.needs?: string[]`), `packages/kernel/src/module/define.ts` (validate: no self, ids are strings), `packages/kernel/src/module/loader.ts` (every `needs` id must be a loaded module; `needs` is NOT part of load order, so no cycle with costing's `dependsOn: ["core","inventory"]`), `packages/kernel/src/admin/modules-state.ts` (`ModuleState.needs`), `packages/kernel/src/admin/modules.ts` (disable refuses while an enabled module needs it), `apps/web/src/lib/admin/load.ts` and `apps/web/src/app/(app)/admin/modules/modules-screen.tsx` (`used_by` includes needers, `requires` shows needs), `packages/modules/inventory/src/index.ts` (`needs: ["costing"]`, docblock updated), i18n `admin.*` copy if a new string is needed (es-419 + en)
- Test: `packages/kernel/src/__tests__/module-loader.test.ts`; `packages/modules/support/src/__tests__/admin-modules.integration.test.ts` (or a new kernel integration file using the same harness); `packages/modules/inventory/src/__tests__/entities.test.ts`

**Interfaces:**
- Disable message: `El módulo <X> necesita este módulo; desactívalo primero` (`invalid_input`), same shape as the `dependsOn` refusal. Enabling inventory does not force costing on (inventory falls back to the standard cost, documented): only disabling costing is refused while inventory is enabled (Ruling R41-1).

- [ ] **Step 1: Failing tests** — loader accepts `needs` with a mutual `dependsOn` (inventory needs costing, costing dependsOn inventory) and rejects `needs` of an unknown module; `kernel.admin.module.disable costing` with inventory enabled → `invalid_input`; with inventory disabled → ok; `moduleStates` exposes `needs`; the admin modules page data lists inventory under costing's `used_by`; inventory manifest `needs` equals `["costing"]` and `dependsOn` stays `["core"]`.
- [ ] **Step 2–4:** FAIL → implement → PASS (kernel unit, the integration file, web unit for load.ts).
- [ ] **Step 5:** guide line in `docs/user-guide/es-419/costos.md` and the admin modules guide. Commit when asked: `feat(kernel): module needs, inventory needs costing`.

#### Task 42: «Cotizaciones» shortcut under Ventas [item 32]

**Files:**
- Modify: `packages/kernel/src/registry/types.ts` (new optional `ModuleDef.shortcuts?: { item: NavItem; under: string }[]`, `under` = target section group id, e.g. `sales.documentos`), `packages/kernel/src/module/define.ts` (validate the group id shape `<module>.<section>` and that `under`'s module is in `dependsOn`, so a module may place a shortcut only under a module it depends on), `packages/kernel/src/module/loader.ts` (target group must exist), `apps/web/src/lib/shell/nav.ts` (`placeShortcuts` after `adoptItems`: the item is added last in the target group, only when the contributing module is entitled and its feature/process guards pass; the contributing module's own item stays in its menu), `packages/modules/crm/src/index.ts` and `features.ts` (CRM declares the shortcut: id `crm.quotes_shortcut`, label `nav.crm.quotes_shortcut`, href `/crm/quotes`, feature `crm.quotes`, under `sales.documentos`), i18n `nav.crm.quotes_shortcut` = «Cotizaciones» (es-419 + en)
- Test: `apps/web/src/lib/shell/nav.test.ts` (new cases), `packages/kernel/src/__tests__/module-loader.test.ts`, `packages/modules/sales/src/__tests__/entities.test.ts` (sales source never contains the string `crm`: a `readFileSync` scan of `packages/modules/sales/src/**/*.ts` excluding tests, rule 3)

**Interfaces:** the shortcut shares the target `href` with the CRM item, so `menu-guard` access and the "every item id appears once" test must use distinct ids; the shortcut is hidden when `module:crm` is not entitled or its process is not runnable.

- [ ] **Step 1: Failing tests** — with crm + sales entitled, the Ventas Documentos group lists «Cotizaciones» (href `/crm/quotes`) and CRM Documentos still lists its own; with crm not entitled the Ventas group has no such item and no error; with sales not entitled nothing is placed; `defineModule` rejects a shortcut under a module not in `dependsOn`; sales manifest and sources contain no `crm`.
- [ ] **Step 2–4:** FAIL → implement → PASS (kernel unit, web nav unit, `check:rules` menu sections).
- [ ] **Step 5:** guide line in `docs/user-guide/es-419/cotizaciones.md` and `ventas.md`. Commit when asked: `feat(shell): CRM contributes a Cotizaciones shortcut under Ventas`.

#### Task 48: Worker startup module-list check [item 40]

**Files:**
- Create: `apps/worker/src/module-check.ts` (pure, injectable: `compareModuleLists(workerIds, deployedIds): { missing: string[]; extra: string[] }`, `checkWorkerModules({ sql, workerIds, mode, log }): Promise<void>`)
- Modify: `apps/worker/src/main.ts` (call before `syncManifests()`), worker env docs (`docker-compose.yml` comment, `.env.example` if present) for `WORKER_MODULE_CHECK`
- Test: `apps/worker/src/__tests__/module-check.test.ts` (unit, fake `sql`), and one integration-free test of the mode selection

**Interfaces:**
- Deployed list = `select module_id from kernel.manifest_hashes` read before the worker's own `syncRegistry`. `missing` = deployed minus worker (a stale image: events of those modules would not be processed); `extra` = worker minus deployed (info only).
- Mode (Ruling R48-1): `WORKER_MODULE_CHECK` = `refuse | warn | off`; default `refuse` when `NODE_ENV === "production"`, else `warn`. `refuse` throws before the first tick (main's catch logs and exits 1); `warn` logs `[worker] WARNING module list differs…` listing the missing ids at `console.warn`. An empty `manifest_hashes` (first boot) is never a mismatch.

- [ ] **Step 1: Failing tests** — equal lists silent; missing id in `warn` logs once loudly and resolves; in `refuse` rejects with a message naming the ids; `off` skips the query; empty deployed list passes; default mode by `NODE_ENV`.
- [ ] **Step 2–4:** FAIL → implement → PASS; the existing `modules.test.ts` stays green.
- [ ] **Step 5:** hosted checklist line in the deployment doc that already lists the worker image rebuild. Commit when asked: `feat(worker): refuse or warn on a stale module list`.

#### Task 50: Small fixes batch (seven sub-tasks, each with its own test)

Each sub-task is its own implementer dispatch; tests first; i18n through `packages/i18n` with the `en` mirror.

**50.3 [item 3] Every subscribed event has an effect line.**
- Test (written first): `packages/agent/src/__tests__/effects-coverage.test.ts`: load every module, for each `events.consumes` key except `"*"` and `kernel.*`, `module.effects[event]` must exist and be non-empty; an exported `EFFECTS_EXEMPT` allowlist, each entry with a reason string, is the only way out (none expected).
- Fix: add the missing effect lines (known gap: sales consumes `inventory.*` events with none) with i18n keys `<module>.effects.<name>` in both catalogues.

**50.6 [item 6] Posting rule with a `when` that matched nothing in N days.**
- Files: migration `NNNN_accounting_rule_stale_days.sql` (`accounting.settings.rule_stale_days int not null default 30 check (>0)`), `packages/modules/accounting/src/processes/settings.ts` (consult/update field), `packages/modules/accounting/src/processes/posting-rule.ts` (`postingRuleConsult` adds `stale: boolean` for active rules with a non-empty `when`, true when no `kernel.outbox` row of the rule's event created within N days satisfies `ruleApplies`; scan capped at 5000 rows per rule; a rule younger than N days is never stale), the rules grid/record in `apps/web/src/lib/accounting/posting.ts` + `packages/ui/src/accounting/RuleForm.tsx` (warning badge «Sin coincidencias en N días»), `posting/settings-form.tsx` (the N field), i18n `accounting.*`.
- Tests: accounting integration (`posting-rules-sync.integration.test.ts` style): stale true with no events, false after a matching event, false for non-matching payload events only → true, false for a rule without `when`, false for a rule younger than N; settings update validates N; ui unit for the badge.

**50.7 [item 7] Dry-run denials: no audit row, counted as telemetry.**
- Files: `packages/kernel/src/process/run.ts` (in the denial catch, when `options.dryRun` skip `writeAudit` and call the counter), migration `NNNN_kernel_dry_run_denial_counters.sql` (`kernel.dry_run_denial_counters(company_id, day date, process_id text, code text, count bigint, primary key(company_id, day, process_id, code))`, RLS on, no direct grants, written by a `security definer` function `kernel.count_dry_run_denial(...)`; read by service role only), `packages/kernel/src/audit` helper.
- Ruling R50-7: the `telemetry` process kind does not exist in code, so the counter is a table, not a `ProcessKind`; the `ProcessKind` union is unchanged.
- Tests: `run-process.integration.test.ts`: a dry run denied (`forbidden`, `not_entitled`, `step_up_required`, `record_forbidden`) writes no `denied` audit row and increments the counter once per denial; a real run denied still writes the audit row; the assistant `confirm.integration.test.ts` path through `createConfirmation` shows the same; counters are per company and RLS-bound.

**50.9 [item 9] Never-bought visible, switched-off silent, one resolver.**
- Files: `packages/kernel/src/entitlements/resolver.ts` (new `moduleGate(sql, companyId, moduleId): "enabled" | "switched_off" | "not_purchased"`), `packages/kernel/src/events/dispatch.workflow.ts` (switched off → park `module_disabled` as today; not purchased → dead-letter `not_entitled` as today but through the resolver), `packages/kernel/src/posting/inline.ts` (posting module not purchased → park the event with reason `not_entitled` and return `{ posted:false, reason:"not_entitled" }`; switched off → `accounting_disabled` unchanged; fix the header comment), `packages/kernel/src/admin/modules-state.ts` reuses the resolver, a kernel read process `kernel.admin.module.parked_events` and the admin modules page row «módulo no contratado» with the parked `not_entitled` count and the actions Descartar (new `kernel.admin.module.parked_events.dismiss`, step-up not required, audited) and an automatic replay on purchase/enable (hook in `enableModule`: `not_entitled` dead letters of that module go back to the outbox once).
- Ruling R50-9: there is no screen for `kernel.outbox_dead_letter` today, so the «módulo no contratado» visibility lives on Admin › Módulos (kernel-owned), not in the accounting failures tab.
- Tests: `dispatch.integration.test.ts` (never bought → dead-letter `not_entitled`; switched off → `module_disabled`, silent), `inline-posting.integration.test.ts` (never-bought accounting parks `not_entitled`, switched-off `accounting_disabled`), resolver unit/integration, dismiss and replay-on-enable integration, web load.ts unit.

**50.14 [item 14] Move cogs-posted to costing, inventory-adjustment to inventory.**
- Files: move `rules/defaults/cogs-posted.json` and `inventory-adjustment.json` (and their fixtures) from `packages/modules/accounting/src/rules/` into `packages/modules/costing/src/` and `packages/modules/inventory/src/` (`postingRules` in each manifest; accounting's `ACCOUNTING_DEFAULT_RULES` drops them), a migration `NNNN_accounting_rules_retag_module.sql` setting `module = 'costing'` / `'inventory'` on existing company rows by (event, name) so the off-switch and the sync follow the owner, behaviour identical (same templates, `when`, priority, journal code).
- Tests: `posting-rules-sync.integration.test.ts` (a new company gets both rules from the owning manifests; existing rows re-tagged and unchanged otherwise; disabling costing deactivates only its rule; `is_modified` rows untouched), `inventory-adjustment.integration.test.ts` and `inline-posting.integration.test.ts` unchanged and green, `costing/rules.test.ts` counts updated.

**50.17 [item 17] «Recalcular precios»; Emitir no longer re-prices.**
- Files: migration `NNNN_invoicing_price_date.sql` (`invoicing.invoices.price_date date`, backfilled from `issue_date` for drafts), `packages/modules/invoicing/src/processes/invoice.ts` (new process `invoicing.invoice.reprice`, update kind, normal sensitivity, draft only; sets lines' prices at today's company date through `priceLines`, taxes through `computeTaxes` at the invoice date, writes `price_date = today`; `invoiceHooks.validate` at issue keeps the stored `unit_price`, still re-dates and re-evaluates taxes at the issue date, and returns a warning field when `price_date <> issue_date`), `INVOICE_PROCESSES`, `apps/web/src/lib/invoicing/record.ts` (`INVOICING_STEPS` entry `reprice`, `allow("reprice", draft)`), `step-actions.ts`, `invoicing-bar.tsx` button «Recalcular precios», warning banner «Los precios son del <fecha>; usa Recalcular precios para actualizarlos» on the draft when the price date differs from today, i18n `invoicing.*`.
- Tests: `issue.integration.test.ts` (issue keeps prices, re-evaluates taxes at the issue date, `price_date` unchanged), a new reprice integration (prices follow today's list, price_date = today, issued invoice refused), web record unit for the step and warning, `sales-chain.spec.ts` unaffected (run it).

**50.33 [item 33] Delivery PDF title «Remisión de entrega».**
- Files: `packages/modules/sales/src/print.ts` (`deliveryRecordTemplate` overrides the title block and `name` through the catalogue key `sales.print.delivery_title`), i18n es-419 «Remisión de entrega» and en «Delivery note».
- Test: `packages/modules/sales/src/__tests__/entities.test.ts` (title text block value and template name), plus a web print unit if one exists. The on-screen name stays «Entrega» (item 33).
- User guide: `docs/user-guide/es-419/ventas.md` (the PDF is titled «Remisión de entrega»).

**Task 50 close:** guides updated for 50.6 (`contabilidad` posting rules), 50.9 (administración › módulos), 50.17 (`facturacion-electronica.md`).

### Expanded tasks of the demo batch (Tasks 46, 47; expanded 2026-11-06)

Source: `2026-11-05-phase-2b-owner-decisions-pending.md` items 38 and 39 ("Decided by the owner, 2026-11-06"). Order: 46, then 47 (47 resets the database and reruns the e2e that 46 changes). Every brief: "Read `docs/project-rules.md` and the design sections for X before starting; follow the plan task verbatim." Rulings are in the run ledger as `Ruling:` lines.

#### Task 46: Exógena demo fix [item 38]

**Files:**
- Modify: `scripts/demo/data.ts` (one new party: Bancolombia S.A., NIT 890903938, supplier; comment «40 parties» becomes 41 with 11 suppliers); `scripts/demo/accounting.ts` (the NC-18 sample line «Intereses financieros» on 421005 gets `partyDocument: "890903938"`; export a `BANCOLOMBIA` constant); `apps/web/e2e/sales-chain.spec.ts` (Exportar XML downloads the real file)
- Test: `apps/web/e2e/sales-chain.spec.ts`; the 2A and report tests that read the demo ledger: `accounting-smoke`, `accounting-reports`, `report-file.integration`, `exogena.integration` (run each; change only an expectation the new tercero moves)

- [ ] **Step 1 (test first):** change the e2e's Exportar XML step: wait for the download (`page.waitForEvent("download")`), read the file, assert it is XML for format 1007 (root element and `ano`/year of the demo), that it contains the customer's document and the new bank's document, and that no «No se generó el archivo» alert shows. Run it: it fails (refusal on 421005).
- [ ] **Step 2:** add the party and the tercero on the line. The party gets the same DIAN-complete fields as the other suppliers (document type NIT with DV, address, municipality, e-mail, CIIU `6411`). It need not be `invoice_ready`: 421005 is not flagged `requires_invoice_ready` (design §22.22). Seed data only: no change to `accounting/reports/exogena*`, `exogena-xml.ts` or the localization pack; no edit of any posted or audit row outside the seed.
- [ ] **Step 3:** rerun the 2A tests and every report that reads the demo ledger; fix an expectation only if the tercero moves it (the count of demo parties, the 1007 rows). Update the user guide of the demo (`docs/user-guide/es-419`, the demo and exógena guides) if it lists the parties or says the XML is refused.
- [ ] **Step 4:** the e2e passes against the seeded demo company.

#### Task 47: Demo seed gaps [item 39]

**Files:**
- Modify: `scripts/demo/sales.ts` (and `scripts/seed.ts` only if the stages need it); the demo user guide
- Test: `pnpm db:reset` then `DEMO_SEED=1 pnpm db:seed` twice (the second changes nothing), then the full e2e

- [ ] **Step 1:** price list: seed one for the demo company through a registered process or existing seed helper only. **Blocked, see Ruling R47-1.**
- [ ] **Step 2:** resolution with origin `seed`: **Blocked, see Ruling R47-2.** The seed already registers the habilitación resolution through `core.document_sequence.register`.
- [ ] **Step 3:** certificate and PIN stay unseeded: DIAN settings show `not_configured` in the demo (assert it in the e2e or a seed test).
- [ ] **Step 4:** from zero on the local OrbStack stack: confirm nothing else uses the database, `pnpm db:reset` (migrations 0001..latest in order; report the last applied), `DEMO_SEED=1 pnpm db:seed`, a second seed run (idempotent), the full e2e on the production build. Report the outcome.

**Rulings of the expansion**
- R46-1: the tercero is a new party, Bancolombia S.A. (the bank that pays the interest), because no bank exists in the demo parties; reusing a customer or supplier would misstate who pays the interest. Cost if wrong: one party row to rename.
- R47-1: a price list has no create process and its items have no process at all (`core.price_list` only has the generic `save|submit|approve|reject|void|delete`, which write an existing row; `core.price_list_item` has none). The seed cannot create one without raw SQL, which the brief forbids (rule 1). Not invented here: owner item 55.
- R47-2: `seed` is not an audit origin (`kernel.audit_log.origin` allows `ui|agent|scheduler|event|api|db`, rule 16), and the screen-only register process requires origin `ui`. Adding `seed` is a rule 16 change plus a migration: owner item 56. The seed already registers the resolution (`scripts/demo/sales.ts`); item 39's «registered with origin `ui`» describes the e2e's own registration.

#### Task 51: Price list processes [item 55] (expanded 2026-11-06)

**Files:**
- Create: `packages/modules/core/src/processes/price-list-write.ts` (`core.price_list.create`, `core.price_list_item.set`, `core.price_list_item.remove`); modify `packages/modules/core/src/processes/price-list.ts` or `index.ts` to register them, `packages/modules/core/src/features.ts` (they belong to the existing products feature; add the ids where `core.price_list.` / `core.price_list_item` are listed), and the i18n process descriptions in `packages/i18n` (es-419 and en mirror)
- Modify: `scripts/demo/sales.ts` (seed one price list «Mayoristas» in COP with the demo's goods at 10 % under list price, idempotent by name, through these processes; drop the «Gaps» comment about the price list)
- Test (first): `packages/modules/core/src/__tests__/price-list-write.integration.test.ts` (create: Grabado state, `usable`, duplicate name refused as `invalid_input` like `save`; item set: inserts then updates the price for the same product, refuses a negative price and a product that is not usable, refuses a list that is not writable; remove deletes the item; permissions per process; audit row with before/after; a role without the process is denied); the seed unit tests; `apps/web/e2e/sales-chain.spec.ts` or a demo e2e asserting `sales.price.resolve` of a demo product returns the list price of Mayoristas for a customer whose terms name it
- Docs: `docs/user-guide/es-419` (the products or price-list guide: how a price list is created today; if none exists, a short section in the Ventas precios guide), indexed for the assistant

- [ ] **Step 1 (test first):** write the integration tests above; they fail (no processes).
- [ ] **Step 2:** `core.price_list.create {name, currencyCode}`: follow `core.product.create` for the pattern (initialLifecycle state, validate hook, `refuseDuplicate` on `price_lists_company_id_name_key`, `seq` from `core.next_sequence`, audit via the runner). `core.price_list_item.set {priceListId, productId, price}`: upsert on `(price_list_id, product_id)`, the list must be writable and the product usable (rule 10: invoice_ready is for document lines, not for a price list; only `kernel.record_usable`), price >= 0 with two decimals; `core.price_list_item.remove {priceListId, productId}`. Every state change through `runProcess` (rule 1); permissions per process (rule 13); not sensitive; not screen-only.
- [ ] **Step 3:** register in the module and the products feature; i18n descriptions; no migration needed (the tables exist), so none is added.
- [ ] **Step 4:** seed the list in `scripts/demo/sales.ts` through the processes (the existing `act` helper), set it as the default list of Ventas settings only if the seed already sets settings through `sales.settings.update`; otherwise leave the default empty and name it in the customers' terms for the chain's customer (Almacenes Éxito) through `sales.customer_terms.set`-style process that exists (check `packages/modules/sales/src/processes/pricing.ts`). Idempotent.
- [ ] **Step 5:** the user guide; `db:reset` + two seed runs (second changes nothing); the e2e.

**Rulings:** R51-1 no «update» process: `core.price_list.save` (generic) edits name and currency of an existing list, `item.set` is the only item write. R51-2 the discount of the seeded list is 10 % under list price, rounded to whole pesos; a demo value, no owner impact.

### Expanded task of the kernel batch (Task 38; expanded 2026-11-06)

#### Task 38: Kernel recommendation API [items 26, 36] (design §22.28; rules 1, 3, 12, 14, 16, 24, 28)

**Study result (why this extends `kernel.recommendations` and adds no second table).** The table (migration 0022) already has what the new shape needs: company, seq (gap-free by `core.assign_seq`), audience role or user, title and body, suggested actions, status with the decision stamp, row audit, RLS and the `kernel.v_recommendations` read view, the home list (`kernel.recommendation.list`) and the one decision process (`kernel.recommendation.decide`, kind update, audited, baseline grant `kernel.recommendation.%`). What it lacks is a *process* writer, a subject record, a reason, text that can be masked per viewer, and an automatic close. All five are columns, one partial unique index and two functions; a second table would duplicate the audience policy, the view, the inbox and the decide process. Agent rows (phase 3 agents, the seed) keep working unchanged: `source = 'agent'`.

**Rulings** (format: what, why, cost if wrong):
- **R38-1 Extend, no second table.** Above. Cost if wrong: a later phase that wants agent and process rows in different inboxes filters on `source`; no migration.
- **R38-2 Who sees what: addressed by permission, masked per viewer.** A process row is addressed to the *holders of a process* (`audience_process_id`, e.g. whoever may run `invoicing.invoice.create`), not to a role id, because the raising module cannot know the roles the admin created and a fan-out of one row per role would break «one open per document and reason». A row may also name a `audience_role_id` (the existing way; the seed and agents use it). Visible to: the named user, the holders of the audience role, the holders of the audience process (`kernel.can_run_process`, evaluated per read, so a role change takes effect at once). The admin sees it only through a role that holds the process, like anybody else (the existing rule «not even the admin reads what was offered to another role» stays). Masking: a process row stores no rendered text, only a catalogue key for title and for reason (`title_key`, `body_key`) and `params`, a JSON object of `{ value, entity?, field? }`. The base table's `params`, `subject_entity` and `subject_id` columns are NOT granted to `authenticated`; the view reads them through the definer function `kernel.recommendation_safe(id)`, which re-checks the audience and returns `params` with every value whose `entity.field` the viewer does not see (`kernel.field_visible`) replaced by null, and the subject only when the viewer may run `<subject_entity>.consult` (otherwise the subject and its link are null and the card shows the reason without a link). Text is composed by the web with `t(key, params)` (the kernel imports no catalogue, rule 24); a null param renders as «—». Cost if wrong: a mis-tagged param (no entity/field) is shown to the whole audience; the raise function therefore refuses a param whose `entity` is registered but whose `field` is not on that entity (test).
- **R38-3 Retention.** Open rows stay until closed or dismissed. Dismissed and closed rows are kept 90 days after `decided_at` / `closed_at`, then deleted. The deletion runs inside `kernel.recommendation_raise` for the caller's company (a company that raises nothing grows nothing; no scheduler job to forget, rule 6), as the definer function, audited by the table's row audit (the 10-year audit log keeps the history, rule 16). Agent and seed rows are purged by the same rule. Cost if wrong: a company that stops raising keeps its last 90 days of closed rows until it raises again (a few rows); a different retention is one constant.
- **R38-4 Automatic close: the module that raised it closes it, in the process that fixes the cause, in the same transaction.** No generic re-check engine, no polling: `ctx.recommendations.close({ subjectEntity, subjectId, reason? })` is called by (a) `invoicing.invoice.auto_create` when it creates the draft for a source that had a refusal, and by `invoicing.invoice.create` / `invoicing.invoice.from_orders` when they bill that order or delivery (closes every open reason of that subject); (b) costing's `resolveMissing` and the void path that resolves a cost_missing row (closes `cost_missing` of that row). Closed rows get `status = 'closed'`, `closed_at`, `closed_reason = 'cause_fixed'`; they leave the inbox and the bell. A cause fixed through a path no module wired leaves the row open until someone dismisses it. Cost if wrong: a stale open row; the fix is one more `close` call at that path.
- **R38-5 Dedupe and re-raise.** One open (`status = 'new'`) process row per `(company, subject_entity, subject_id, reason)` (partial unique index). A second raise merges: `occurrences + 1`, `last_raised_at = now()`, `params` and keys refreshed, audience and `seq` unchanged. The audience is not part of the key (a reason belongs to one audience by design). After a dismissal or a close the next raise opens a new row. The function takes the row with `select … for update` and inserts only when none is open (an `on conflict` would burn a `seq`); a concurrent insert that loses the unique race re-reads and merges.
- **R38-6 Writes only through the context (rule 1).** `authenticated` keeps `select` (without the three protected columns) and the decision update; it gets no insert and no delete. `ctx.recommendations.raise` and `.close` call the definer functions `kernel.recommendation_raise` / `kernel.recommendation_close`, which refuse unless `current_setting('erp.audit_process_id')` is the process id passed (so only the running process can name itself) and the process is registered as `kind` create or update (a consult cannot raise), and write the row under the company of `kernel.current_company_id()`. Agents and the seed keep the service role. Cost if wrong: none beyond the definer guard test (`definer-guards.integration.test.ts` lists definer functions: add both).
- **R38-7 Dismissal is the existing `kernel.recommendation.decide` with `decision = 'dismissed'`** (registered process, audited by the row audit and the process audit entry, permission from the matrix; the baseline grant `kernel.recommendation.%` already gives it to plain roles, and the audience policy limits it to the viewer's own rows). Its update policy gains the audience-process branch. No new process. A process row has one suggested action, `{ label: "recommendation.open_record" key, href }` is NOT stored (the web builds the link from the subject); `suggested_actions` stays `[]` for process rows, so `accepted` is allowed but only returns the status.
- **R38-8 Module and company home, bell.** A process row carries `module` (the raising process's module). The company Inicio shows all the viewer's open rows (existing «Recomendaciones para ti», now also process rows); a module home (`/inicio/[module]`) shows a «Pendientes» card with the rows of that module; the TopBar bell shows the open count and the five newest (each a link to its subject, or to Inicio when the subject is hidden). `kernel.recommendation.list` takes an optional `module` filter and returns `total` (open count for the viewer, not capped at 20).
- **R38-9 Consumer scope.** (a) Invoicing: only the refusal branch of `auto_create` that answers `skipped` (no draft exists) raises; refusals that leave a draft keep writing `invoicing.invoice_recommendations` as built. (b) Costing: `raiseMissing` raises in addition to its table. The setting «cost for units without a known cost» is Task 44, not here. The full refusal wiring in other modules is out of scope.

**Files.**
- Create `supabase/migrations/0123_kernel_recommendation_api.sql`.
- Create `packages/kernel/src/home/recommend.ts` (`recommendationRaiseInput`, `recommendationCloseInput` zod schemas, `makeRecommendations(tx, processId, module)` returning the `ctx.recommendations` object, param validation against the registry).
- Modify `packages/kernel/src/process/context.ts` (add `recommendations: { raise(input): Promise<{ id: string; merged: boolean }>; close(input): Promise<{ closed: number }> }`, absent on contexts that are not a run), `packages/kernel/src/process/run.ts` (`buildContext` builds it with `def.id` and `def.module`; nested contexts get their own), `packages/kernel/src/home/recommendations.ts` (list: keys, masked params, subject, `module` filter, `total`; decide: `closed` and process rows), `packages/kernel/src/home/index.ts` and `packages/kernel/src/index.ts` (exports).
- Modify `packages/modules/invoicing/src/processes/auto.ts`, `packages/modules/invoicing/src/processes/invoice.ts` (the close at create / from_orders, next to the existing `resolved` update at line ~615 style), `packages/modules/costing/src/processes/cost.ts` and `void.ts`.
- Modify the web: `apps/web/src/lib/home/load.ts` (+ module home loader), `packages/ui/src/home/RecommendationCard.tsx` and `home-model.ts` (render `t(titleKey, params)` for process rows and a record link), `apps/web/src/app/(app)/_components/module-home-screen.tsx` («Pendientes»), the TopBar (`packages/ui/src/shell/TopBar.tsx`: items instead of the empty menu) and the layout that feeds `notificationCount`.
- i18n: `packages/i18n/messages/es-419.json` and `en.json` (keys below).
- Guides: `docs/user-guide/es-419/inicio.md` (section «Pendientes del sistema y la campana»: what they are, who sees them, masked values, the link, «Descartar», that they close by themselves when the cause is fixed, 90 days), `facturacion.md` (factura automática sin borrador), `costos.md` (costo faltante).

**Migration `0123_kernel_recommendation_api.sql` (forward-only, covered by the integration tests below):**
```sql
alter table kernel.recommendations
  add column source               text not null default 'agent' check (source in ('agent', 'process')),
  add column process_id           text,
  add column module               text,
  add column audience_process_id  text,
  add column subject_entity       text,
  add column subject_id           uuid,
  add column reason               text check (reason is null or length(reason) between 1 and 100),
  add column title_key            text,
  add column body_key             text,
  add column params               jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  add column occurrences          integer not null default 1 check (occurrences >= 1),
  add column last_raised_at       timestamptz,
  add column closed_at            timestamptz,
  add column closed_reason        text check (closed_reason is null or closed_reason in ('cause_fixed'));
alter table kernel.recommendations drop constraint recommendations_status_check;
alter table kernel.recommendations add constraint recommendations_status_check check (status in ('new', 'accepted', 'dismissed', 'closed'));
alter table kernel.recommendations drop constraint recommendations_check;          -- (audience_role_id is not null or user_id is not null)
alter table kernel.recommendations drop constraint recommendations_check1;         -- ((status = 'new') = (decided_at is null)); confirm the generated names with \d first
alter table kernel.recommendations
  add constraint recommendations_audience_ck check (audience_role_id is not null or user_id is not null or audience_process_id is not null),
  add constraint recommendations_state_ck check (
    case status when 'new' then decided_at is null and closed_at is null
                when 'closed' then closed_at is not null and decided_at is null and closed_reason is not null
                else decided_at is not null and closed_at is null end),
  add constraint recommendations_process_ck check (
    source = 'agent' or (process_id is not null and module is not null and subject_entity is not null and subject_id is not null
                         and reason is not null and title_key is not null and body_key is not null and audience_process_id is not null));
create unique index recommendations_open_subject_reason_uq on kernel.recommendations (company_id, subject_entity, subject_id, reason)
  where source = 'process' and status = 'new';
create index recommendations_module_status_idx on kernel.recommendations (company_id, module, status) where source = 'process';
create index recommendations_retention_idx on kernel.recommendations (company_id, coalesce(decided_at, closed_at)) where status <> 'new';

-- Raw params and subject are not readable by users: the view reads them through kernel.recommendation_safe (rule 14).
revoke select on kernel.recommendations from authenticated;
grant select (id, seq, company_id, audience_role_id, audience_process_id, user_id, agent_profile, title, body, evidence, suggested_actions,
              confidence, status, decided_at, decided_by, extra, extra_free, created_at, updated_at, created_by, updated_by, source, process_id,
              module, reason, title_key, body_key, occurrences, last_raised_at, closed_at, closed_reason)
  on kernel.recommendations to authenticated;
```
Then, in the same file: (1) recreate the `audience` select policy and the `via_process_update` policy with the third branch `(audience_process_id is not null and kernel.can_run_process(audience_process_id))` (a private function `kernel.recommendation_audience(user_id, audience_role_id, audience_process_id)` keeps the three predicates in one place; the view, `recommendation_safe` and both policies call it); (2) `kernel.recommendation_safe(p_id uuid) returns table (params jsonb, subject_entity text, subject_id uuid)` security definer, `set search_path = ''`, stable: returns nothing unless the caller is in the audience, masks `params` per `kernel.field_visible(value->>'entity', value->>'field')` (a value without entity/field is shown as is; masked → `{"value": null}`), and nulls the subject unless `kernel.can_run_process(subject_entity || '.consult')`; revoke from public and anon, grant to authenticated and service_role; (3) replace `kernel.v_recommendations` (security_invoker, same where) with the old columns plus `audience_process_id, source, module, reason, title_key, body_key, occurrences, last_raised_at, closed_at`, and `s.params, s.subject_entity, s.subject_id` from `left join lateral kernel.recommendation_safe(r.id) s on true`; (4) `kernel.recommendation_raise(p_process text, p_audience_process text, p_audience_role uuid, p_subject_entity text, p_subject_id uuid, p_reason text, p_title_key text, p_body_key text, p_params jsonb) returns table (id uuid, merged boolean)` definer: guard `coalesce(current_setting('erp.audit_process_id', true), '') = p_process` and `kernel.registered_processes` says `kind in ('create','update')` and `module = split_part`…(use the registry row's module), company = `kernel.current_company_id()` (error if null), delete this company's rows with `status <> 'new' and coalesce(decided_at, closed_at) < now() - interval '90 days'` (R38-3), then the lock/merge/insert of R38-5; (5) `kernel.recommendation_close(p_process text, p_subject_entity text, p_subject_id uuid, p_reason text) returns integer` definer with the same guard, sets `status = 'closed', closed_at = now(), closed_reason = 'cause_fixed'` on the company's open process rows of the subject (`p_reason` null = every reason); (6) grants (execute to `authenticated`, `service_role`; revoke from `public`, `anon`); (7) `kernel.seed_role_defaults` is unchanged (`kernel.recommendation.%` already covers `list` and `decide`).

**Interfaces.**
```ts
// packages/kernel/src/home/recommend.ts
export const recommendationParam = z.object({ value: z.union([z.string().max(200), z.number(), z.null()]), entity: z.string().optional(), field: z.string().optional() })
  .refine((p) => (p.entity === undefined) === (p.field === undefined), "entity and field go together");
export const recommendationRaiseInput = z.object({
  audienceProcess: z.string().regex(PROCESS_ID).optional(),   // holders of this process are the audience
  audienceRoleId: z.uuid().optional(),                        // or a role (at least one of the two)
  subject: z.object({ entity: z.string().min(1).max(100), id: z.uuid() }),
  reason: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100),
  titleKey: z.string().min(1).max(200), bodyKey: z.string().min(1).max(200),
  params: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), recommendationParam).default({}),
}).strict();
export const recommendationCloseInput = z.object({ subject: z.object({ entity: z.string(), id: z.uuid() }), reason: z.string().optional() }).strict();
```
`raise` also checks: the subject entity and every param `entity`/`field` exist in `ctx.registry` (error `invalid_input`, so a typo cannot leak); `audienceProcess` is a registered process. In a dry run it works inside the rolled-back transaction.

**i18n keys (es-419 with the en mirror; rule 24).** `recommendation.invoicing.auto_skipped.title` «No se creó la factura automática»; `.body` «{document} no se facturó solo: {reason}.»; reasons `recommendation.invoicing.reason.over_invoicing`, `.order_cancelled`, `.invalid_party`, `.order_not_firm` (one per `skipped` code the process can return; the implementer lists them from the code); `recommendation.costing.cost_missing.title` «Falta el costo de un producto»; `.body` «{product} se movió en {warehouse} sin costo conocido ({count} movimientos): corrígelo con un ajuste de inventario.»; `home.recommendations.open_record` «Abrir registro»; `home.recommendations.no_link` «Sin acceso al registro»; `home.module.pending` «Pendientes»; `shell.notifications_more` «Ver todo en Inicio». Params use `entity`/`field` of the registered entities (`sales.order.number`, `inventory.product.name`…, the implementer picks the real ones).

**Tests first (rule 31); each must fail before the code.**
1. `packages/kernel/src/home/__tests__/recommendation-api.integration.test.ts` (probe module like `home.integration.test.ts`: `probe.doc.flag` raises, `probe.doc.fix` closes, `probe.doc.consult` registered; two roles, one holding `probe.doc.flag` (audience) and one not; a role with the `probe.doc.amount` field masked): raise creates one `new` row with `source = 'process'`, module, audience process and a gap-free seq; the same raise again merges (still one row, `occurrences = 2`, same id and seq, `last_raised_at` moved); another reason opens a second row; the user without the process and without the role gets nothing from `kernel.recommendation.list`, from `kernel.v_recommendations` and from `select … from kernel.recommendations`; the masked-field viewer gets `params.amount.value = null` while the other viewer gets the value; `select params from kernel.recommendations` and `select subject_id …` are `permission denied` for `authenticated`; a viewer who may not run `probe.thing.consult` gets the row with `subject = null`; decide `dismissed` sets status, stamps the user and writes an `audit_log` row (`process_id = 'kernel.recommendation.decide'`, entity `kernel.recommendations`); after the dismissal a raise opens a new row; `close` closes every open row of the subject, or only the named reason, and the list drops it; a raise from a consult process, from outside a run (plain SQL as authenticated), with a process id other than the running one, and with an unknown param field are refused; a closed row older than 90 days (aged by the service role) is deleted by the next raise of that company and not by another company's; two concurrent raises of the same key leave one row; agent rows (service role insert, as the seed) still list and decide as before (the existing 0022 tests stay green).
2. `packages/kernel/src/home/__tests__/recommend.test.ts` (unit): the zod schemas (at-least-one audience, `entity`/`field` pair, key and reason patterns, params cap) and the `{ value, entity, field }` masking helper if one is kept in TypeScript.
3. `packages/modules/invoicing/src/__tests__/auto-recommendation.integration.test.ts` (uses `chain-helpers.ts`): in `on_delivery` mode, an `auto_create` refusal that answers `skipped` (the delivery's lines already invoiced, or the pedido cancelled: the implementer reuses the case of `creation.integration.test.ts`) leaves no draft and exactly one open recommendation (subject the delivery or the pedido, reason the skipped code, audience process `invoicing.invoice.create`); the same refusal again for the same document and reason merges (one row, `occurrences = 2`); a user whose role lacks `invoicing.invoice.create` does not see it, a billing user does, with the document number param masked for a role that has it masked; dismissing it through `kernel.recommendation.decide` is audited; invoicing the document by hand (`invoicing.invoice.from_orders`) closes it.
4. `packages/modules/costing/src/__tests__/cost-missing-recommendation.integration.test.ts`: the first uncosted movement raises one `cost_missing` recommendation (subject `costing.cost_missing`, the row id, audience process the inventory adjustment process), the second uncosted movement of the same product and bodega merges (`occurrences = 2`) while the cost_missing table keeps its own counters, a costed entry resolves the table row and closes the recommendation, a voided movement that resolves the row closes it; no cross-module table is touched (costing calls only `ctx.recommendations`).
5. `apps/web/e2e/home.spec.ts` (extend): a process recommendation raised for the signed-in role (the test setup runs the raising process through the pipeline, never raw SQL) shows in «Recomendaciones para ti» with its composed Spanish text and a record link, shows in the bell with the count, shows on its module home under «Pendientes», and «Descartar» removes it from all three; a user without the role sees none of them.
6. `packages/i18n` catalogue test (es/en parity) and `packages/ui` card and bell tests for the keys, the null param («—») and the missing link.

**Order of work.** Tests 1–2 red → migration, `recommend.ts`, context and `run.ts` → green; tests 3–4 red → consumers → green; test 6 and 5 red → UI, i18n → green; guides; full verification (lint, typecheck, check:rules, unit, the touched integration files, the touched e2e spec on the production build, the build).

**Review focus of this task** (most capable reviewer): masking in every output channel (list, view, direct select, the assistant's consult of `kernel.recommendation.list`, the bell); the definer functions (search_path, the process-name guard, company from the claims, the audience re-check in `recommendation_safe`); tenant isolation (two companies with the same subject id); idempotent re-raise and gap-free seq on merge; retention delete scoped to the company; decide and the policies still refuse a viewer outside the audience; agent rows unaffected.

### Expanded task of the trail batch (Task 31; expanded 2026-11-07)

#### Task 31: Document link table and trail (design §22.27; rules 1, 3, 4, 7, 12, 14, 16, 21, 24, 35)

Every brief: "Read `docs/project-rules.md` and the design sections for kernel §5, security §6, modules §8, record frame §22.26, UI §19a, §22.27 and §22.28 before starting; follow the plan task verbatim."

**Study result (how 2B.1 carries its upstream ids today).** quote→order: `sales.orders.quote_id` (set by `sales.order.create` / `create_from_quote`, `order.ts`; one live order per quote by `orders_one_per_quote`); order→delivery: `sales.deliveries.order_id` (not null, one order per delivery); delivery/order→invoice: `invoicing.invoice_lines.order_id`, `order_line_id`, `delivery_id`, `delivery_line_id` (written by `invoice.ts` create / from_orders / pending lines and `auto.ts`; a line may name an order with no delivery when the invoice is created on the order); invoice→receipt: `payments.receipt_allocations (receipt_id, invoice_id)` (written while the receipt is a Borrador, frozen after `receive`; `payments.v_invoice_allocations` publishes them). The chain id is `ctx.chainId`, one per user action, and is unchanged. Records open in `apps/web/src/app/(app)/r/[entity]/[id]/page.tsx` (`record-frame.tsx`, tabs through `recordTabIds`), entities map to tables in `kernel.entity_tables`, the process gate pattern for kernel writers is `kernel.recommendation_writer` (0123) and `ctx.recommendations` (`packages/kernel/src/home/recommend.ts`).

**Rulings** (what, why, cost if wrong):
- **R31-1 The table is `kernel.document_links`, not a core or module table.** A link joins two documents of any modules; the kernel already holds the cross-module catalogue (`kernel.entity_tables`, `kernel.references`, the audit) and treats entity ids as opaque strings (rule 4), so no module owns it and none reads another's tables (rule 3). Cost if wrong: moving it to `core` later is a table rename plus the definer functions; no data change.
- **R31-2 Modules write only through `ctx.links` (rule 1).** Two verbs, both definer functions refusing unless `erp.audit_process_id` equals the process passed and that process is a registered `create` or `update` (as 0123): `ctx.links.sync({ to: {entity,id}, kind, from: [{entity,id}] })` makes the set of `kind` links into the document `to` equal to `from` (inserts the missing, removes the extra), and `ctx.links.markVoided({ entity, id, reason? })` marks every link touching that document. One verb for create, draft line edits and Borrador delete (`from: []`), so a link never outlives or precedes its document. The guard: the running process's module must own the `to` entity (`kernel.entity_tables.module_id`; `from` may be another module's, e.g. invoicing links a sales delivery); both ends must exist in the caller's company (checked in the definer function with the entity's table from `kernel.entity_tables`); `sync` may remove rows only while the `to` document is a Borrador by the kernel's own predicate for «a Borrador may be deleted» (§22.23; the implementer reuses it, no second definition) and never a marked row. `markVoided` is called by the processes that void or cancel one of the document kinds. Cost if wrong: a process that forgets `sync` leaves a document with no trail (backfill-style repair is one forward migration); a too-loose guard lets a module link documents it does not own, so the ownership check has its own test.
- **R31-3 Link kinds** are plain text, checked by pattern `^[a-z]+_to_[a-z]+$`, declared by the writers: `quote_to_order`, `order_to_delivery`, `delivery_to_invoice`, `invoice_to_receipt` (the four of the task) and **`order_to_invoice`** (added: an invoice created on an order with no delivery, as the auto-invoice `trigger: "order"` and `from_orders` do, carries `order_id` with no `delivery_id`; without it that invoice would have no upstream). The kernel does not enumerate kinds (rule 4). Not linked in this task, listed as owner item 61: credit and debit notes (invoice→note), returns (delivery→return), advances applied to an invoice. Cost if wrong: one more kind is a writer line.
- **R31-4 Idempotency.** Unique index `(company_id, from_entity, from_id, to_entity, to_id, kind)`; `sync` inserts with `on conflict do nothing` (so no `seq` is burned: it first selects the missing keys, as 0123 does, and inserts only those). The same call twice leaves one row and no new `seq`. Cost if wrong: a gap in `seq` on a retried process; the test counts `seq`.
- **R31-5 Void keeps the link, marked.** Columns `voided_at timestamptz`, `voided_chain_id uuid`, `void_reason text`; the row is never deleted by a void and never updated by anything but `markVoided`. A voided link is still returned by the trail with `voided: true` and shown struck-through with the label «Anulado». Un-voiding does not exist (a voided document stays voided, §22.23). Cost if wrong: a void process that forgot `markVoided` shows an active link to a voided document; the trail row also carries the live document status if the viewer sees it (the web already has it), so the list never shows the link as live next to a voided chip.
- **R31-6 Masking and the walk through hidden nodes.** A node is visible to the viewer when they may run `<entity>.consult` **and** the record is returned by the entity's registered read view under their RLS (the same source `kernel.data.query` uses; confirm in `packages/kernel/src/query/access.ts`). The walk is `security invoker` over `kernel.document_links` (company RLS) with a recursive CTE, direction up, down or both, `depth` default 6 and hard max 12, `cap` default 100 nodes and hard max 500, cycle-safe (visited set), deterministic order (depth, then `created_at`, `id`). **Hidden nodes are walked through but never named**: a viewer who sees the quote and the receipt but not the invoice between them still sees both, and `hidden` counts what they cannot see; a hidden node's entity, id, number and kind are not returned (the `via` edge of a visible node whose parent is hidden names only the visible side). The count is the whole answer about hidden documents (§22.27 and the task). Cost if wrong: the count reveals that N further documents exist; it never reveals what they are. If the owner wants the walk to stop at hidden nodes, it is one flag in the CTE.
- **R31-7 Read side is a registered consult process `kernel.document_link.trail`** (module `kernel`, kind `consult`, input `{ entity, id, direction?: "up"|"down"|"both", depth?, cap? }`, output `{ nodes[], hidden, truncated }`) over the invoker SQL function `kernel.document_trail(...)`. A process, not only a view, because the assistant may only use registered processes (rule 1, 17), results are capped and masked (rule 17), and the record page runs it through the same pipeline. Permission: baseline grant for every role (like `kernel.recommendation.list`); the caller must be able to see the start record, else `not_found`. The labels (document number and kind name) come from the web through the existing title resolver (`packages/kernel/src/records/titles.ts`), so no number is read in the kernel. Cost if wrong: none; a view could be added later over the same function.
- **R31-8 Frame placement: a tab «Documentos relacionados» (id `relacionados`)** on the record page of any record that has links or hidden links (count in the tab chip, as the other counted tabs); no tab when there is nothing. Each entry: the document kind name, number (as a link to the record, rule 21: `recordHref(entity, id)`), the relation word from the kind catalogue key (`quote_to_order` → «Cotización → Pedido»), upstream entries before downstream, depth shown as indent, voided entries struck-through; below the list «Y N documentos más que no puedes ver» when `hidden > 0` and «Se muestran los primeros N» when `truncated`. The kernel frame draws it from the process result alone (rule 4: no module names in the frame). Cost if wrong: placing it as a section inside `Datos` instead is a layout change in `page.tsx`.
- **R31-9 Backfill is two forward-only migrations: `0124_kernel_document_links.sql` (table, functions, grants, consult registration data if SQL-registered) and `0125_kernel_document_links_backfill.sql`.** The number: the task text said 0123 was next free, but Task 38 took 0123 (`0123_kernel_recommendation_api.sql` exists), so the next free is 0124. Backfill sources and kinds: `sales.orders.quote_id` → `quote_to_order` (from `crm.quote`); `sales.deliveries.order_id` → `order_to_delivery`; `invoicing.invoice_lines` distinct `(delivery_id, invoice_id)` where `delivery_id is not null` → `delivery_to_invoice`; distinct `(order_id, invoice_id)` where `delivery_id is null and order_id is not null` → `order_to_invoice`; `payments.receipt_allocations (invoice_id, receipt_id)` → `invoice_to_receipt`. Rows carry `origin = 'backfill'`, `chain_id null` (the original chain is not recoverable from the payload ids: the table's check allows a null chain only for backfill), `created_at` of the downstream document, and `voided_at` where either end is voided or cancelled. Idempotent (`on conflict do nothing`), so a second run adds nothing. A migration may read module tables once (it is DDL-time data repair, not runtime access, rule 3); the migration header says so. Cost if wrong: a link missing for an exotic 2B.1 row; the backfill test compares counts against the source tables on the demo company.
- **R31-10 What the many-to-many tests can produce.** 2B.1's processes can create: one quote→two orders (cancel the first, create again from the quote), one order→two deliveries, one invoice from two deliveries, one receipt over two invoices. They cannot create «two orders in one delivery» (`deliveries.order_id` is one) or «one order from two quotes». Those two shapes are tested at the kernel API with a probe process (the table and `ctx.links` are many-to-many by design); the domain tests cover the rest. Cost if wrong: none.
- **R31-11 Audit and seq.** Row audit on the table (`kernel.enable_row_audit`), `seq` through `core.assign_seq('kernel.document_link')`, id `kernel.uuid_v7()`, `created_by/updated_by`, as `kernel.recommendations`. The links of a removed Borrador are deleted by the definer function and the row audit records it (rule 16). `authenticated` gets `select` only.
- **R31-12 Chain id.** Each row stores `chain_id` = the running process's `ctx.chainId` (the action that created the link). Task text and §22.27: the per-action chain id is unchanged, no flow id is added.

**Files.**
- Create `supabase/migrations/0124_kernel_document_links.sql`, `supabase/migrations/0125_kernel_document_links_backfill.sql`.
- Create `packages/kernel/src/links/links.ts` (zod schemas, `makeLinks(tx, registry, def, chainId)` returning `ctx.links`), `packages/kernel/src/links/trail.process.ts` (the consult `kernel.document_link.trail`, registered with the other kernel processes), `packages/kernel/src/links/index.ts`; export from `packages/kernel/src/index.ts`.
- Modify `packages/kernel/src/process/context.ts` (`links?: LinksApi`), `packages/kernel/src/process/run.ts` (`buildContext` builds it; nested contexts get their own), the kernel registry module list and the baseline grant (`kernel.document_link.%`, as `kernel.recommendation.%`).
- Writers (each calls `ctx.links.sync` in the same transaction as the document write, next to the insert or line write; helper per module in its `processes/common.ts`): `packages/modules/sales/src/processes/order.ts` (create and create-from-quote: `quote_to_order` from `crm.quote`; cancel/void: `markVoided`), `delivery.ts` (create: `order_to_delivery`; void: `markVoided`), `packages/modules/invoicing/src/processes/invoice.ts`, `auto.ts`, `pending.ts` (every path that writes invoice lines with order or delivery ids: `delivery_to_invoice` from the distinct `deliveryId`s, `order_to_invoice` from distinct `orderId`s of lines without a delivery; draft line edits resync; Borrador delete syncs `[]`; void and annul `markVoided`), `packages/modules/payments/src/processes/receipt.ts` (save and allocation edits while Borrador: `invoice_to_receipt`; Borrador delete; `payments.payment.void`: `markVoided`). The implementer lists every writer found by grep of the five tables' inserts and the void processes and records the list in the report.
- Web: `apps/web/src/lib/records/related-load.ts` (runs the trail through the pipeline, resolves titles with the existing resolver, shapes entries), `apps/web/src/app/(app)/r/[entity]/[id]/related-tab.tsx` (+ `page.tsx` wiring and the tab id in `recordTabIds` in `packages/ui`), no module name in the tab.
- i18n `packages/i18n/messages/es-419.json` and `en.json`: `common.record.related.title` «Documentos relacionados», `.tab` same, `.up` «Origen», `.down` «Derivados», `.voided` «Anulado», `.hidden` «Y {count, plural, one {# documento más} other {# documentos más}} que no puedes ver», `.truncated` «Se muestran los primeros {count}», `.empty` «Este documento no tiene documentos relacionados», and the kind names `common.record.related.kind.quote_to_order` «Cotización → Pedido», `.order_to_delivery` «Pedido → Entrega», `.delivery_to_invoice` «Entrega → Factura», `.order_to_invoice` «Pedido → Factura», `.invoice_to_receipt` «Factura → Recibo». The en mirror has the same keys.
- Guide: `docs/user-guide/es-419/documentos-relacionados.md` (what the tab shows, how to read upstream and downstream, «Anulado», the hidden count and why, the limits 6 levels and 100 documents) and its entry in the guide index the assistant reads, plus a line in each of `ventas.md`, `facturacion.md`, `pagos.md` (whichever names exist) pointing to it.

**Migration `0124_kernel_document_links.sql` (forward-only, covered by the integration tests below).**
```sql
create table kernel.document_links (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  from_entity     text not null check (from_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  from_id         uuid not null,
  to_entity       text not null check (to_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  to_id           uuid not null,
  kind            text not null check (kind ~ '^[a-z]+_to_[a-z]+$'),
  origin          text not null default 'process' check (origin in ('process', 'backfill')),
  chain_id        uuid,
  voided_at       timestamptz,
  voided_chain_id uuid,
  void_reason     text check (void_reason is null or length(void_reason) <= 500),
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  check ((from_entity, from_id) is distinct from (to_entity, to_id)),
  check (origin = 'backfill' or chain_id is not null),
  check ((voided_at is null) = (voided_chain_id is null) or origin = 'backfill')
);
create unique index document_links_key_uq on kernel.document_links (company_id, from_entity, from_id, to_entity, to_id, kind);
create index document_links_from_idx on kernel.document_links (company_id, from_entity, from_id);
create index document_links_to_idx   on kernel.document_links (company_id, to_entity, to_id);
create trigger assign_seq before insert on kernel.document_links for each row execute function core.assign_seq('kernel.document_link');
create trigger document_links_touch_updated before update on kernel.document_links for each row execute function kernel.touch_updated();
select kernel.enable_company_rls('kernel', 'document_links');
select kernel.enable_row_audit('kernel', 'document_links');
grant select on kernel.document_links to authenticated;
grant all on kernel.document_links to service_role;
```
(Match the exact helper names and the audit and RLS enabling calls of 0022 and 0123; the `check` on `voided_chain_id` is simplified at implementation if it complicates the backfill, with a ruling.) Then in the same file: `kernel.document_link_writer(p_process text, p_to_entity text) returns text` (definer, the 0123 guard plus the ownership check of R31-2, answers the module); `kernel.document_link_sync(p_process text, p_to_entity text, p_to_id uuid, p_kind text, p_from jsonb) returns table (inserted integer, removed integer)` (definer; validates the existence of the `to` row and every `from` row in the caller's company through `kernel.entity_tables`, advisory lock per `(company, to_entity, to_id, kind)`, selects the missing keys then inserts them with `chain_id = nullif(current_setting('erp.chain_id', true), '')::uuid` (confirm how `setAuditContext` exposes the chain), deletes the extra only when the `to` document is a Borrador and the row is not marked); `kernel.document_link_mark_voided(p_process text, p_entity text, p_id uuid, p_reason text) returns integer` (definer, process-name guard, module must own the entity, sets `voided_at = now(), voided_chain_id`, only rows not yet marked); `kernel.document_trail(p_entity text, p_id uuid, p_direction text default 'both', p_depth integer default 6, p_cap integer default 100) returns table (depth integer, direction text, kind text, entity text, id uuid, voided boolean, visible boolean)` security invoker, stable (R31-6; the visibility of each node through `kernel.can_run_process(entity || '.consult')` and the entity's read view; implementation detail of reading the view by entity name from a function: the implementer follows how `kernel.record_usable` reads `kernel.entity_tables`, and rules in the ledger if the registered read view is not reachable from SQL, in which case the visibility test is a second pass in TypeScript inside the consult process, still before anything is returned); every definer function: `set search_path = ''`, revoke from `public` and `anon`, and each added to `definer-guards.integration.test.ts`.

**Interfaces.**
```ts
// packages/kernel/src/links/links.ts
export const linkEnd = z.object({ entity: z.string().min(1).max(100), id: z.uuid() }).strict();
export const linksSyncInput = z.object({
  to: linkEnd, kind: z.string().regex(/^[a-z]+_to_[a-z]+$/), from: z.array(linkEnd).max(200),
}).strict();
export const linksVoidInput = linkEnd.extend({ reason: z.string().max(500).optional() }).strict();
export interface LinksApi {
  /** Makes the `kind` links into `to` equal `from`; idempotent; writes in the run's transaction under the running process. */
  sync(input: z.input<typeof linksSyncInput>): Promise<{ inserted: number; removed: number }>;
  /** Marks every link of the document as voided (kept, never deleted). */
  markVoided(input: z.input<typeof linksVoidInput>): Promise<{ marked: number }>;
}
// packages/kernel/src/links/trail.process.ts  (kernel.document_link.trail, kind consult)
export const trailInput = z.object({
  entity: z.string(), id: z.uuid(), direction: z.enum(["up", "down", "both"]).default("both"),
  depth: z.number().int().min(1).max(12).default(6), cap: z.number().int().min(1).max(500).default(100),
}).strict();
export interface TrailNode { direction: "up" | "down"; depth: number; kind: string; entity: string; id: string; voided: boolean }
export interface TrailResult { nodes: TrailNode[]; hidden: number; truncated: boolean }
```
`sync` and `markVoided` refuse (`forbidden`) from a consult or delete process, `invalid_input` on an unregistered entity or kind pattern; in a dry run they write inside the rolled-back transaction.

**Tests first (rule 31); each must fail before the code.**
1. `packages/kernel/src/links/__tests__/document-links.integration.test.ts` (probe module with `probe.doc` entities `probe.quote`, `probe.order`, `probe.delivery`, `probe.invoice`, `probe.receipt`, a probe create process per kind, a probe void, a consult): `sync` inserts one row per `from` with the running chain id, a gap-free `seq` and company; the same `sync` twice leaves one row and the same `max(seq)`; **many-to-many**: one quote→two orders, one order from two quotes, two orders→one delivery, one delivery covering two orders' links, one invoice from two deliveries, one receipt over two invoices (each shape built through probe processes, read back both directions); `from: []` on a Borrador removes its links and on a non-Borrador removes nothing; `markVoided` keeps the rows with `voided_at` and the chain; a second `markVoided` marks nothing more; refused: `sync` from a consult, outside a run (plain SQL as authenticated), with another process's name, for a `to` entity the process's module does not own, with a missing `to` or `from` row, across companies (a `from` id of another company), an invalid kind; `authenticated` cannot insert, update or delete directly; RLS: company B sees none of company A's links and cannot walk to them; a rolled-back run leaves no link and no `seq` burned (the dry-run case).
2. Same file, **trail**: walk up and down from a middle node returns both sides at the right depths; the default depth 6 cuts a chain of 9 (`truncated` true, 6 levels returned); `depth` over 12 and `cap` over 500 are refused; the cap of 3 on a fan-out of 10 returns 3 and `truncated`; a cycle (A→B→A forced through the service role) terminates and returns each node once; **masking**: a viewer without `probe.invoice.consult` gets the invoice counted in `hidden`, never named (no id, no number in the result, the process output and the SQL function output compared), while the quote and receipt on either side are still returned; a viewer with the consult but whose RLS hides the row (party scope) gets the same; a field-hidden role is unaffected (links carry no field); the assistant's consult of `kernel.document_link.trail` returns the same masked, capped result.
3. `packages/kernel/src/links/__tests__/links.test.ts` (unit): the zod schemas, kind pattern, caps, `makeLinks` refusals that need no database.
4. `packages/modules/invoicing/src/__tests__/document-links.integration.test.ts` (uses `chain-helpers.ts`): a full 2B.1 sale through the real processes produces `quote_to_order`, `order_to_delivery`, `delivery_to_invoice`, `invoice_to_receipt` with four distinct chain ids (and the order confirmation, its automatic invoice and DIAN submission sharing one); a quote re-ordered after cancelling the first order shows two orders; one order delivered twice gives two links; an invoice from two deliveries gives two `delivery_to_invoice` rows, one on two orders gives `order_to_invoice` for a no-delivery line; a receipt over two invoices gives two `invoice_to_receipt`; editing a draft invoice's lines resyncs; deleting a Borrador invoice and a Borrador receipt removes their links; voiding the receipt, the delivery, the order and the invoice marks their links and leaves them in the trail as `voided`; no process of the five writes a link outside `ctx.links` (a grep-style guard test over the sources of those modules for `document_links`).
5. `packages/kernel/src/links/__tests__/document-links-backfill.integration.test.ts`: on a database seeded as the demo company (the existing chain helpers, 2B.1 data created with the writers' `sync` disabled by truncating `kernel.document_links` through the service role), running the body of `0125` (extracted as a function the test calls, or the file applied to a clean schema by the harness; the implementer follows how `0113` or `0112` backfills are tested) fills one row per source relation; counts equal the distinct pairs in the source tables; voided orders, deliveries, invoices and receipts give marked rows; a second run adds nothing; `origin = 'backfill'` and a null chain.
6. `packages/kernel/src/__tests__/definer-guards.integration.test.ts` (extend): the four new definer functions are listed and refuse a call outside the named process.
7. `packages/i18n` catalogue parity test (existing) for the new keys; `packages/ui` unit test of the tab model (`relacionados` appears only when there are nodes or hidden, order up before down, voided flag, hidden and truncated lines).
8. `apps/web/e2e/related-documents.spec.ts` (production build, as CI): run the chain through the pipeline (the seeded demo sale, or the helper the `sales-chain` spec uses), open the invoice, open the tab «Documentos relacionados», see the quote, the order, the delivery and the receipt, each a link, click each and land on its record page (title shows its number); open the quote and see the order, delivery, invoice and receipt downstream; a user without consult on invoices opening the order sees the hidden line and no invoice number; a voided receipt shows «Anulado».

**Order of work.** Tests 1–3 and 6 red → `0124`, `links.ts`, context and `run.ts`, trail process → green; test 4 red → writers → green; test 5 red → `0125` → green; test 7 and 8 red → web, i18n, guide → green; full verification (lint, typecheck, check:rules, unit, the touched integration files, the touched e2e spec on the production build, the build).

**Review focus of this task** (most capable reviewer, design and security): masking in every channel (consult process, SQL function, tab, assistant) and that hidden nodes are neither named nor leaked through the `kind` or `via` of a visible one; the definer functions (search_path, process-name guard, module ownership of `to`, company from the claims, existence checks across companies); tenant isolation (same ids in two companies); idempotency and gap-free `seq`; that no module writes the table except through `ctx.links`; the Borrador removal rule and that a void never deletes; depth, size and cycle limits; the backfill's fidelity and idempotency; every entry a link (rule 21).

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
