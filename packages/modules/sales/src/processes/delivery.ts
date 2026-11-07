import { defineProcess, ProcessError, runLifecycle, writeSnapshot, type EventConsumer, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { deliveryEntity, type DeliveryStage, type OrderStage } from "../entities";
import { assertSaleReady } from "../readiness";
import { linkDeliveryToOrder, markLinksVoided } from "./common";
import { assertWarehouse, FIRM_STAGES, refuse, refuseState, today } from "./order";
import { lockShipStock, pendingShipped, qtyText } from "./stock";

// Entregas de pedidos (plan 2B Task 14, design §8.1 steps 3–4, OD-3, OD-4). An entrega is a documento numbered ENT- on save
// that never posts itself (contabiliza false): each line names the pedido line it delivers, partial entregas are allowed and a pedido is
// never delivered beyond what was ordered (counting every other entrega that is not voided). sales.delivery.ship emits
// sales.delivery.shipped { deliveryId, number, orderId, partyId, warehouseId, date, costCenterId?, lines[] }: sales never calls inventory
// (rule 3). Inventory's consumer issues the stock (inventory.movement.post, kind sale_issue, origin event, the entrega line as the
// idempotency key, the cost center carried for the cost of sales) and uses up each pedido line's reservation by what shipped; costing values
// the issue at the weighted average (Task 8) and emits costing.cogs.posted, which the accounting engine posts (Dr cogs / Cr inventory) on
// the entrega's chain, dated the entrega. An entrega dated in a closed period still moves its stock (OD-4): the cost of sales is then the
// engine's retryable closed_period posting failure (accounting.period.reopen + accounting.posting.retry posts it once).
//
// At ship, in one transaction under the pedido's lock: the entrega is Grabada and open, the pedido firm; the delivered quantities stay
// within the pedido; the customer and every product are still invoice_ready (rule 10); and the stock on hand covers what leaves, whatever
// the reservation (a short pedido line reserved less than ordered, or nothing, Task 13). The stock check reads inventory's published stock
// (inventory.sale_stock, inventory.source_reservations, inventory's migration 0087) under a lock per bodega and product that every ship
// takes, and counts the entregas already shipped whose stock inventory has not issued yet (sales records each issue from
// inventory.movement.posted: delivery_lines.stock_posted_at), so two entregas of the last unit shipped at once cannot both pass. It reads
// the stock the way inventory issues it: only shippable buckets (no transit ubicación), and each line from ONE bucket (until picking, 2B.2),
// so a line no single bucket holds is refused here (split_location) instead of after it shipped. A bodega that allows backorders (OD-3's
// per-bodega switch) is not checked. Refusal: negative_stock_refused or split_location, with the product and the quantities.
//
// When inventory still refuses the despacho (the stock left between the ship and the issue: another movement took it), it emits
// inventory.sale_issue.refused and sales.delivery.reopen puts the entrega back to open (Grabado, editable) with the reason in
// stock_refusal: the pedido's stage steps back, nothing stays counted as pending, the entrega can be shipped again or voided.
//
// Anular (sales.delivery.void, its own process: the kernel's generic void would leave the stock issued): refused when anything of it was
// invoiced (delivery_lines.invoiced_qty, recorded by sales.delivery.record_invoiced from invoicing.invoice.issued, Task 16; and, before that
// event is recorded, invoicing's published invoicing.delivery_invoiced, read under the entrega's lock that «Emitir» also takes) or a
// devolución of it is not voided. A shipped entrega emits
// sales.delivery.voided: inventory voids the sale issue (origin event), costing reverses its cost events and, when its cost of sales left,
// emits costing.cogs.voided, whose rule (reverseOf) reverses the entry. The pedido's stage steps back. A voided entrega does not
// re-reserve the stock it had used up (the remainder of the pedido is delivered from what is on hand, checked at ship).
//
// A pedido's stage follows what shipped (not voided): nothing → confirmed, part → partially_delivered, every line in full → delivered.

const FEATURE = "sales.deliveries";
export const DELIVERY_SHIPPED = "sales.delivery.shipped";
export const DELIVERY_VOIDED = "sales.delivery.voided";
/** Inventory could not issue a despacho (Task 14 review): the entrega goes back to open with the reason. */
const SALE_ISSUE_REFUSED = "inventory.sale_issue.refused";
/** The source entity of the inventory movements of an entrega (inventory.movements.source_entity; the lines are its lines). */
export const DELIVERY_SOURCE = "sales.delivery";
/** The source entity of a pedido line's reservation (Task 13). */
const ORDER_LINE_SOURCE = "sales.order_line";
const NUMBER_PREFIX = "ENT-";
/** What Grabar may change of an entrega (its lines, date, bodega and cost center change through sales.delivery.update). */
const WRITABLE = ["notes", "extra", "extra_free"];

const id = z.uuid();
const date = z.iso.date();
const qty = z.number().finite().positive().refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales");
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

const lineInput = z.object({ orderLineId: id, qty }).strict();

const deliveryOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  stage: z.string(),
  orderId: z.string(),
  orderStage: z.string(),
  date: z.string(),
  shippedAt: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), lineNo: z.number(), orderLineId: z.string(), productId: z.string(), qty: z.number() })),
});
type DeliveryOutput = z.output<typeof deliveryOutput>;

interface OrderRow { id: string; number: string | null; status: string; stage: OrderStage; party_id: string; warehouse_id: string | null; issue_date: string }
interface OrderLineRow { id: string; line_no: number; product_id: string; description: string | null; qty: string }
interface DeliveryRow {
  id: string; number: string | null; status: string; stage: DeliveryStage; order_id: string; party_id: string; warehouse_id: string; date: string;
  cost_center_id: string | null; shipped_at: string | null;
}
interface DeliveryLineRow { id: string; line_no: number; order_line_id: string; product_id: string; description: string | null; qty: string; invoiced_qty: string }

const orderLabel = (o: Pick<OrderRow, "number" | "id">) => o.number ?? o.id;
const label = (d: Pick<DeliveryRow, "number" | "id">) => d.number ?? d.id;

/** The pedido locked (every entrega of it is created, shipped and voided under this lock), or `not_found`. */
async function lockOrder(ctx: ProcessContext, orderId: string): Promise<OrderRow> {
  const [row] = await ctx.tx<OrderRow[]>`
    select id, number, status, stage, party_id, warehouse_id, issue_date::text from sales.orders where id = ${orderId} for update`;
  if (!row) throw new ProcessError("not_found", `order ${orderId} not found`);
  return row;
}

/** The entrega's pedido locked first, then the entrega (one lock order: create, ship and void all take the pedido before the entrega). */
async function lockDelivery(ctx: ProcessContext, deliveryId: string): Promise<{ order: OrderRow; delivery: DeliveryRow }> {
  const [head] = await ctx.tx<{ order_id: string }[]>`select order_id from sales.deliveries where id = ${deliveryId}`;
  if (!head) throw new ProcessError("not_found", `delivery ${deliveryId} not found`);
  const order = await lockOrder(ctx, head.order_id);
  const [delivery] = await ctx.tx<DeliveryRow[]>`
    select id, number, status, stage, order_id, party_id, warehouse_id, date::text, cost_center_id,
           to_char(shipped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as shipped_at
    from sales.deliveries where id = ${deliveryId} for update`;
  return { order, delivery: delivery! };
}

/** Refuses an entrega of a pedido that is not firm (open), cancelled, or (`forNew`) already delivered in full. */
function assertDeliverable(order: OrderRow, forNew: boolean): void {
  if (order.stage === "cancelled" || order.status === "voided") refuseState("order_cancelled", [`El pedido ${orderLabel(order)} está cancelado`]);
  if (!FIRM_STAGES.has(order.stage)) refuseState("order_not_confirmed", [`El pedido ${orderLabel(order)} no está confirmado: se entrega una vez confirmado`]);
  if (forNew && order.stage === "delivered") refuseState("order_delivered", [`El pedido ${orderLabel(order)} ya está entregado por completo`]);
}

/** Per pedido line, the quantity in the pedido's entregas that are not voided (`shippedOnly`: only the shipped ones), except `exceptId`. */
async function committedByLine(ctx: ProcessContext, orderId: string, exceptId: string | null, shippedOnly: boolean): Promise<Map<string, number>> {
  const rows = await ctx.tx<{ order_line_id: string; qty: string }[]>`
    select l.order_line_id, sum(l.qty)::text as qty
    from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id
    where d.order_id = ${orderId} and d.status <> 'voided' and (${shippedOnly}::boolean is false or d.stage = 'shipped') and d.id is distinct from ${exceptId}::uuid
    group by l.order_line_id`;
  return new Map(rows.map((r) => [r.order_line_id, num(r.qty)]));
}

/** The lines an entrega delivers: the ones asked (each within what is left of its pedido line), else every pedido line's remainder. */
async function deliveryLines(ctx: ProcessContext, order: OrderRow, asked: z.output<typeof lineInput>[] | undefined, exceptId: string | null) {
  const orderLines = await ctx.tx<OrderLineRow[]>`
    select id, line_no, product_id, description, qty::text from sales.order_lines where order_id = ${order.id} order by line_no`;
  const committed = await committedByLine(ctx, order.id, exceptId, false);
  const left = (l: OrderLineRow) => round4(num(l.qty) - (committed.get(l.id) ?? 0));
  if (!asked) {
    const lines = orderLines.filter((l) => left(l) > 0).map((l) => ({ line: l, qty: left(l) }));
    if (lines.length === 0) refuseState("nothing_to_deliver", [`Al pedido ${orderLabel(order)} no le queda nada por entregar`]);
    return lines;
  }
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const problems: string[] = [];
  const over: string[] = [];
  const seen = new Set<string>();
  const lines: { line: OrderLineRow; qty: number }[] = [];
  asked.forEach((a, i) => {
    const line = byId.get(a.orderLineId);
    if (!line) return problems.push(`Línea ${i + 1}: la línea no es del pedido ${orderLabel(order)}`);
    if (seen.has(line.id)) return problems.push(`Línea ${i + 1}: la línea ${line.line_no} del pedido aparece dos veces`);
    seen.add(line.id);
    if (a.qty > left(line)) {
      return over.push(`Línea ${i + 1}: el pedido pide ${qtyText(num(line.qty))}, ya van ${qtyText(committed.get(line.id) ?? 0)} en entregas y quedan ${qtyText(Math.max(left(line), 0))}; la entrega pide ${qtyText(a.qty)}`);
    }
    lines.push({ line, qty: a.qty });
  });
  if (problems.length > 0) refuse("invalid_order_line", problems);
  if (over.length > 0) refuse("over_delivery", over);
  return lines;
}

/** Recomputes the pedido's stage from what shipped (entregas not voided): confirmed, partially_delivered or delivered. */
export async function refreshOrderStage(ctx: ProcessContext, orderId: string): Promise<OrderStage> {
  const [row] = await ctx.tx<{ stage: OrderStage }[]>`
    with shipped as (
      select l.order_line_id, sum(l.qty) as qty
      from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id
      where d.order_id = ${orderId} and d.stage = 'shipped' and d.status <> 'voided'
      group by l.order_line_id
    )
    select case
             when coalesce(sum(s.qty), 0) = 0 then 'confirmed'
             when bool_and(coalesce(s.qty, 0) >= o.qty) then 'delivered'
             else 'partially_delivered'
           end as stage
    from sales.order_lines o left join shipped s on s.order_line_id = o.id
    where o.order_id = ${orderId}`;
  const stage = row!.stage;
  await ctx.tx`update sales.orders set stage = ${stage} where id = ${orderId} and stage is distinct from ${stage} and stage <> 'cancelled'`;
  return stage;
}

async function outputOf(ctx: ProcessContext, deliveryId: string): Promise<DeliveryOutput> {
  const [row] = await ctx.tx<(DeliveryRow & { order_stage: string })[]>`
    select d.id, d.number, d.status, d.stage, d.order_id, d.date::text, o.stage as order_stage,
           to_char(d.shipped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as shipped_at
    from sales.deliveries d join sales.orders o on o.id = d.order_id where d.id = ${deliveryId}`;
  if (!row) throw new ProcessError("not_found", `delivery ${deliveryId} not found`);
  const lines = await ctx.tx<DeliveryLineRow[]>`
    select id, line_no, order_line_id, product_id, description, qty::text, invoiced_qty::text from sales.delivery_lines where delivery_id = ${deliveryId} order by line_no`;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    stage: row.stage,
    orderId: row.order_id,
    orderStage: row.order_stage,
    date: row.date,
    shippedAt: row.shipped_at,
    lines: lines.map((l) => ({ id: l.id, lineNo: l.line_no, orderLineId: l.order_line_id, productId: l.product_id, qty: num(l.qty) })),
  };
}

async function writeLines(ctx: ProcessContext, deliveryId: string, lines: { line: OrderLineRow; qty: number }[]): Promise<void> {
  await ctx.tx`insert into sales.delivery_lines ${ctx.tx(lines.map((l, i) => ({
    company_id: ctx.companyId, delivery_id: deliveryId, line_no: i + 1, order_line_id: l.line.id, product_id: l.line.product_id, description: l.line.description, qty: l.qty,
  })))}`;
}

export const deliveryCreate = defineProcess({
  id: "sales.delivery.create",
  module: "sales",
  kind: "create",
  feature: FEATURE,
  description:
    "Crea una entrega de un pedido confirmado: por defecto todo lo que le queda por entregar a cada línea, o las líneas y cantidades indicadas, sin pasar de lo pedido; le asigna su número ENT-. Aún no mueve inventario: eso pasa al despacharla",
  input: z.object({
    orderId: id,
    /** The date the goods leave (default today); the stock and the cost of sales are dated by it. */
    date: date.optional(),
    /** The bodega the goods leave from (inventory's); default the pedido's. */
    warehouseId: id.optional(),
    /** The cost center of the cost of sales (accounting's id; the demo chart's 613595 requires one). */
    costCenterId: id.optional(),
    notes: z.string().trim().max(2000).optional(),
    lines: z.array(lineInput).min(1).max(200).optional(),
  }).strict(),
  output: deliveryOutput,
  handler: async (ctx, input) => {
    const order = await lockOrder(ctx, input.orderId);
    assertDeliverable(order, true);
    const warehouseId = input.warehouseId ?? order.warehouse_id;
    if (!warehouseId) refuse("warehouse_required", [`Indica la bodega de la entrega: el pedido ${orderLabel(order)} no tiene bodega`]);
    await assertWarehouse(ctx, warehouseId);
    const on = input.date ?? (await today(ctx));
    if (on < order.issue_date) refuse("invalid_delivery_date", ["La fecha de la entrega es anterior a la del pedido"]);
    const lines = await deliveryLines(ctx, order, input.lines, null);
    await assertSaleReady(ctx, order.party_id, lines.map((l) => l.line.product_id));
    const [header] = await ctx.tx<{ id: string }[]>`
      insert into sales.deliveries ${ctx.tx({
        company_id: ctx.companyId,
        order_id: order.id,
        party_id: order.party_id,
        warehouse_id: warehouseId,
        date: on,
        stage: "open",
        cost_center_id: input.costCenterId ?? null,
        notes: input.notes ?? null,
        // An entrega neither waits for approval nor posts itself (ownFlags): the cost of sales posts from costing's event.
        requires_approval: false,
        posts: false,
      })}
      returning id`;
    await writeLines(ctx, header!.id, lines);
    // order_to_delivery, in this transaction (Task 31).
    await linkDeliveryToOrder(ctx, header!.id, order.id);
    await runLifecycle(ctx, ctx.registry.entity(deliveryEntity.id), header!.id, "save");
    return outputOf(ctx, header!.id);
  },
});

export const deliveryUpdate = defineProcess({
  id: "sales.delivery.update",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  description: "Cambia las líneas, la fecha, la bodega, el centro de costo o las notas de una entrega que aún no se ha despachado, sin pasar de lo pedido",
  input: z.object({
    id,
    date: date.optional(),
    warehouseId: id.optional(),
    costCenterId: id.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(lineInput).min(1).max(200).optional(),
  }).strict(),
  output: deliveryOutput,
  handler: async (ctx, input) => {
    const { order, delivery } = await lockDelivery(ctx, input.id);
    if (delivery.status === "voided") refuseState("delivery_voided", [`La entrega ${label(delivery)} está anulada`]);
    if (delivery.stage === "shipped") refuseState("delivery_shipped", [`La entrega ${label(delivery)} ya se despachó: no cambia`]);
    assertDeliverable(order, false);
    if (input.warehouseId) await assertWarehouse(ctx, input.warehouseId);
    if (input.date && input.date < order.issue_date) refuse("invalid_delivery_date", ["La fecha de la entrega es anterior a la del pedido"]);
    const set: Record<string, unknown> = Object.fromEntries(
      Object.entries({ date: input.date, warehouse_id: input.warehouseId, cost_center_id: input.costCenterId, notes: input.notes }).filter(([, v]) => v !== undefined),
    );
    if (input.lines) {
      const lines = await deliveryLines(ctx, order, input.lines, delivery.id);
      await assertSaleReady(ctx, order.party_id, lines.map((l) => l.line.product_id));
      await ctx.tx`delete from sales.delivery_lines where delivery_id = ${delivery.id}`;
      await writeLines(ctx, delivery.id, lines);
    }
    if (Object.keys(set).length > 0) await ctx.tx`update sales.deliveries set ${ctx.tx(set)} where id = ${delivery.id}`;
    const entity = ctx.registry.entity(deliveryEntity.id);
    const saved = await runLifecycle(ctx, entity, delivery.id, "save");
    // Grabado → Grabado writes no snapshot of its own; the process changed the entrega, so the version is kept here (spec §8).
    if ((input.lines || Object.keys(set).length > 0) && delivery.status === saved.status && delivery.status !== "draft") await writeSnapshot(ctx, entity, delivery.id, saved.status, null);
    return outputOf(ctx, delivery.id);
  },
});

/** A tracked good of the entrega (a service or a product that keeps no stock moves nothing and is not checked). */
async function trackedProducts(ctx: ProcessContext, productIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await ctx.tx<{ id: string; sku: string }[]>`
    select id, sku from core.v_product_stock where id = any(${[...new Set(productIds)]}::uuid[]) and kind <> 'service' and track_stock`;
  return new Map(rows.map((r) => [r.id, r.sku]));
}

/**
 * Refuses (negative_stock_refused) an entrega whose goods the bodega does not have on hand. Per product, under a lock per bodega and
 * product that every ship takes (so two ships of the same product queue and the second sees the first):
 *   free = on hand − what earlier shipped entregas take that inventory has not issued yet − what is reserved for other sources,
 * where a pedido line with a pending entrega keeps only the part of its reservation that the pending entrega will not use up, and this
 * entrega may use its own pedido lines' reservations. A bodega that allows backorders is not checked (OD-3).
 */
async function assertStock(ctx: ProcessContext, delivery: DeliveryRow, lines: DeliveryLineRow[]): Promise<void> {
  const tracked = await trackedProducts(ctx, lines.map((l) => l.product_id));
  const products = [...tracked.keys()].sort();
  if (products.length === 0) return;
  await lockShipStock(ctx, delivery.warehouse_id, products);
  const stock = await ctx.tx<{ product_id: string; on_hand: string; reserved: string; allow_backorders: boolean | null; max_bucket: string }[]>`
    select product_id, on_hand::text, reserved::text, allow_backorders, max_bucket::text from inventory.sale_stock(${delivery.warehouse_id}::uuid, ${products}::uuid[])`;
  if (stock.length === 0 || stock[0]!.allow_backorders === null) refuse("invalid_warehouse", ["La bodega de la entrega no existe"]);
  if (stock[0]!.allow_backorders) return;
  // Entregas of this bodega already shipped whose stock inventory has not issued yet (their sale issue is still on its way).
  const pending = await pendingShipped(ctx, delivery.warehouse_id, products, delivery.id);
  const own = new Set(lines.map((l) => l.order_line_id));
  const sourceLines = [...new Set([...own, ...pending.map((p) => p.orderLineId)])];
  const reservations = await ctx.tx<{ source_line_id: string; warehouse_id: string; reserved: string }[]>`
    select source_line_id, warehouse_id, reserved::text from inventory.source_reservations(${ORDER_LINE_SOURCE}, ${sourceLines}::uuid[])`;
  const reservedOf = new Map(reservations.filter((r) => r.warehouse_id === delivery.warehouse_id).map((r) => [r.source_line_id, num(r.reserved)]));
  const pendingOf = new Map<string, number>();
  for (const p of pending) pendingOf.set(p.orderLineId, round4((pendingOf.get(p.orderLineId) ?? 0) + p.qty));

  const refusals: string[] = [];
  const split: string[] = [];
  for (const s of stock) {
    const ofProduct = lines.filter((l) => l.product_id === s.product_id);
    const wanted = round4(ofProduct.reduce((sum, l) => sum + num(l.qty), 0));
    const linesOfProduct = new Set([...ofProduct.map((l) => l.order_line_id), ...pending.filter((p) => p.productId === s.product_id).map((p) => p.orderLineId)]);
    const pendingQty = round4(pending.filter((p) => p.productId === s.product_id).reduce((sum, p) => sum + p.qty, 0));
    const reservedInSet = [...linesOfProduct].reduce((sum, l) => sum + (reservedOf.get(l) ?? 0), 0);
    // What the pending entregas' pedido lines keep reserved once their issue uses up what shipped (this entrega's own lines are free to it).
    const keptByOthers = [...linesOfProduct].filter((l) => !own.has(l)).reduce((sum, l) => sum + Math.max((reservedOf.get(l) ?? 0) - (pendingOf.get(l) ?? 0), 0), 0);
    const onHand = num(s.on_hand);
    const committed = round4(pendingQty + (num(s.reserved) - reservedInSet) + keptByOthers);
    const free = round4(onHand - committed);
    if (wanted > free) {
      refusals.push(
        `El producto ${tracked.get(s.product_id)} tiene ${qtyText(onHand)} en existencia, ${qtyText(Math.max(committed, 0))} comprometidas (reservadas para otros documentos o despachadas sin descargar) y la entrega saca ${qtyText(wanted)}: la bodega no permite existencias negativas`,
      );
      continue;
    }
    // Each line leaves from one bucket: the most a single one holds, less what pending entregas may take from it (conservative).
    const single = round4(num(s.max_bucket) - pendingQty);
    for (const l of ofProduct) {
      if (num(l.qty) > single) {
        split.push(
          `Línea ${l.line_no}: el producto ${tracked.get(s.product_id)} sale de una sola ubicación y la que más tiene guarda ${qtyText(Math.max(single, 0))}; la línea saca ${qtyText(num(l.qty))}: divide la línea en varias entregas o traslada la mercancía a una ubicación`,
        );
      }
    }
  }
  if (refusals.length > 0) refuse("negative_stock_refused", refusals);
  if (split.length > 0) refuse("split_location", split);
}

export const deliveryShip = defineProcess({
  id: "sales.delivery.ship",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  emits: [DELIVERY_SHIPPED],
  description:
    "Despacha una entrega grabada: comprueba que no pase de lo pedido, que el cliente y los productos estén listos para facturar y que haya existencias en la bodega; el inventario descarga la mercancía y se registra el costo de ventas. El pedido queda entregado en parte o por completo",
  input: z.object({
    id,
    /** One per despacho the user asks for (a form submit): a retry with the same key answers the first result. */
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  output: deliveryOutput,
  auditInput: (input) => ({ id: input.id }),
  idempotencyKey: (input) => (input.idempotencyKey ? `ship:${input.id}:${input.idempotencyKey}` : undefined),
  handler: async (ctx, { id: deliveryId, idempotencyKey }) => {
    const { order, delivery } = await lockDelivery(ctx, deliveryId);
    if (delivery.stage === "shipped" && idempotencyKey) {
      const [stored] = await ctx.tx<{ result: DeliveryOutput }[]>`
        select result from kernel.process_idempotency where company_id = ${ctx.companyId} and process_id = 'sales.delivery.ship' and key = ${`ship:${deliveryId}:${idempotencyKey}`}`;
      if (stored) return stored.result;
    }
    if (delivery.status === "voided") refuseState("delivery_voided", [`La entrega ${label(delivery)} está anulada`]);
    if (delivery.stage === "shipped") refuseState("delivery_shipped", [`La entrega ${label(delivery)} ya se despachó`]);
    if (delivery.status !== "saved") refuseState("delivery_not_saved", [`La entrega ${label(delivery)} no está grabada`]);
    assertDeliverable(order, false);

    const lines = await ctx.tx<DeliveryLineRow[]>`
      select id, line_no, order_line_id, product_id, description, qty::text, invoiced_qty::text from sales.delivery_lines where delivery_id = ${deliveryId} order by line_no`;
    // Never beyond the pedido: what the other shipped entregas delivered plus this one.
    const ordered = new Map((await ctx.tx<{ id: string; line_no: number; qty: string }[]>`
      select id, line_no, qty::text from sales.order_lines where order_id = ${order.id}`).map((l) => [l.id, l] as const));
    const shipped = await committedByLine(ctx, order.id, deliveryId, true);
    const over = lines.flatMap((l) => {
      const o = ordered.get(l.order_line_id)!;
      const total = round4((shipped.get(l.order_line_id) ?? 0) + num(l.qty));
      return total > num(o.qty) ? [`Línea ${l.line_no}: el pedido pide ${qtyText(num(o.qty))}, ya se despacharon ${qtyText(shipped.get(l.order_line_id) ?? 0)} y la entrega saca ${qtyText(num(l.qty))}`] : [];
    });
    if (over.length > 0) refuse("over_delivery", over);
    // Rule 10 holds at ship too: a customer or product that stopped being invoice_ready since the entrega was written is refused.
    await assertSaleReady(ctx, order.party_id, lines.map((l) => l.product_id));
    await assertStock(ctx, delivery, lines);

    await ctx.tx`update sales.deliveries set stage = 'shipped', shipped_at = now(), stock_refusal = null, stock_refused_at = null where id = ${deliveryId}`;
    await writeSnapshot(ctx, ctx.registry.entity(deliveryEntity.id), deliveryId, "saved", null);
    await refreshOrderStage(ctx, order.id);
    await ctx.emit(DELIVERY_SHIPPED, {
      deliveryId,
      number: delivery.number,
      orderId: order.id,
      orderNumber: order.number,
      partyId: order.party_id,
      warehouseId: delivery.warehouse_id,
      date: delivery.date,
      ...(delivery.cost_center_id ? { costCenterId: delivery.cost_center_id } : {}),
      lines: lines.map((l) => ({ lineId: l.id, lineNo: l.line_no, orderLineId: l.order_line_id, productId: l.product_id, qty: num(l.qty) })),
    });
    return outputOf(ctx, deliveryId);
  },
});

export const deliveryVoid = defineProcess({
  id: "sales.delivery.void",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  emits: [DELIVERY_VOIDED],
  description:
    "Anula una entrega con su motivo; si ya se despachó, el inventario reintegra la mercancía y se reversa su costo de ventas. Se rechaza si algo de ella ya se facturó o tiene una devolución vigente",
  input: z.object({
    id,
    reason: z.string().trim().min(1, "Indica por qué se anula la entrega").max(500),
    expectedUpdatedAt: z.string().optional(),
  }).strict(),
  output: deliveryOutput,
  handler: async (ctx, input) => {
    const { order, delivery } = await lockDelivery(ctx, input.id);
    if (delivery.status === "voided") refuseState("delivery_voided", [`La entrega ${label(delivery)} ya está anulada`]);
    const lines = await ctx.tx<DeliveryLineRow[]>`
      select id, line_no, order_line_id, product_id, description, qty::text, invoiced_qty::text from sales.delivery_lines where delivery_id = ${delivery.id} order by line_no`;
    const invoiced = lines.filter((l) => num(l.invoiced_qty) > 0);
    if (invoiced.length > 0) {
      refuseState("delivery_invoiced", invoiced.map((l) => `Línea ${l.line_no}: ya se facturaron ${qtyText(num(l.invoiced_qty))}: anula primero la factura (nota crédito)`));
    }
    // An invoice issued a moment ago whose event sales has not recorded yet (Task 16): invoicing publishes it, and its «Emitir» holds this
    // entrega's lock (sales.lock_deliveries_for_invoice) until it commits, so this read, after the lock, sees it.
    const [billed] = await ctx.tx<{ invoiced: boolean }[]>`select invoicing.delivery_invoiced(${delivery.id}::uuid) as invoiced`;
    if (billed?.invoiced) refuseState("delivery_invoiced", [`La entrega ${label(delivery)} ya está facturada: anula primero la factura (nota crédito)`]);
    const [returned] = await ctx.tx<{ number: string | null }[]>`select number from sales.returns where delivery_id = ${delivery.id} and status <> 'voided' limit 1`;
    if (returned) refuseState("delivery_returned", [`La entrega ${label(delivery)} tiene la devolución ${returned.number ?? ""} vigente: anúlala primero`]);

    await runLifecycle(ctx, ctx.registry.entity(deliveryEntity.id), delivery.id, "void", { reason: input.reason, ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}) });
    // The void keeps its link, marked (Task 31).
    await markLinksVoided(ctx, "sales.delivery", delivery.id, input.reason);
    if (delivery.stage === "shipped") {
      await refreshOrderStage(ctx, order.id);
      await ctx.emit(DELIVERY_VOIDED, {
        deliveryId: delivery.id,
        number: delivery.number,
        orderId: order.id,
        warehouseId: delivery.warehouse_id,
        date: await today(ctx),
        reason: input.reason,
        lines: lines.map((l) => ({ lineId: l.id, lineNo: l.line_no, orderLineId: l.order_line_id, productId: l.product_id, qty: num(l.qty) })),
      });
    }
    return outputOf(ctx, delivery.id);
  },
});

/** What sales reads of invoicing.invoice.issued: the invoice (its lines are read in invoicing's published view). */
const invoiceIssued = z.looseObject({ invoiceId: id });

export const deliveryRecordInvoiced = defineProcess({
  id: "sales.delivery.record_invoiced",
  module: "sales",
  kind: "update",
  // The lines of the entregas an issued invoice bills, named by invoicing's published view: no record of the caller's is changed.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  description: "Registra en las líneas de las entregas lo que les facturaron las facturas emitidas (o les devolvió una factura anulada); solo lo ejecuta el evento de la factura",
  input: z.object({
    invoiceId: id,
    /** The entregas an annulled invoice billed (invoicing.invoice.annulled, Task 18): it is no longer in the view, so its entregas are named. */
    deliveryIds: z.array(id).max(500).optional(),
  }).strict(),
  output: z.object({ recorded: z.number().int() }),
  handler: async (ctx, { invoiceId, deliveryIds }) => {
    // Recomputed from every issued invoice of each line (invoicing.v_invoiced_delivery_lines, migration 0092; a voided invoice is not in
    // it): a redelivery changes nothing.
    const rows = await ctx.tx`
      update sales.delivery_lines l
         set invoiced_qty = coalesce((select sum(v.qty) from invoicing.v_invoiced_delivery_lines v where v.delivery_line_id = l.id), 0)
       where l.id in (select v.delivery_line_id from invoicing.v_invoiced_delivery_lines v where v.invoice_id = ${invoiceId})
          or l.delivery_id = any(${deliveryIds ?? []}::uuid[])
      returning l.id`;
    return { recorded: rows.length };
  },
});

/** Consumer of invoicing.invoice.issued: what the invoice billed of each entrega line is recorded on it (invoiced_qty). */
export const onInvoiceIssued: EventConsumer = async (ctx, payload) => {
  const parsed = invoiceIssued.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `invoicing.invoice.issued payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  await ctx.runProcess("sales.delivery.record_invoiced", { invoiceId: parsed.data.invoiceId });
};

/** What sales reads of invoicing.invoice.annulled (Task 18): the voided invoice and the entregas it billed. */
const invoiceAnnulled = z.looseObject({ invoiceId: id, deliveryIds: z.array(id) });

/** Consumer of invoicing.invoice.annulled: the entregas a voided invoice billed get back what it invoiced (invoiced_qty recomputed). */
export const onInvoiceAnnulled: EventConsumer = async (ctx, payload) => {
  const parsed = invoiceAnnulled.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `invoicing.invoice.annulled payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if (parsed.data.deliveryIds.length === 0) return;
  await ctx.runProcess("sales.delivery.record_invoiced", { invoiceId: parsed.data.invoiceId, deliveryIds: parsed.data.deliveryIds });
};

/** What sales reads of inventory.movement.posted: a sale issue of one of its entregas (inventory's MovementEvent). */
const movementPosted = z.looseObject({
  movementId: id,
  kind: z.string(),
  sourceEntity: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
  lines: z.array(z.looseObject({ sourceLineId: z.string().nullable().optional() })),
});

export const deliveryRecordStock = defineProcess({
  id: "sales.delivery.record_stock",
  module: "sales",
  kind: "update",
  // The lines of an entrega, named by the movement inventory published: no record of the caller's is changed.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  description: "Registra en las líneas de una entrega el movimiento de inventario que descargó su mercancía; solo lo ejecuta el evento del movimiento",
  input: z.object({ deliveryId: id, movementId: id, lineIds: z.array(id).min(1).max(500) }).strict(),
  output: z.object({ recorded: z.number().int() }),
  handler: async (ctx, { deliveryId, movementId, lineIds }) => {
    const rows = await ctx.tx`
      update sales.delivery_lines set movement_id = ${movementId}, stock_posted_at = now()
      where delivery_id = ${deliveryId} and id = any(${lineIds}::uuid[]) and stock_posted_at is null
      returning id`;
    return { recorded: rows.length };
  },
});

/** Consumer of inventory.movement.posted: a sale issue of an entrega is recorded on its lines (the stock check at ship stops counting them). */
export const onMovementPosted: EventConsumer = async (ctx, payload) => {
  const parsed = movementPosted.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `inventory.movement.posted payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const m = parsed.data;
  if (m.kind !== "sale_issue" || m.sourceEntity !== DELIVERY_SOURCE || !m.sourceId) return;
  const lineIds = m.lines.flatMap((l) => (l.sourceLineId ? [l.sourceLineId] : []));
  if (lineIds.length === 0) return;
  await ctx.runProcess("sales.delivery.record_stock", { deliveryId: m.sourceId, movementId: m.movementId, lineIds });
};

const refusedPayload = z.looseObject({ deliveryId: id, shippedEventId: id.optional(), code: z.string().min(1), reason: z.string() });

export const deliveryReopen = defineProcess({
  id: "sales.delivery.reopen",
  module: "sales",
  kind: "update",
  // The entrega named by inventory's refusal: no record of the caller's is changed.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  description:
    "Devuelve a abierta (grabada, editable) una entrega despachada cuya mercancía el inventario no pudo descargar, con el motivo; solo lo ejecuta el evento del inventario",
  input: z.object({ deliveryId: id, shippedEventId: id.optional(), code: z.string().trim().min(1).max(100), reason: z.string().max(1800) }).strict(),
  output: z.object({ reopened: z.boolean(), orderStage: z.string().optional() }),
  handler: async (ctx, input) => {
    const { order, delivery } = await lockDelivery(ctx, input.deliveryId);
    if (delivery.status === "voided" || delivery.stage !== "shipped") return { reopened: false };
    // Only the despacho inventory refused: a later despacho of the same entrega (shipped again after an earlier refusal) is not undone.
    if (input.shippedEventId) {
      const [last] = await ctx.tx<{ id: string }[]>`
        select id from kernel.outbox where company_id = ${ctx.companyId} and event = ${DELIVERY_SHIPPED} and payload->>'deliveryId' = ${delivery.id}
        order by created_at desc, id desc limit 1`;
      if (last && last.id !== input.shippedEventId) return { reopened: false };
    }
    const [issued] = await ctx.tx`select 1 from sales.delivery_lines where delivery_id = ${delivery.id} and stock_posted_at is not null limit 1`;
    if (issued) return { reopened: false };
    await ctx.tx`
      update sales.deliveries set stage = 'open', shipped_at = null, stock_refusal = ${`${input.code}: ${input.reason}`.slice(0, 2000)}, stock_refused_at = now()
      where id = ${delivery.id}`;
    await writeSnapshot(ctx, ctx.registry.entity(deliveryEntity.id), delivery.id, "saved", null);
    const orderStage = await refreshOrderStage(ctx, order.id);
    return { reopened: true, orderStage };
  },
});

/** Consumer of inventory.sale_issue.refused: the entrega goes back to open with inventory's reason. */
export const onSaleIssueRefused: EventConsumer = async (ctx, payload) => {
  const parsed = refusedPayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${SALE_ISSUE_REFUSED} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const r = parsed.data;
  await ctx.runProcess("sales.delivery.reopen", { deliveryId: r.deliveryId, ...(r.shippedEventId ? { shippedEventId: r.shippedEventId } : {}), code: r.code.slice(0, 100), reason: r.reason.slice(0, 1800) });
};

export const deliveryConsult = defineProcess({
  id: "sales.delivery.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una entrega con sus líneas y los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: deliveryId }) => {
    const [row] = await ctx.tx`select * from sales.v_deliveries where id = ${deliveryId}`;
    if (!row) throw new ProcessError("not_found", `delivery ${deliveryId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from sales.v_delivery_lines where delivery_id = ${deliveryId} order by line_no`;
    return { ...row, id: deliveryId, lines };
  },
});

export const deliveryLineConsult = defineProcess({
  id: "sales.delivery_line.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de entrega con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from sales.v_delivery_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `delivery line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The hooks of an entrega: Grabar changes only its notes and extra data, and only while it is open (its lines, date, bodega and cost center
 * change through sales.delivery.update); the number is drawn on save from the company counter (prefix ENT-).
 */
export const deliveryHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { previous, data }) {
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for sales.delivery.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    if (previous.stage !== "open" && Object.values(data).some((v) => v !== undefined)) refuseState("delivery_shipped", ["Una entrega despachada no cambia"]);
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select sales.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

export const DELIVERY_PROCESSES = [deliveryCreate, deliveryUpdate, deliveryShip, deliveryVoid, deliveryRecordStock, deliveryRecordInvoiced, deliveryReopen, deliveryConsult, deliveryLineConsult];
