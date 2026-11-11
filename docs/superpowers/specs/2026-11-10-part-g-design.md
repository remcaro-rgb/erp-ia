# ERP-IA · Part G of Phase 2B.2 (Tasks 28, 29, 30) — Design

Date: 2026-11-10 · Status: **approved by the owner in chat 2026-11-10** (items 144–149, 151–158, 162–164 as recommended; items 150, 159–161 as recommended pending the accountant) of `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md` · Plan: Part G outline of `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md` (Tasks 28–30), to be expanded after approval · Rests on: `docs/project-rules.md`; main design §5, §8, §8.1, §5.12, §22.25 (OD-5, OD-6, OD-8), §22.27, §22.28, §22.29, §22.30; accounting design §5.2, §5.3, §5.9, §5.11; entity types spec §2, §5, §9.

This note never edits §22 or the rules. Where a proposal needs an owner decision it says so and names the item.

## 0. Intent, goals, non-goals

**Intent.** Café del Norte sells packed coffee with a roast date and a best-before date, and some equipment (grinders) with a serial number. It must know which lot went to which customer (a recall), sell the oldest-expiring lot first, pick and pack orders from shelves, put received goods on the right shelf, and owe its salespeople and agents a commission that shows in the ledger and in the payables aging.

**Goals.**
- Lots and serials tracked on every stock movement, stock bucket, delivery, return and invoice line, with FEFO issue and a recall report (Task 28).
- A `warehouse` module that turns a confirmed order into a pick list, a confirmed pick into a draft delivery, and a receipt into put-away suggestions by product category (Task 29).
- Commission plans, a commission document that posts a CxP provision, accrued on invoice or on collection as the company's setting says, reversed by annulment, credit note or receipt void (Task 30).

**Non-goals (2B.2).** FIFO or per-lot costing (OD-5, phase 3). Paying commissions (phase 3 disbursements). Payroll treatment of employee commissions (payroll module). Wave picking, routes, carriers, tracking numbers (item 33 left carrier and tracking for later). Multi-level bins (one level of location is enough). Purchases receipts (no purchases module yet: put-away reads inventory receipts).

**Anti-goals.** A serial in stock twice. A lot quantity that drifts from the sum of its movements. A module reading another module's tables (rule 3). A PUC code in module or kernel source (rule 5). A commission that sums to more than the plan's rate of what was collected. A pick that moves stock behind the reservation's back.

## 1. What exists today (verified 2026-11-10, file:line)

| Area | State |
|---|---|
| Lot/serial columns | `lot_id uuid`, `serial_id uuid`, nullable, **no FK**, only on `inventory.movement_lines` (0066:98-99) and `inventory.stock_levels` (0066:130-131); the stock bucket key is `(company_id, product_id, warehouse_id, location_id, lot_id, serial_id) nulls not distinct` (0066:142). Masked views expose them (0066:434-457) |
| Lot/serial code | none: no `inventory.lot` / `inventory.serial` table or type; every process filters `lot_id is null and serial_id is null` (movement.ts:142, count.ts:133, sales-deliveries.ts:109, 0087:34, :99); transfers and adjustments never mention them |
| Reservations | `inventory.reservations` per order line and bodega, nullable `location_id` («null until picking»), **no lot/serial**; one active row per source line (0068:8) |
| Locations | `inventory.locations` one level under the warehouse, `kind storage|transit` (0066:37-51); no bins |
| Costing | one weighted-average layer per product and warehouse (`cost_layers_average_key`, 0073:20, :45); no lot or location dimension; FIFO columns pre-provisioned (0073:16-18) |
| Deliveries | `sales.delivery_lines` carry order line, product, qty, invoiced qty, movement; **no lot, serial or location**; `sales.delivery.shipped` payload `{deliveryId, number, orderId, orderNumber, partyId, warehouseId, date, costCenterId?, lines:[{lineId, lineNo, orderLineId, productId, qty}]}` (delivery.ts:421-430); inventory issues in `inventory.sale.issue` choosing one bucket per line (`pickBuckets`, sales-deliveries.ts:102-135) |
| Invoice lines | `invoicing.invoice_lines` have `product_id`, `category_id`, `order_line_id`, `delivery_line_id` (0092:101-135); no lot. `invoicing.invoice.issued` carries `orderIds[]` and `deliveryIds[]`, but its `lines` are revenue lines only (`{subtotal, subtotalDoc, categoryId, costCenterId?}`; free samples and zero-base lines left out, common.ts:212), with no line id, product, order line or salesperson (invoice.ts:736-751). `invoicing.note.issued` lines carry only subtotal, category and cost center (note.ts:568) |
| Sales consumers | sales already consumes `invoicing.invoice.issued` and `invoicing.invoice.annulled` (delivery invoicing, `onInvoiceIssued` / `onInvoiceAnnulled`, delivery.ts:607-623) and reads invoicing's published views (sales/src/index.ts:30-32, :56-58); one consumer per event and module |
| Availability | `inventory.sale_stock` and the reservation availability filter `lot_id is null` (0087:34, :99), as does `pickBuckets` |
| Paid events | `invoicing.invoice.paid` fires only when an invoice becomes fully paid, no lines (consumers/payments.ts:30, :76-84). Partial collections are visible only in `payments.received.allocations[{invoiceId, amount, amountReceipt, amountCompany, withholdings}]` (receipt.ts:742-762); void is `payments.payment.voided` with allocations; advance applications emit `ADVANCE_APPLIED` / `ADVANCE_UNAPPLIED` (payments/src/index.ts:33) |
| Notes | `invoicing.note.issued` (`kind`, `annulment`, `reasonCode`, `invoiceId`, signed lines) (note.ts:554-575); `invoicing.invoice.annulled` on an accepted annulment (einvoice.ts:506) |
| Salesperson | `sales.orders.owner_id` is a **user** (0084:39, owner rule 0139); no party behind a user; invoices have no seller field; party kinds are `customer, supplier, employee` (0006:1240) |
| Sales manifest | `dependsOn: ["core"]`, no `accountRoles`, no `postingRules` (sales/src/index.ts:34-76); `sales.settings` one row per company with typed columns, upserted by `sales.settings.update` (pricing.ts:28-58) |
| Roles | a module declares extra roles in `accountRoles` (payments: `fx_gain`, `fx_loss`, payments/src/index.ts:54); enabling refuses roles the pack does not map (kernel/src/admin/modules.ts:35-41); mappings may be narrowed by a dimension (role-mappings.ts:15-18); existing companies get new mappings by migration (0151:47) |
| CxP aging | open items are derived from ledger lines: a credit with a party on an account of a PUC group holding an account mapped to `payable` or `%_payable`, with `requires_party` (0112:89-125, 0153:360-380). So `commissions_payable` enters aging by its name alone |
| DIAN | no lot, serial or expiry in the UBL builder (`<cac:Item>`, xml-builder.ts:298) |
| Dispatcher | for a never-bought module, an **explicit** consumer of another module's event is dead-lettered `not_entitled:<module>` (visible, replayed on purchase; item 9); only `kernel.*` events and a `"*"` consumer of a module without posting provider are skipped silently (dispatch.workflow.ts:55-63, :104-111; item 111) |
| Last migration | `0155_costing_landed_cogs.sql` |

## 2. Order and parallelism

**Proposed.** Task 30 (commissions) touches no stock and none of the inventory files; it shares only the sales manifest, `packages/i18n/messages/*.json` and the demo seed with Task 28. Task 29 needs lots: a pick must say which lot and serial it takes, and FEFO must exist before picking can follow it. So the order is **30 ∥ 28 → 29**, not the outline's 28 ∥ 29 → 30.

Migration blocks, so parallel worktrees never collide: **30 → 0156–0161**, **28 → 0162–0169**, **29 → 0170–0177**. A sub-task takes the next free number of its block. If a block runs out it stops and reports.

**Rule or decision it rests on.** Rule 3 (cross-module through views and events), plan «Order and parallelism» (serialise i18n merges).

**Open question.** Item 144: is the reorder acceptable?

## 3. Task 28 · Lots and serials

### 3.1 Data model

| Change | Table | Notes |
|---|---|---|
| new maestro | `inventory.lots` (`inventory.lot`) | `product_id` (core ref), `code` (text, unique per company and product), `expires_on date` (nullable), `produced_on date` (nullable), `status active | blocked`, `note`; rule 7 columns, RLS, audit |
| new maestro | `inventory.serials` (`inventory.serial`) | `product_id`, `serial_no` (unique per company and product), `lot_id` (nullable, FK `inventory.lots`), `status available | issued | scrapped` (kept by the processes, read only on the form), `note` |
| new parametro | `inventory.product_tracking` (`inventory.product_tracking`) | one row per product: `tracking none | lot | serial` (default none), `fefo boolean default true`, `expiry_required boolean default false`, `block_expired boolean default true`. Inventory owns it because `core.products` is core's table (rule 3) |
| FK added | `movement_lines.lot_id/serial_id`, `stock_levels.lot_id/serial_id` → `inventory.lots/serials` | same schema, allowed |
| check added | `stock_levels` | `serial_id is null or on_hand between 0 and 1` (serial quantity ±1) |
| columns | `inventory.movements.party_id` (nullable, core ref) | the shipped and return events carry `partyId`; storing it lets the recall report name the customer without inventory reading sales (rule 3) |
| new table | `inventory.reservation_allocations` (sistema) | `reservation_id`, `location_id`, `lot_id`, `serial_id`, `qty`: used by Task 29; created here empty so 29 adds no inventory migration for it. One reservation can be split over several lots (the one-active-row-per-line index stays) |
| columns | `sales.delivery_lines.lot_id`, `serial_ids uuid[]` (nullable), `sales.return_lines` the same | what the user asked for; inventory answers with what it issued (3.3) |
| columns | `sales.delivery_line_lots` (sistema) | `delivery_line_id`, `lot_id`, `lot_code`, `expires_on`, `serial_id`, `serial_no`, `qty`: what inventory actually issued, written by sales' consumer of the result event |
| columns | `invoicing.invoice_lines.lots jsonb` (nullable) | `[{lotCode, expiresOn, serialNo, qty}]` copied at «Emitir» from `sales.v_delivery_line_lots`, frozen with the line |

**Proposed.** The above. A lot code is free text the user types or scans; it is unique per product (the same supplier lot code may exist on two products).

**Rule or decision it rests on.** Rules 3, 7, 12, 14 (the new entity views use the `field_visible` pattern), 34; Task 6 left the columns «so that task needs no rewrite».

**Open question.** Item 145 (a lot belongs to one product, codes unique per product).

### 3.2 Receipts, transfers, adjustments, counts

- **Receipt** (`inventory.movement.post` kind `receipt`, and any other inbound kind): a line of a lot-tracked product must name a lot: an existing `lotId`, or `lot: { code, expiresOn?, producedOn? }`, which creates the lot through `inventory.lot.create` nested in the run (own permission, same chain, Task 32). `expiry_required` refuses a lot without `expiresOn`. A serial-tracked line must list `serials: [{ serialNo }]` whose count equals the quantity, each new serial created nested, each bucket at 1. Refusals: `lot_required`, `serials_count_mismatch`, `serial_exists`, `expiry_required`.
- **Issue and transfer out**: a tracked line names its lot or serials, or (lots only) lets the process choose by FEFO (3.3). A serial must be `available` and on hand in that bodega and location; otherwise `serial_not_in_stock`. Issue sets it `issued`; receipt or return sets it back to `available`.
- **Transfers** carry lot and serials through the in-transit location unchanged (two movements, same buckets).
- **Adjustments** (step-up, unchanged) name the lot or serial of each line; a positive adjustment of a serial creates it.
- **Counts** count by bucket: a lot-tracked product is counted per lot (the count sheet lists each lot with stock and lets the counter add a lot found); a serial-tracked product is counted by scanning serials (found / missing). Applying the count posts one adjustment line per bucket difference, as today.
- An untracked product behaves byte for byte as today (lot and serial null).

**Rule or decision it rests on.** Rule 1 (nested create through `ctx.runProcess`, §22.28), rule 15 (adjustment step-up unchanged).

**Open question.** Item 146: a product that already has stock when its tracking is switched on.

### 3.3 FEFO and sales issue

- `inventory.sale.issue` today picks one bucket per line. With tracking: if the delivery line names a lot (or serials), it issues from it, refusing `lot_short` or `serial_not_in_stock`; otherwise, for a lot product with `fefo = true`, it splits the line over the bodega's lots by earliest `expires_on` (null expiry last, then oldest `produced_on`, then code), skipping `blocked` lots and, when `block_expired`, lots expired at the delivery date. One movement line per bucket used. A line it cannot fill refuses as today (`inventory.sale_issue.refused`, all or nothing per delivery).
- A serial-tracked line without serials is refused at ship (`serials_required`): serials are scanned, never chosen by the system.
- Inventory then emits `inventory.sale_issue.allocated { deliveryId, lines: [{ deliveryLineId, lotId, lotCode, expiresOn, serialId, serialNo, qty }] }`; sales' consumer writes `sales.delivery_line_lots` (idempotent on the event), the delivery shows «Lotes y seriales» per line, and the delivery PDF prints them.
- Returns: a return line names the lot or serial coming back; the screen defaults it from the delivery's `delivery_line_lots`. Stock goes back to that bucket at the original issue cost, as today.
- The reservation stays at product and bodega level (no lot) in Task 28: FEFO chooses at issue. Task 29 adds lot allocation through picking.

**Proposed.** As above. **Rule or decision it rests on.** Rule 3 (sales asks by event, inventory answers by event, as Task 43 did); Review Focus 1 (one movement per delivery line becomes one movement per delivery line and bucket, keyed on the line and lot).

**Open questions.** Item 147 (expired lots refused on sale), item 148 (reservation of a specific lot asked by the customer).

### 3.4 Costing

**Proposed.** Cost stays per product and bodega (one weighted-average layer, OD-5). A lot carries no cost of its own; every lot of a product in a bodega issues at the layer's average. Costing ignores lot and serial on the movement event and needs no change.

**Rule or decision it rests on.** OD-5 (FIFO in phase 3), Task 8.

**Open question.** Item 149 (confirm; per-lot cost would need a layer per lot, i.e. specific identification, close to FIFO's work).

### 3.5 Invoice and DIAN

**Proposed.** At «Emitir» invoicing copies each delivery-billed line's lots from `sales.v_delivery_line_lots` (published by sales, read by a process, rule 3) into `invoice_lines.lots`; the invoice PDF shows «Lote / Vence / Serie» under the line. The UBL: UBL 2.1 has `cac:Item/cac:ItemInstance` (`cbc:SerialID`, `cac:LotIdentification/cbc:LotNumberID`, `cbc:ExpiryDate`), but I have not verified that the DIAN Anexo técnico 1.9 validates or requires them. The pack (`packages/localization/co`) gains `itemInstanceXml(line)` behind a pack setting, off until the accountant or a DIAN check confirms it passes the validator; the golden files change only when it is on.

**Rule or decision it rests on.** Rule 5 (fiscal format in the pack), §5.8b.

**Open question.** Item 150 (accountant / DIAN: put lot data in the XML or only on the PDF).

### 3.6 Recall

**Proposed.** `inventory.report.lot_trace` (consult; inputs `lotId` or `serialId`, optional date range): every movement of the lot with date, kind, bodega, quantity, source document (link, rule 21, through the Task 31 links) and customer (`movements.party_id`), plus stock on hand by bodega. Exportable (rule 20). A menu item under Inventario › Reportes «Trazabilidad de lotes». The assistant gets it as a consult tool, capped and masked (rule 17).

**Rule or decision it rests on.** Rules 14, 17, 20, 21.

### 3.7 Processes (Task 28)

| Process | Kind | Sensitivity | Effects / notes |
|---|---|---|---|
| `inventory.lot.create/update/consult` | create / update / consult | normal | maestro; nested from receipts |
| `inventory.serial.create/update/consult` | create / update / consult | normal | maestro; status read only |
| `inventory.product_tracking.set` | update | **step-up** (it changes how every later movement is validated) | refuses switching a product with stock unless item 146 says otherwise |
| `inventory.report.lot_trace` | consult | normal | recall |
| changed: `inventory.movement.post`, `transfer.*`, `adjustment.post`, `count.*`, `sale.issue`, `sale.void_issue`, `return` consumer | — | as today | lot and serial inputs and checks |
| changed: `sales.delivery.create/update/ship`, `sales.return.create/receive` | — | as today | lot and serial on the lines; event payload lines gain `lotId?`, `serialIds?` |
| changed: `inventory.sale_stock`, `inventory.v_stock`, reservation availability (`inventory.reservation.create`) | — | as today | sum every bucket of the product, lots included, **minus blocked lots and, when `block_expired`, lots expired at the date**; today they read only `lot_id is null`, so a lot-tracked product would show no stock to `sales.order.confirm` |
| new: `sales.delivery.record_lots` | update | normal, `origins: ["event"]` | consumer of `inventory.sale_issue.allocated` |

Field visibility: lot code and expiry are `normal` sensitivity; serial numbers `normal`. Permissions: lots and serials under feature `inventory.stock` (same roles as movements).

## 4. Task 29 · Picking, packing and put-away (`warehouse` module)

### 4.1 Module

**Proposed.** New module `warehouse`, schema `warehouse`, `dependsOn: ["core", "inventory"]`, entitlement `module:warehouse`. It consumes `sales.order.confirmed`, `sales.order.cancelled`, `inventory.movement.posted` (receipts) and reads `inventory.v_stock`, `inventory.v_locations` and `inventory.v_lots` (published). It never names sales in code beyond event ids (data). Bins are **inventory locations** (one level, kind `storage`): stock is already keyed by location, so a pick or put-away that names a location needs no new stock table. Warehouse's consumers are explicit (`sales.order.confirmed`, `sales.order.cancelled`, `inventory.movement.posted`, `inventory.reservation.allocated`), so for a company that never bought it the dispatcher dead-letters each such event `not_entitled:warehouse` and replays them on purchase (item 9, as for every optional module today). **Proposed:** keep the kernel as is; on replay `warehouse.pick.create` answers «nothing» for an order confirmed before the module was enabled for the company or already fully delivered, and put-away ignores old receipts, so buying the module later creates no picks for past orders. A `"*"` consumer that filters inside would avoid the parked rows but hides warehouse's real subscriptions from the effects check (item 3). Item 164 asks.

**Rule or decision it rests on.** Rules 3, 4; main §8 table lists «locations, bins» under warehouse, but the 2B plan's «Calls I made», ratified in §22.25, put locations in inventory. This note keeps that call and treats a bin as an inventory location; it is not a deviation, but the owner should see it (item 151).

### 4.2 Data model

| Table | Type | Fields |
|---|---|---|
| `warehouse.picks` (`warehouse.pick`) | documento, `contabiliza` false, numbering `on_save` (prefix `ALI-`) | `order_id`, `order_number`, `warehouse_id`, `party_id`, `status` (borrador → en_proceso → confirmado / anulado, entity types §5), `picker_user_id` |
| `warehouse.pick_lines` | lines | `order_line_id`, `product_id`, `qty_requested`, `location_id`, `lot_id`, `serial_id`, `qty_picked` |
| `warehouse.packs` (`warehouse.pack`) | documento (prefix `EMP-`) | `pick_id`, `status`, packages count, total weight (kg, manual) |
| `warehouse.pack_packages` | lines | package no, weight, dimensions (text), lines `[pick_line_id, qty]` |
| `warehouse.putaway_rules` (`warehouse.putaway_rule`) | parametro | `warehouse_id`, `category_id` (core ref, nullable = any), `location_id`, `priority` |
| `warehouse.settings` | parametro | `auto_pick_on_confirm boolean default true`, `delivery_from_pick boolean default true` |

### 4.3 Flow

1. `sales.order.confirmed` → `warehouse.pick.create` (origin event, idempotent on the order) when `auto_pick_on_confirm`; also a manual «Crear alistamiento» from the pedido (a menu action of warehouse's manifest placed on the order record, like Task 42's cross-module shortcut). The pick proposes, per order line, the location and lot from `inventory.v_stock` by FEFO, then by the location with most stock.
2. The picker edits and confirms what was taken (`warehouse.pick.confirm`, scanner input allowed: product, lot, serial). It emits `warehouse.pick.confirmed { pickId, orderId, warehouseId, lines: [{ orderLineId, productId, locationId, lotId, serialId, qty }] }`.
3. Inventory consumes it: `inventory.reservation.allocate` (origin event) writes `reservation_allocations` (location, lot, serial, qty) for each order line, all or nothing, refusing what is not on hand (`allocation_short`), and emits `inventory.reservation.allocated { pickId, orderId, status: allocated | short, lines, short[] }` carrying the pick's `createDelivery` flag. **No stock moves at pick**: stock moves only at delivery ship, so Review Focus 1 holds unchanged.
4. Sales consumes **inventory's result**, not the pick: on `allocated` with `createDelivery` (warehouse's `delivery_from_pick`), `sales.delivery.create` runs with origin event and the allocated lines (lot, serials, location), leaving a Borrador entrega the user ships; on `short` nothing is created. Warehouse consumes the result too: `short` sends the pick back to «En proceso» with the short lines named (`warehouse.pick.record_allocation`). A manual entrega without a pick stays allowed.
5. At ship, `inventory.sale.issue` issues from the reservation's allocations when they exist (same location, lot, serial), else as in 3.3.
6. Packing: `warehouse.pack.create` from a confirmed pick, packages edited by hand, `warehouse.pack.close`; PDF «Lista de empaque» (packages, lines, lots, weights). Packing is optional and gates nothing.
7. Cancel: `sales.order.cancelled` → `warehouse.pick.void` of open picks of the order (origin event); inventory's release drops the allocations with the reservation.
8. Put-away: `warehouse.putaway.suggest` (consult) on a receipt movement lists, per line, the location by rule (category, then any, by priority; a lot stays together). `warehouse.putaway.confirm` emits `warehouse.putaway.confirmed { movementId, lines: [{ productId, lotId, serialId, qty, fromLocationId, toLocationId }] }`; inventory consumes it with a new `inventory.relocation.post` (movement kind `relocation`, two lines in one bodega, no cost effect: costing ignores a same-bodega relocation).

**Rule or decision it rests on.** Rules 1, 3; §8.1 step 3 («warehouse → pick list»); Task 43 (sales asks, inventory answers by event).

**Open questions.** Item 152 (does a delivery become pick-driven?), item 153 (pick moves stock to a staging location or not), item 154 (is packing needed in 2B.2), item 155 (put-away as a suggestion the user confirms vs automatic).

### 4.4 Processes (Task 29)

| Process | Kind | Sensitivity | Notes |
|---|---|---|---|
| `warehouse.pick.create/update/start/confirm/void/consult` | lifecycle | normal | create callable from event and UI |
| `warehouse.pick.record_allocation` | update | normal, `origins: ["event"]` | consumer of `inventory.reservation.allocated` |
| `warehouse.pack.create/update/close/void/consult` | lifecycle | normal | |
| `warehouse.putaway_rule.create/update/delete/consult` | parametro | normal (admin may raise) | |
| `warehouse.putaway.suggest` | consult | normal | |
| `warehouse.putaway.confirm` | update | normal | emits the relocation event |
| `warehouse.settings.update` | update | admin, step-up by default (admin processes, rule 15) | |
| new in inventory: `inventory.reservation.allocate`, `inventory.relocation.post` | update | normal, origins event (relocation also ui) | |

Effects declared in the manifests (`ModuleDef.effects`, item 3): «Inventario: asigna ubicación y lote a la reserva», «Ventas: crea la entrega en borrador», «Inventario: reubica existencias». Menu: Bodega › Documentos (Alistamientos, Empaques), Parámetros (Reglas de ubicación, Configuración), Reportes (Pendientes por alistar). i18n namespace `warehouse.*`. Guide `docs/user-guide/es-419/bodega.md`.

## 5. Task 30 · Commissions with a CxP provision (OD-6)

### 5.1 Who earns, on what

- The salesperson of a sale is the **order owner** (`sales.orders.owner_id`, a user, Task 39). A user is not a party, and a payable needs a party. **Proposed:** `sales.commission_plans` (maestro) names the `payee_party_id` (a core party of kind employee or supplier), `payee_kind employee | agent`, and the **users** whose orders it covers (`sales.commission_plan_users`), plus a default rate and per-category rates (`sales.commission_plan_lines(category_id, rate_pct)`); `valid_from`, `valid_to`, `active`; `payment_days` (default 30, the provision's due date for aging). One active plan per user at a date (refused otherwise, `commission_plan_overlap`). «Flat» in the outline is read as one percentage for every category (a fixed amount per sale is not offered).
- **Base**: the invoice line subtotal before taxes, after discounts, in company currency (`subtotal` of the issued event, company amount since 34.4), of lines billed from an order. A line whose category has no rate takes the plan's default rate (0 allowed).
- **An invoice not billed from an order** has no salesperson and earns no commission in 2B.2.
- An invoice covering orders of two salespeople produces one commission per salesperson.

**Rule or decision it rests on.** Rule 10 (the payee on a payable line is `invoice_ready` when its account is flagged; a payee party must be complete), §22.28 (order owner), OD-6.

**Open questions.** Item 156 (payee model), item 157 (invoices without an order), item 158 (base before taxes, net of discounts).

### 5.2 Accrual

- `invoicing.invoice.issued` gains a `commissionLines` array: one entry per invoice line billed from an order, `{ invoiceLineId, orderLineId, productId, categoryId, subtotal, subtotalDoc, costCenterId? }` (additive; the existing `lines` stay the revenue lines they are). `invoicing.note.issued` lines gain `invoiceLineId`. Both are invoicing changes of Task 30.
- Sales already consumes `invoicing.invoice.issued` for delivery invoicing (one consumer per event). Its consumer only **writes the bases** (`sales.commission_bases`, sistema, **one row per invoice line billed from an order**: payee, plan, rate frozen at the invoice date, base, commission, accrued so far) and emits its own `sales.commission.due { invoiceId, basis }`. A second sales consumer, of that event, runs `sales.commission.accrue` and posts. So a commission that cannot post (payee not `invoice_ready`, ledger not started, closed period) dead-letters or retries only `sales.commission.due`, never the delivery invoicing. The plan form also refuses a payee that is not `invoice_ready` (rule 10), so the common case fails at save, not at event time.
- **`on_invoice`**: the `due` consumer creates and posts one `sales.commission` documento per payee for the full amount (`accrued`).
- **`on_collection`**: sales consumes `payments.received` and the advance application event (`ADVANCE_APPLIED`). Payments adds to each allocation `openAfterDoc`, the invoice's open balance after it in document currency (payments already reads it for the allocation). For each allocation to an invoice with bases, `sales.commission.accrue` posts `remaining × settled / (settled + openAfterDoc)` per base, where «remaining» is the base's commission not yet accrued and «settled» is what the receivable was reduced by (cash plus withholdings suffered), all in **document currency** (an exchange difference never changes a commission). The allocation that leaves `openAfterDoc = 0` takes the whole remainder, so the accruals add up exactly to the commission net of credit notes, to the cent, and sales reads no invoicing balance. `invoicing.invoice.paid` is not used: it fires only at full payment.
- Each commission documento is numbered (`COM-`), dated the source document's date, `contabiliza` true, posted inline in the same run (posting mode per Task 33), and linked in the document trail (Task 31: invoice→commission, receipt→commission).
- The basis is read at the moment of each source event; changing it affects later invoices only (bases already written keep the basis they were made under).

### 5.3 Reversal

- **Annulment credit note** (`invoicing.note.issued` with `annulment`, or `invoicing.invoice.annulled`): every unpaid commission of the invoice is reversed (`sales.commission.reverse`, `reverseOf` the accrual entry) and the base is closed.
- **Partial credit note** (a return or discount): the bases are reduced by the note's lines (matched by the new `invoiceLineId`); under `on_invoice` a negative commission documento posts the difference (the engine flips sides on a negative amount); under `on_collection` the remaining base shrinks and later collections accrue on it.
- **Receipt void** (`payments.payment.voided`) and advance unapplication: the commissions created from that receipt or application are reversed whole.
- A commission already paid is never reversed automatically: the run raises a recommendation (Task 38 API) to the role holding `sales.commission.reverse`. In 2B.2 nothing can be paid (payments of commissions are phase 3), so this path is defined and tested with a status set by a fixture only.

### 5.4 Accounting

- The sales manifest gains `accountRoles: ["commission_expense", "commissions_payable"]` and `postingRules` for `sales.commission.accrued` (Dr `commission_expense`, cost center of the invoice line, dimension `payee_kind:{{payeeKind}}` / Cr `commissions_payable`, party = payee, dimension `payee_kind:{{payeeKind}}`, `dueDate` = date + plan `payment_days`) and `sales.commission.reversed` (`reverseOf`).
- The Colombia pack maps both roles, by payee kind. Suggested by the outline, **for the accountant to confirm or correct**: expense employee → `5205` (gastos de personal, ventas), agent → `5235` (servicios); payable employee → a `2505` (salarios por pagar) or `2335` (costos y gastos por pagar) subcuenta, agent → `2335` or `2380` (acreedores varios). The PUC seed has `5205`, `5235`, `2335`, `2380`, `2505` but no `520518` (comisiones) subcuenta; a new subcuenta goes through the pack's `extraAccounts`. A migration adds the mappings to companies that already have a chart (the 0151 pattern), so enabling sales never fails on an unmapped role.
- Aging: `commissions_payable` ends in `_payable`, so its account's PUC group enters CxP aging for the payee with no accounting change (0112). The payable account is flagged `requires_party` and `requires_invoice_ready` (rule 10, §22.22: payables are flagged by default).
- Withholding at source on an agent's commission: **proposed** at payment (phase 3); the accrual posts the gross amount. The accountant may require it at accrual (when the cost is recognised), which adds a `withholding_income_payable` credit line to the rule (item 161).
- No PUC code in module source (rule 5): the codes live only in `packages/localization/co`.

**Rule or decision it rests on.** OD-6, accounting design §5.2–§5.3 and §5.11, rules 5, 10.

**Open questions.** Item 159 (accountant: accounts by payee kind), item 160 (accountant: employee commissions as salary), item 161 (accountant: withholding at accrual or at payment), item 162 (default basis).

### 5.5 Processes (Task 30)

| Process | Kind | Sensitivity | Notes |
|---|---|---|---|
| `sales.commission_plan.create/update/consult` | maestro | normal (admin may raise) | users, category lines |
| `sales.commission.compute` | create | normal, `origins: ["event"]` | bases at invoice issue, run from the existing `onInvoiceIssued`; emits `sales.commission.due` |
| `sales.commission.accrue` | create | normal, `origins: ["event"]` | consumer of `sales.commission.due` (on invoice) and `payments.received` / `ADVANCE_APPLIED` (on collection); documento + inline posting |
| changed: `invoicing.note.issue` | — | — | payload lines gain `invoiceLineId` |
| changed: `payments.payment.receive`, `payments.advance.apply` | — | — | allocations gain `openAfterDoc` |
| `sales.commission.reverse` | update | normal, origins event and ui (ui only for the flagged paid case, phase 3) | `reverseOf` |
| `sales.commission.consult`, `sales.report.commissions` | consult | normal | by payee, period, status; export |
| changed: `sales.settings.update` | update | admin | `commissionBasis` |
| changed: `invoicing.invoice.issue` | — | — | payload gains `commissionLines` |

Field visibility: rates and amounts of a commission are `confidential` by default (visible to admin and the sales manager role, masked for others). **Proposed** record rule: a salesperson sees only the commissions of plans that list their user; an «all commissions» permission (like Task 39's «all orders») lifts it for managers and accounting. Menu: Ventas › Maestros «Planes de comisión», Documentos «Comisiones», Reportes «Comisiones por vendedor». Guide `docs/user-guide/es-419/comisiones.md`. Assistant: consult tools and the plan maestro; accrual and reversal are event-only and not assistant tools.

**Open question.** Item 163 (who sees commissions).

## 6. Common to the three tasks

- **Migrations** forward-only in the blocks of §2, each covered by an integration test (rule 34); views regenerated with the `field_visible` pattern, kept in sync by each module's `entities.test.ts`.
- **RLS and visibility**: every new table `kernel.enable_company_rls()` and `kernel.enable_row_audit()` (rules 12, 16); every entity a masked view (rule 14).
- **Assistant** (rule 17): every new UI process is a tool behind a confirmation card with effects; event-only processes are not tools; the eval set gains Spanish cases (rule 30): «¿a qué clientes fue el lote L-2311?», «crea un alistamiento para el pedido 18», «¿cuánto le debemos en comisiones a Andrea?».
- **i18n** (rule 24): `inventory.*`, `warehouse.*`, `sales.*`, registry keys in their kinds, `en` mirror.
- **Guides** (rule 35): `inventario.md` (lots, serials, FEFO, recall), `entregas.md`, `devoluciones` section, `facturacion.md` (lots on the invoice), `bodega.md` (new), `comisiones.md` (new), `contabilidad/` mapping note.
- **Demo seed**: «Café molido 500 g» lot-tracked with two lots of different expiry, a grinder serial-tracked with three serials, one bin per category with put-away rules, one commission plan for the demo salesperson (an employee party) and one for an external agent, one invoice collected in two parts so the aging shows a commission payable.
- **E2E**: receipt with a lot → delivery takes the earliest lot (FEFO) → invoice shows it → recall lists the customer; order confirmed → pick → confirm → draft delivery → ship; invoice paid in two receipts → two commissions → aging payable for the payee.

## 7. Calls I made (check these)

1. Order 30 ∥ 28 → 29 and migration blocks (§2; item 144 asks).
2. Lot tracking settings live in an inventory parametro, not on `core.products` (rule 3).
3. `inventory.movements.party_id` so the recall report needs no sales read.
4. Reservations stay lot-less in Task 28; lot allocation arrives with picking as a child table, keeping Task 43's one-active-row index.
5. Serials are always scanned or typed, never chosen by FEFO.
6. Bins are inventory locations (one level).
7. A pick moves no stock (item 153 asks).
8. Commissions accrue on collection from `payments.received` and advance applications, not from `invoicing.invoice.paid` (which fires only at full payment); the ratio is in document currency; the last collection takes the cents.
9. The commission rate is frozen at invoice issue.
10. «Flat» means one rate for every category.
11. After the builder check: sales creates the pick's entrega from inventory's allocation result, never from the pick itself (§4.3); commission posting runs in its own `sales.commission.due` consumer so it never blocks delivery invoicing (§5.2); bases are per invoice line, and the collection ratio uses the open balance payments sends (`openAfterDoc`), so credit notes and the last cent need no invoicing read (§5.2); availability counts lot buckets minus blocked and expired lots (§3.7).
12. The pending-decisions file already has items 140–143 (two sections numbered 140); the new questions start at **144**, not 141 as the session prompt said.

## 8. What is left to the plan

**Done 2026-11-10:** expanded in the plan («Expanded tasks of Part G», rulings RG-1…RG-14). Where the code contradicted this note (invoice lines copied at draft time, no pack settings, no cross-module record actions), the plan's study result and rulings RG-5 and RG-9 win.


Exact file lists, sub-task split (proposed: 30.1 plans and bases, 30.2 accrual and posting on both bases, 30.3 reversals, 30.4 UI, report, demo, guide; 28.1 maestros and tracking, 28.2 inbound and internal movements, 28.3 FEFO issue, deliveries and returns, 28.4 invoice, PDF, recall, demo; 29.1 module, picks and allocation, 29.2 pick-driven delivery and ship from allocation, 29.3 packing and put-away, 29.4 UI, demo, e2e), failing tests per sub-task, gates and review focus, written after the owner answers.
