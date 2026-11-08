import { defineProcess, ProcessError, type EventConsumer, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { num, productFacts } from "./common";
import { lockStock, MOVEMENT_POSTED, MOVEMENT_VOIDED, postMovement, warehouseOf } from "./movement";
import { ORDER_LINE_SOURCE } from "./sales-orders";

// The stock of the entregas and devoluciones of sales (plan 2B Task 14, design §8.1 steps 3–4). Inventory consumes the sales module's
// events by name (it does not depend on sales; sales never calls inventory, rule 3). Each consumer runs ONE inventory process as the system
// user (origin event), keyed by the event (a redelivered event answers the first run), so everything a delivery does to the stock is one
// transaction:
//   - sales.delivery.shipped → inventory.sale.issue: the sale issue (kind sale_issue, source `sales.delivery`, the entrega lines its source
//     lines, dated the entrega, with the cost center it carries for the cost of sales), then each pedido line's reservation used up by what
//     shipped. A service or a product that keeps no stock moves nothing. Each line leaves from ONE bucket (the bodega's own stock, else the
//     ubicación holding the most, never a transit one), the stock earlier lines of the same entrega took counted, until picking (2B.2).
//     When inventory cannot apply it (no single bucket holds a line: split_location; not enough stock: negative_stock_refused; any other
//     refusal of the movement) nothing moves and inventory emits inventory.sale_issue.refused { deliveryId, deliveryLineId, code, reason }:
//     sales puts the entrega back to open with the reason (never a silent dead letter, Task 14 review). A concurrent run of the same source
//     lines that committed first (duplicate_source_line) is the same movement.
//   - sales.delivery.voided → inventory.sale.void_issue: inventory.movement.void of that sale issue; then, when the event asks (reReserve,
//     Task 43: the owner's «¿Reservar de nuevo las existencias para el pedido?»), the nested inventory.reservation.reserve_again promises
//     the stock back to the pedido lines by what the entrega had used up (all or nothing, only if it suffices; a shortage never fails the
//     void) and inventory.delivery_reservation.restored tells sales the outcome. When there is no issue: nothing to do
//     if every despacho of the entrega was refused (its refused events answer its shipped events), else the shipped event is still on its
//     way and the run fails retryably (handler_failed), so the outbox retries after the issue is posted.
//   - sales.return.received → inventory.sale.return: the sale return (kind sale_return, source `sales.return`, each line `returnOf` the
//     entrega line, so costing re-enters it at the issue's cost), into the bucket the issue left from. Retried while the issue is not posted.
//   - sales.return.voided → inventory.sale.void_return: inventory.movement.void of that sale return. When the stock it brought back already
//     left that bucket, inventory emits inventory.sale_return_void.refused { returnId, code, reason } and sales restores the devolución.
// Products are read through core's published view (core.v_product_stock), never core's tables (rule 3).

/** The source entity of an entrega's movement (sales' DELIVERY_SOURCE; repeated: inventory does not import sales). */
export const DELIVERY_SOURCE = "sales.delivery";
/** The source entity of a devolución's movement. */
export const RETURN_SOURCE = "sales.return";
export const SALE_ISSUE_REFUSED = "inventory.sale_issue.refused";
export const SALE_RETURN_VOID_REFUSED = "inventory.sale_return_void.refused";
/** The outcome of the re-reservation a voided entrega asked for (Task 43): { deliveryId, status, short, lines }; sales records it on the entrega. */
export const DELIVERY_RESERVATION_RESTORED = "inventory.delivery_reservation.restored";

const FEATURE = "inventory.stock";
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const uuid = z.uuid();
const eventId = uuid;

const shippedInput = z.object({
  eventId,
  deliveryId: uuid,
  number: z.string().nullable().optional(),
  warehouseId: uuid,
  date: z.iso.date(),
  costCenterId: uuid.optional(),
  lines: z.array(z.object({ lineId: uuid, orderLineId: uuid.optional(), productId: uuid, qty: z.number().positive() })).min(1),
});
const voidedInput = z.object({
  eventId,
  deliveryId: uuid,
  reason: z.string().min(1),
  /** Task 43: sales asks to reserve the stock again for the pedido's lines (only when it checked the pedido is open and the caller may reserve). */
  reReserve: z.boolean().optional(),
  warehouseId: uuid.optional(),
  lines: z.array(z.object({ productId: uuid, orderLineId: uuid.optional(), qty: z.number().positive().optional() })),
});
const receivedInput = z.object({
  eventId,
  returnId: uuid,
  number: z.string().nullable().optional(),
  warehouseId: uuid,
  date: z.iso.date(),
  costCenterId: uuid.optional(),
  lines: z.array(z.object({ lineId: uuid, deliveryLineId: uuid, productId: uuid, qty: z.number().positive() })).min(1),
});
const returnVoidedInput = z.object({ eventId, returnId: uuid, reason: z.string().min(1), lines: z.array(z.object({ productId: uuid })) });

const outcome = z.object({ status: z.enum(["posted", "voided", "refused", "nothing"]), movementId: z.string().nullable() });
type Outcome = z.output<typeof outcome>;

/** The goods that move stock (not a service, keeps stock), read through core's published view. */
async function goodsOf(ctx: ProcessContext, productIds: readonly string[]): Promise<Map<string, { sku: string }>> {
  const facts = await productFacts(ctx, productIds);
  return new Map([...facts.values()].filter((p) => p.kind !== "service" && p.trackStock).map((p) => [p.id, { sku: p.sku }]));
}

/** A refusal of the movement (deterministic: retrying the same event cannot change it), as opposed to a failure to retry. */
const refusalOf = (error: unknown): { code: string; reason: string } | null => {
  if (!(error instanceof ProcessError) || (error.code !== "invalid_input" && error.code !== "invalid_state" && error.code !== "not_found")) return null;
  const code = /^[a-z_]+/.exec(error.message)?.[0] ?? error.code;
  const details = Array.isArray(error.details) ? error.details.filter((d): d is string => typeof d === "string") : [];
  return { code, reason: details.length > 0 ? details.join("; ") : error.message };
};

/** The context's nested run (always present inside a runProcess run). */
const run = (ctx: ProcessContext) => {
  if (!ctx.runProcess) throw new ProcessError("handler_failed", "nested process runs are not available here");
  return ctx.runProcess.bind(ctx);
};

const isDuplicate = (error: unknown) => error instanceof ProcessError && error.code === "invalid_input" && error.message.startsWith("duplicate_source_line");

/**
 * Picks the bucket each line leaves from, under the stock locks of its products (lockStock): the bodega's own stock when it covers the
 * line, else the ubicación (not transit, not deleted) holding the most, after what earlier lines took. A line no single bucket covers is
 * named (split_location) unless the bodega allows backorders.
 */
async function pickBuckets(ctx: ProcessContext, warehouse: { id: string; allowBackorders: boolean }, lines: { productId: string; qty: number; sku: string; lineNo: number }[]) {
  await lockStock(ctx, warehouse.id, lines.map((l) => l.productId));
  const rows = await ctx.tx<{ product_id: string; location_id: string | null; on_hand: string }[]>`
    select s.product_id, s.location_id, s.on_hand::text from inventory.stock_levels s left join inventory.locations l on l.id = s.location_id
    where s.company_id = ${ctx.companyId} and s.warehouse_id = ${warehouse.id} and s.product_id = any(${[...new Set(lines.map((l) => l.productId))]}::uuid[])
      and s.lot_id is null and s.serial_id is null and (s.location_id is null or (l.deleted_at is null and l.kind <> 'transit'))`;
  const left = new Map(rows.map((r) => [`${r.product_id}|${r.location_id ?? ""}`, num(r.on_hand)]));
  const picked: (string | null)[] = [];
  const split: string[] = [];
  for (const line of lines) {
    const buckets = rows.filter((r) => r.product_id === line.productId).map((r) => ({ locationId: r.location_id, onHand: left.get(`${r.product_id}|${r.location_id ?? ""}`)! }));
    const own = buckets.find((b) => b.locationId === null);
    const best = buckets.filter((b) => b.locationId !== null).sort((a, b) => b.onHand - a.onHand || String(a.locationId).localeCompare(String(b.locationId)))[0];
    let choice: string | null = null;
    if (own && own.onHand >= line.qty) choice = null;
    else if (best && best.onHand >= line.qty) choice = best.locationId;
    else {
      // Short in total: no split to report, the post refuses it (negative_stock_refused). Enough in total but in no single bucket: split.
      const total = buckets.reduce((sum, b) => sum + b.onHand, 0);
      if (!warehouse.allowBackorders && total >= line.qty) {
        const most = Math.max(0, ...buckets.map((b) => b.onHand));
        split.push(`Línea ${line.lineNo}: ninguna ubicación de la bodega tiene ${line.qty} de ${line.sku} (la que más tiene, ${most}); cada línea sale de una sola ubicación`);
      }
      choice = best && best.onHand > (own?.onHand ?? 0) ? best.locationId : null;
    }
    const key = `${line.productId}|${choice ?? ""}`;
    left.set(key, round4((left.get(key) ?? 0) - line.qty));
    picked.push(choice);
  }
  return { picked, split };
}

/** Posts `input` in a savepoint: a refusal leaves nothing written; a concurrent post of the same source lines answers that movement. */
async function postInSavepoint(ctx: ProcessContext, input: Parameters<typeof postMovement>[1]): Promise<{ id: string | null; created: boolean } | { refused: { code: string; reason: string } }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const posted = await ctx.tx.savepoint((sp) => postMovement({ ...ctx, tx: sp as unknown as ProcessContext["tx"] }, input));
      // The retry after duplicate_source_line answers the movement a concurrent run wrote: not this run's.
      return { id: posted.id, created: attempt === 0 };
    } catch (error) {
      if (isDuplicate(error) && attempt === 0) continue;
      const refused = refusalOf(error);
      if (!refused) throw error;
      return { refused };
    }
  }
}

/** The saved or voided movements of `kind` a sales document posted, oldest first. */
async function movementsOf(ctx: ProcessContext, sourceEntity: string, sourceId: string, kind: string) {
  return ctx.tx<{ id: string; status: string }[]>`
    select id, status from inventory.movements where company_id = ${ctx.companyId} and source_entity = ${sourceEntity} and source_id = ${sourceId} and kind = ${kind}
    order by seq`;
}

export const saleIssue = defineProcess({
  id: "inventory.sale.issue",
  module: "inventory",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_POSTED, SALE_ISSUE_REFUSED],
  description: "Descarga las existencias de una entrega despachada y usa su reserva; si no puede, lo avisa a ventas. Solo lo ejecuta el evento de despacho",
  input: shippedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_issue:${input.eventId}`,
  handler: async (ctx, d): Promise<Outcome> => {
    const goods = await goodsOf(ctx, d.lines.map((l) => l.productId));
    const moving = d.lines.map((l, i) => ({ ...l, lineNo: i + 1 })).filter((l) => goods.has(l.productId));
    let movementId: string | null = null;
    // Whether THIS run issued the stock: only then does it use up the pedido's reservation. A run that finds the movement already there (a
    // redelivery, a duplicated despacho event with another id, a concurrent run) changes nothing more (review round 2, N2: the release is
    // not idempotent per entrega line, a second release of a partial entrega would free stock the pedido still holds).
    let issuedNow = false;
    const existingMovement = async () =>
      (await ctx.tx<{ movement_id: string }[]>`
        select movement_id from inventory.movement_lines where company_id = ${ctx.companyId} and source_entity = ${DELIVERY_SOURCE}
          and source_line_id = any(${moving.map((l) => l.lineId)}::uuid[]) limit 1`)[0]?.movement_id ?? null;
    if (moving.length > 0) {
      // The movement of these lines already posted (a redelivery after a lost answer, a concurrent run): it is the answer.
      const existing = await existingMovement();
      if (existing) movementId = existing;
      else {
        const refuse = async (code: string, reason: string): Promise<Outcome> => {
          await ctx.emit(SALE_ISSUE_REFUSED, { deliveryId: d.deliveryId, deliveryLineId: moving[0]!.lineId, shippedEventId: d.eventId, number: d.number ?? null, code, reason });
          return { status: "refused", movementId: null };
        };
        let warehouse: { id: string; allowBackorders: boolean };
        try {
          warehouse = await warehouseOf(ctx, d.warehouseId);
        } catch (error) {
          const refused = refusalOf(error);
          if (!refused) throw error;
          return refuse(refused.code, refused.reason);
        }
        const { picked, split } = await pickBuckets(ctx, warehouse, moving.map((l) => ({ productId: l.productId, qty: l.qty, sku: goods.get(l.productId)!.sku, lineNo: l.lineNo })));
        // pickBuckets holds the stock lock of every product of the lines: a concurrent run of the same lines has committed by now, and its
        // movement is the answer (no second issue, no second release).
        const committed = await existingMovement();
        if (committed) movementId = committed;
        else {
          if (split.length > 0) return refuse("split_location", split.join("; "));
          const posted = await postInSavepoint(ctx, {
            kind: "sale_issue",
            date: d.date,
            warehouseId: d.warehouseId,
            sourceEntity: DELIVERY_SOURCE,
            sourceId: d.deliveryId,
            ...(d.number ? { reference: d.number } : {}),
            ...(d.costCenterId ? { costCenterId: d.costCenterId } : {}),
            lines: moving.map((l, i) => ({ productId: l.productId, qty: -l.qty, sourceLineId: l.lineId, ...(picked[i] ? { locationId: picked[i]! } : {}) })),
          } as Parameters<typeof postMovement>[1]);
          if ("refused" in posted) return refuse(posted.refused.code, posted.refused.reason);
          movementId = posted.id;
          issuedNow = posted.created;
        }
      }
    }
    // What shipped uses up the pedido line's reservation (a short line reserved less, or nothing: what is left of it is released, or nothing).
    // An entrega of services only moves no stock and releases nothing either.
    if (!issuedNow) return { status: movementId ? "posted" : "nothing", movementId };
    for (const line of d.lines) {
      if (!line.orderLineId || !goods.has(line.productId)) continue;
      await run(ctx)("inventory.reservation.release", { sourceEntity: ORDER_LINE_SOURCE, sourceLineId: line.orderLineId, qty: line.qty });
    }
    return { status: movementId ? "posted" : "nothing", movementId };
  },
});

export const saleVoidIssue = defineProcess({
  id: "inventory.sale.void_issue",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_VOIDED, DELIVERY_RESERVATION_RESTORED],
  description:
    "Anula la salida de inventario de una entrega anulada y reintegra sus existencias; si se pidió, vuelve a reservarlas para el pedido cuando alcanzan. Solo lo ejecuta el evento de anulación",
  input: voidedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_void_issue:${input.eventId}`,
  handler: async (ctx, d): Promise<Outcome> => {
    /** The re-reservation the event asked for, in this transaction after the stock is back, and its outcome for sales (Task 43, R43-1..R43-3). */
    const reReserve = async (nothingUsedUp = false): Promise<void> => {
      if (!d.reReserve) return;
      // R43-15 (review I-2, M-1): an entrega whose issue never posted (all its despachos refused, no tracked line) or was already voided used
      // nothing up: it answers `nothing` without reserving anything, so the entrega's result always resolves and a reservation never doubles.
      if (nothingUsedUp) {
        await ctx.emit(DELIVERY_RESERVATION_RESTORED, { deliveryId: d.deliveryId, voidedEventId: d.eventId, status: "nothing", short: [], lines: [] });
        return;
      }
      const lines = d.lines.flatMap((l) => (l.orderLineId && l.qty !== undefined ? [{ orderLineId: l.orderLineId, productId: l.productId, qty: l.qty }] : []));
      const result = d.warehouseId && lines.length > 0
        ? ((await run(ctx)("inventory.reservation.reserve_again", { deliveryId: d.deliveryId, warehouseId: d.warehouseId, lines })) as { status: string; lines: unknown[]; short: unknown[] })
        : { status: "nothing", lines: [], short: [] };
      await ctx.emit(DELIVERY_RESERVATION_RESTORED, { deliveryId: d.deliveryId, voidedEventId: d.eventId, status: result.status, short: result.short, lines: result.lines });
    };
    const [movement] = await movementsOf(ctx, DELIVERY_SOURCE, d.deliveryId, "sale_issue");
    if (!movement) {
      const goods = await goodsOf(ctx, d.lines.map((l) => l.productId));
      if (goods.size === 0) {
        await reReserve(true);
        return { status: "nothing", movementId: null };
      }
      // Every despacho of the entrega was refused (each shipped event answered by a refused one): no issue ever existed.
      const [count] = await ctx.tx<{ shipped: number; refused: number }[]>`
        select count(*) filter (where event = 'sales.delivery.shipped')::int as shipped, count(*) filter (where event = ${SALE_ISSUE_REFUSED})::int as refused
        from kernel.outbox where company_id = ${ctx.companyId} and event in ('sales.delivery.shipped', ${SALE_ISSUE_REFUSED}) and payload->>'deliveryId' = ${d.deliveryId}`;
      if (count && count.shipped > 0 && count.refused >= count.shipped) {
        await reReserve(true);
        return { status: "nothing", movementId: null };
      }
      // Its sale issue is not posted yet (the shipped event is still on its way): retried by the outbox, never lost.
      throw new ProcessError("handler_failed", `sales.delivery.voided: the sale issue of delivery ${d.deliveryId} is not posted yet`);
    }
    if (movement.status === "voided") {
      await reReserve(true);
      return { status: "voided", movementId: movement.id };
    }
    await run(ctx)("inventory.movement.void", { id: movement.id, reason: `Entrega anulada: ${d.reason}` });
    await reReserve();
    return { status: "voided", movementId: movement.id };
  },
});

export const saleReturn = defineProcess({
  id: "inventory.sale.return",
  module: "inventory",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_POSTED],
  description: "Reintegra a la bodega las existencias de una devolución recibida, al costo de la salida original. Solo lo ejecuta el evento de recibo",
  input: receivedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_return:${input.eventId}`,
  handler: async (ctx, r): Promise<Outcome> => {
    const goods = await goodsOf(ctx, r.lines.map((l) => l.productId));
    const moving = r.lines.filter((l) => goods.has(l.productId));
    if (moving.length === 0) return { status: "nothing", movementId: null };
    const [existing] = await ctx.tx<{ movement_id: string }[]>`
      select movement_id from inventory.movement_lines where company_id = ${ctx.companyId} and source_entity = ${RETURN_SOURCE}
        and source_line_id = any(${moving.map((l) => l.lineId)}::uuid[]) limit 1`;
    if (existing) return { status: "posted", movementId: existing.movement_id };
    // Each line re-enters where its sale issue left from; an entrega line whose issue is not posted yet is retried.
    const issued = await ctx.tx<{ source_line_id: string; location_id: string | null }[]>`
      select l.source_line_id, l.location_id from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
      where l.company_id = ${ctx.companyId} and l.source_entity = ${DELIVERY_SOURCE} and m.status = 'saved'
        and l.source_line_id = any(${moving.map((l) => l.deliveryLineId)}::uuid[])`;
    const from = new Map(issued.map((i) => [i.source_line_id, i.location_id]));
    if (moving.some((l) => !from.has(l.deliveryLineId))) {
      throw new ProcessError("handler_failed", `sales.return.received: the sale issue of a line of return ${r.returnId} is not posted yet`);
    }
    const posted = await postInSavepoint(ctx, {
      kind: "sale_return",
      date: r.date,
      warehouseId: r.warehouseId,
      sourceEntity: RETURN_SOURCE,
      sourceId: r.returnId,
      ...(r.number ? { reference: r.number } : {}),
      ...(r.costCenterId ? { costCenterId: r.costCenterId } : {}),
      lines: moving.map((l) => {
        const locationId = from.get(l.deliveryLineId) ?? null;
        return { productId: l.productId, qty: l.qty, sourceLineId: l.lineId, ...(locationId ? { locationId } : {}), returnOf: { sourceEntity: DELIVERY_SOURCE, sourceLineId: l.deliveryLineId } };
      }),
    } as Parameters<typeof postMovement>[1]);
    // A return inventory refuses (its issue was voided meanwhile) cannot become valid by retrying: it is dead-lettered with its reason.
    if ("refused" in posted) throw new ProcessError("invalid_input", `${posted.refused.code}: ${posted.refused.reason}`, { details: [posted.refused.reason] });
    return { status: "posted", movementId: posted.id };
  },
});

export const saleVoidReturn = defineProcess({
  id: "inventory.sale.void_return",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_VOIDED, SALE_RETURN_VOID_REFUSED],
  description: "Anula la entrada de inventario de una devolución anulada; si sus existencias ya salieron, lo avisa a ventas. Solo lo ejecuta el evento de anulación",
  input: returnVoidedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_void_return:${input.eventId}`,
  handler: async (ctx, r): Promise<Outcome> => {
    const [movement] = await movementsOf(ctx, RETURN_SOURCE, r.returnId, "sale_return");
    if (!movement) {
      const goods = await goodsOf(ctx, r.lines.map((l) => l.productId));
      if (goods.size === 0) return { status: "nothing", movementId: null };
      throw new ProcessError("handler_failed", `sales.return.voided: the sale return of ${r.returnId} is not posted yet`);
    }
    if (movement.status === "voided") return { status: "voided", movementId: movement.id };
    try {
      // In a savepoint (one connection: the nested run's writes are inside it), so a refusal leaves nothing written.
      await ctx.tx.savepoint(() => run(ctx)("inventory.movement.void", { id: movement.id, reason: `Devolución anulada: ${r.reason}` }));
    } catch (error) {
      const refused = refusalOf(error);
      if (!refused) throw error;
      await ctx.emit(SALE_RETURN_VOID_REFUSED, { returnId: r.returnId, voidedEventId: r.eventId, code: refused.code, reason: refused.reason });
      return { status: "refused", movementId: movement.id };
    }
    return { status: "voided", movementId: movement.id };
  },
});

const withEvent = (ctx: Parameters<EventConsumer>[0], payload: unknown) => ({ ...(payload as Record<string, unknown>), eventId: ctx.event.id });
const pick = <T extends z.ZodObject>(schema: T, value: Record<string, unknown>) => Object.fromEntries(Object.keys(schema.shape).filter((k) => k in value).map((k) => [k, value[k]]));

export const onDeliveryShipped: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.issue", pick(shippedInput, withEvent(ctx, payload)));
};
export const onDeliveryVoided: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.void_issue", pick(voidedInput, withEvent(ctx, payload)));
};
export const onReturnReceived: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.return", pick(receivedInput, withEvent(ctx, payload)));
};
export const onReturnVoided: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.void_return", pick(returnVoidedInput, withEvent(ctx, payload)));
};

export const SALE_DELIVERY_PROCESSES = [saleIssue, saleVoidIssue, saleReturn, saleVoidReturn];
