import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { entityId, id, idInput, num, productFacts, qtyText, quantity, refuse } from "./common";
import { companyToday, lockStock } from "./movement";
import { ORDER_LINE_SOURCE } from "./sales-orders";

// Reservations (plan 2B Task 6, used by the sales orders of Task 13 through their events): stock promised to a source line until it is
// delivered or released. inventory.reservation.create reserves `qty` of a product in a bodega for (sourceEntity, sourceLineId) and refuses
// more than is available there (on hand of every ubicación minus what is already reserved: `reservation_exceeds_available`); the stock rows
// of the product in the bodega are locked first (lockStock: the same lock order as every movement), so two reservations of the last unit
// queue and the second sees the first, and a reservation never deadlocks with a movement. Both processes are idempotent on the source
// line, so a redelivered event changes nothing: a create while the line has an active reservation answers it, a release of what is
// already released (or was never reserved) answers it as it is. Once released, the line can be reserved again (an order cancelled and
// confirmed again, Task 13): one active reservation per source line, any number of released ones. A product that keeps no stock (or a
// service) reserves nothing (`not_tracked`), so an order line of a service goes through. Reserved and available are published in
// inventory.v_stock, where a reservation sits at the bodega level (a null ubicación) until picking (2B.2).
//
// `allowPartial` (Task 13: the reservation of a confirmed pedido line, by event): instead of refusing a shortfall, reserve what is available
// (the rest stays a backorder of the source, which reserves nothing more by itself) and answer `short` with nothing reserved when nothing is
// available. A pedido is never refused for lack of stock; its delivery (Task 14) moves what there is. `once` (the same consumer): a source
// line whose reservation was already released is not reserved again, so a confirmation redelivered after its pedido was cancelled (a retry
// that ran late) reserves nothing; it answers the released reservation. `tombstone` (release, the same consumer): releasing a source line
// that has no reservation (a cancellation consumed before its confirmation, or a short line that reserved nothing) writes a released row
// of the line, so a confirmation delivered after it finds a released reservation and, with `once`, reserves nothing. Events may arrive in
// any order (a retried confirmation after its cancellation): the line ends unreserved either way.
//
// inventory.reservation.reserve_again (plan 2B.2 Task 43): the one run nested in inventory.sale.void_issue (the consumer of a voided
// entrega that asked for it). The stock the voided issue brought back is promised again to the pedido lines by what the entrega had used up,
// all or nothing per entrega: availability is summed per product over the entrega's lines (on hand of the bodega minus every active
// reservation), and when any product is short NOTHING is reserved and the answer names each short product (a throw would roll back the stock
// return of the void; the void itself never fails for this). A line's active reservation is topped up (one active row per source line); a
// line whose reservation was released gets a new active row (the released one stays as history). A service or a product that keeps no stock
// is skipped. R43-14: only the event's bodega is checked and locked, so a line whose active reservation is in another bodega is never topped up
// (answered short). See docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md, Task 43 (R43-1..R43-12).

const FEATURE = "inventory.stock";

const output = z.object({
  id: z.string().nullable(),
  status: z.enum(["active", "released", "absent", "not_tracked", "short"]),
  /** What stays reserved after the run. */
  reserved: z.number(),
  /** With allowPartial: what could not be reserved for lack of stock (the backorder); absent otherwise. */
  shortfall: z.number().optional(),
});
type Out = z.output<typeof output>;

const positive = quantity.refine((n) => n > 0, "La cantidad debe ser mayor que cero");

type Row = { id: string; qty: string; released_qty: string; status: "active" | "released" };
const answer = (row: Row): Out => ({ id: row.id, status: row.status, reserved: row.status === "released" ? 0 : num(row.qty) - num(row.released_qty) });

/** The reservation of a source line: the active one, else the last released one. `lock` takes it `for update`. */
async function reservationOf(ctx: ProcessContext, sourceEntity: string, sourceLineId: string, lock: boolean): Promise<Row | undefined> {
  const [row] = lock
    ? await ctx.tx<Row[]>`select id, qty, released_qty, status from inventory.reservations where company_id = ${ctx.companyId} and source_entity = ${sourceEntity} and source_line_id = ${sourceLineId} order by (status = 'active') desc, seq desc limit 1 for update`
    : await ctx.tx<Row[]>`select id, qty, released_qty, status from inventory.reservations where company_id = ${ctx.companyId} and source_entity = ${sourceEntity} and source_line_id = ${sourceLineId} order by (status = 'active') desc, seq desc limit 1`;
  return row;
}

export const reservationCreate = defineProcess({
  id: "inventory.reservation.create",
  module: "inventory",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  description: "Reserva existencias de un producto en una bodega para una línea de un documento (p. ej. un pedido); rechaza reservar más de lo disponible",
  input: z.object({
    sourceEntity: entityId,
    sourceLineId: id,
    productId: id,
    warehouseId: id,
    qty: positive,
    /** Reserve what is available instead of refusing a shortfall (the rest is answered as `shortfall`). */
    allowPartial: z.boolean().optional(),
    /** A source line whose reservation was already released is not reserved again (answers the released one). */
    once: z.boolean().optional(),
  }).strict(),
  output,
  handler: async (ctx, input) => {
    const product = (await productFacts(ctx, [input.productId])).get(input.productId);
    if (!product) refuse("invalid_reservation", ["El producto no existe o no es visible"]);
    if (product.kind === "service" || !product.trackStock) return { id: null, status: "not_tracked" as const, reserved: 0 };
    const [warehouse] = await ctx.tx`select id from inventory.warehouses where id = ${input.warehouseId} and deleted_at is null`;
    if (!warehouse) refuse("invalid_reservation", ["La bodega no existe"]);

    // The product's stock in the bodega, locked (lockStock): a concurrent reservation or movement of the same product waits for this one.
    // Read after the lock, so a concurrent create of the same source line that committed first is seen here.
    await lockStock(ctx, input.warehouseId, [input.productId]);
    const existing = await reservationOf(ctx, input.sourceEntity, input.sourceLineId, false);
    if (existing?.status === "active") return answer(existing);
    if (existing && input.once) return answer(existing);

    // RG-4 (Task 28.3): only the stock FEFO may issue today counts: a blocked lot, or (block_expired) an expired one, is not available.
    const on = await companyToday(ctx);
    const [stock] = await ctx.tx<{ available: string; is_short: boolean }[]>`
      with on_hand as (
        select coalesce(sum(on_hand), 0) as v from inventory.stock_levels
        where company_id = ${ctx.companyId} and product_id = ${input.productId} and warehouse_id = ${input.warehouseId}
          and inventory.lot_sellable(lot_id, ${on}::date)
      ), reserved as (
        select coalesce(sum(qty - released_qty), 0) as v from inventory.reservations
        where company_id = ${ctx.companyId} and product_id = ${input.productId} and warehouse_id = ${input.warehouseId} and status = 'active'
      )
      select (on_hand.v - reserved.v)::text as available, ${String(input.qty)}::numeric > on_hand.v - reserved.v as is_short from on_hand, reserved`;
    const available = num(stock!.available);
    let qty = input.qty;
    if (stock!.is_short && input.allowPartial) {
      if (available <= 0) return { id: null, status: "short" as const, reserved: 0, shortfall: input.qty };
      qty = available;
    } else if (stock!.is_short) {
      refuse("reservation_exceeds_available", [`El producto ${product.sku} tiene ${qtyText(Math.max(available, 0))} disponible en la bodega y la reserva pide ${qtyText(input.qty)}`]);
    }
    const [row] = await ctx.tx<Row[]>`
      insert into inventory.reservations ${ctx.tx({
        company_id: ctx.companyId,
        source_entity: input.sourceEntity,
        source_line_id: input.sourceLineId,
        product_id: input.productId,
        warehouse_id: input.warehouseId,
        qty,
      })}
      returning id, qty, released_qty, status`;
    return input.allowPartial ? { ...answer(row!), shortfall: Math.round((input.qty - qty) * 1e4) / 1e4 } : answer(row!);
  },
});

export const reservationRelease = defineProcess({
  id: "inventory.reservation.release",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  description: "Libera, toda o en parte, la reserva de existencias de una línea de un documento (p. ej. al cancelar o entregar un pedido)",
  input: z.object({
    sourceEntity: entityId,
    sourceLineId: id,
    qty: positive.optional(),
    productId: id.optional(),
    warehouseId: id.optional(),
    /** No reservation for the line: write a released one (needs productId, warehouseId and qty), so a later create with `once` reserves nothing. */
    tombstone: z.boolean().optional(),
  }).strict(),
  output,
  handler: async (ctx, input) => {
    const row = await reservationOf(ctx, input.sourceEntity, input.sourceLineId, true);
    if (!row && input.tombstone) {
      if (!input.productId || !input.warehouseId || input.qty === undefined) refuse("invalid_reservation", ["Un cierre sin reserva necesita el producto, la bodega y la cantidad"]);
      const product = (await productFacts(ctx, [input.productId])).get(input.productId);
      const [warehouse] = await ctx.tx`select id from inventory.warehouses where id = ${input.warehouseId}`;
      // A product that keeps no stock never reserves (not_tracked), and an unknown bodega reserves nothing: nothing to close.
      if (!product || product.kind === "service" || !product.trackStock || !warehouse) return { id: null, status: "absent" as const, reserved: 0 };
      // The same lock as create: a create of the line running now either committed first (released above) or sees this row.
      await lockStock(ctx, input.warehouseId, [input.productId]);
      const again = await reservationOf(ctx, input.sourceEntity, input.sourceLineId, true);
      if (again) return releaseRow(ctx, again, input.qty);
      const [closed] = await ctx.tx<Row[]>`
        insert into inventory.reservations ${ctx.tx({
          company_id: ctx.companyId,
          source_entity: input.sourceEntity,
          source_line_id: input.sourceLineId,
          product_id: input.productId,
          warehouse_id: input.warehouseId,
          qty: input.qty,
          released_qty: input.qty,
          status: "released",
          released_at: new Date(),
        })}
        returning id, qty, released_qty, status`;
      return answer(closed!);
    }
    if (!row) return { id: null, status: "absent" as const, reserved: 0 };
    return releaseRow(ctx, row, input.qty);
  },
});

/** Releases `qty` (default: all that remains) of the reservation `row`; a released one is answered as it is. */
async function releaseRow(ctx: ProcessContext, row: Row, qty: number | undefined): Promise<Out> {
  if (row.status === "released") return answer(row);
  const remaining = num(row.qty) - num(row.released_qty);
  const take = Math.min(qty ?? remaining, remaining);
  const left = Math.round((remaining - take) * 1e4) / 1e4;
  const [updated] = await ctx.tx<Row[]>`
    update inventory.reservations
       set released_qty = released_qty + ${take},
           status = ${left === 0 ? "released" : "active"},
           released_at = case when ${left === 0}::boolean then now() end
     where id = ${row.id}
    returning id, qty, released_qty, status`;
  // A reservation released in full holds no shelf any more (Task 29.1): its allocations (where, from which lot and serial it would be
  // picked) go with it. A partial release (a shipment) keeps them: the entrega's issue uses them up (Task 29.3).
  if (left === 0) await ctx.tx`delete from inventory.reservation_allocations where reservation_id = ${row.id}`;
  return answer(updated!);
}

export const reservationConsult = defineProcess({
  id: "inventory.reservation.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una reserva de existencias con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: reservationId }) => {
    const [row] = await ctx.tx`select * from inventory.v_reservations where id = ${reservationId}`;
    if (!row) throw new ProcessError("not_found", `reservation ${reservationId} not found`);
    return { ...row, id: reservationId };
  },
});

const reserveAgainOutput = z.object({
  status: z.enum(["reserved", "insufficient", "nothing"]),
  lines: z.array(z.object({ orderLineId: z.string(), productId: z.string(), qty: z.number() })),
  short: z.array(z.object({ productId: z.string(), sku: z.string(), needed: z.number(), available: z.number() })),
});

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export const reservationReserveAgain = defineProcess({
  id: "inventory.reservation.reserve_again",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  nestedOnlyFrom: ["inventory.sale.void_issue"],
  description:
    "Reserva de nuevo, para las líneas del pedido, las existencias que una entrega anulada devolvió a la bodega: todo o nada, solo si alcanzan. Solo corre dentro de la anulación de la salida de inventario de la entrega",
  input: z.object({
    deliveryId: id,
    warehouseId: id,
    lines: z.array(z.object({ orderLineId: id, productId: id, qty: positive }).strict()).max(500),
  }).strict(),
  output: reserveAgainOutput,
  handler: async (ctx, input) => {
    const facts = await productFacts(ctx, input.lines.map((l) => l.productId));
    const tracked = input.lines.filter((l) => {
      const p = facts.get(l.productId);
      return p && p.kind !== "service" && p.trackStock;
    });
    if (tracked.length === 0) return { status: "nothing" as const, lines: [], short: [] };
    const products = [...new Set(tracked.map((l) => l.productId))].sort();
    // The same lock order as every movement and reservation (lockStock sorts the products).
    await lockStock(ctx, input.warehouseId, products);
    // Owner item 119(c) (F-4.7): each line gets back at most what its reservation released at ship (released_qty), never what the entrega
    // shipped: a pedido without bodega, a line that reserved short (backorder) or nothing, gets only what it had. The reservation is put
    // back by un-releasing that quantity (so a second ship and void cannot grow it past the original).
    const plan: { line: (typeof tracked)[number]; row: { id: string; warehouse_id: string; status: string }; qty: number }[] = [];
    const leftOf = new Map<string, number>();
    for (const line of tracked) {
      const [row] = await ctx.tx<{ id: string; warehouse_id: string; status: string; qty: string; released_qty: string }[]>`
        select id, warehouse_id, status, qty::text, released_qty::text from inventory.reservations
        where company_id = ${ctx.companyId} and source_entity = ${ORDER_LINE_SOURCE} and source_line_id = ${line.orderLineId}
        order by (status = 'active') desc, seq desc limit 1 for update`;
      if (!row) continue;
      // The row is the line's active one, else its latest released one (it comes back to life: one active row per line).
      const qty = Math.min(line.qty, round4(num(row.released_qty) - (leftOf.get(row.id) ?? 0)));
      if (qty <= 0) continue;
      leftOf.set(row.id, round4((leftOf.get(row.id) ?? 0) + qty));
      plan.push({ line, row, qty });
    }
    if (plan.length === 0) return { status: "nothing" as const, lines: [], short: [] };
    // The stock FEFO may issue today (RG-4, Task 28.3): blocked and expired lots are not promised again.
    const today = await companyToday(ctx);
    const stock = await ctx.tx<{ product_id: string; on_hand: string; reserved: string }[]>`
      select p as product_id,
             coalesce((select sum(on_hand) from inventory.stock_levels where company_id = ${ctx.companyId} and warehouse_id = ${input.warehouseId} and product_id = p
                         and inventory.lot_sellable(lot_id, ${today}::date)), 0)::text as on_hand,
             coalesce((select sum(qty - released_qty) from inventory.reservations where company_id = ${ctx.companyId} and warehouse_id = ${input.warehouseId} and product_id = p and status = 'active'), 0)::text as reserved
      from unnest(${[...new Set(plan.map((x) => x.line.productId))].sort()}::uuid[]) as p`;
    const short: z.output<typeof reserveAgainOutput>["short"] = [];
    const neededOf = (productId: string) => round4(plan.filter((x) => x.line.productId === productId).reduce((sum, x) => sum + x.qty, 0));
    for (const s of stock) {
      const needed = neededOf(s.product_id);
      const available = round4(num(s.on_hand) - num(s.reserved));
      if (needed > available) short.push({ productId: s.product_id, sku: facts.get(s.product_id)!.sku, needed, available: Math.max(available, 0) });
    }
    // R43-14: a reservation is only ever restored in the bodega whose stock was checked and locked above. A line whose reservation sits in
    // another bodega (its entrega shipped from a different one) cannot be covered there without checking and locking that stock: it is
    // answered as short (available 0) and nothing is reserved.
    for (const x of plan) {
      if (x.row.warehouse_id === input.warehouseId || short.some((k) => k.productId === x.line.productId)) continue;
      short.push({ productId: x.line.productId, sku: facts.get(x.line.productId)!.sku, needed: neededOf(x.line.productId), available: 0 });
    }
    if (short.length > 0) return { status: "insufficient" as const, lines: [], short };
    for (const x of plan) {
      await ctx.tx`
        update inventory.reservations
           set released_qty = released_qty - ${x.qty}, status = 'active', released_at = null
         where id = ${x.row.id}`;
    }
    return { status: "reserved" as const, lines: plan.map((x) => ({ orderLineId: x.line.orderLineId, productId: x.line.productId, qty: x.qty })), short: [] };
  },
});

// -------------------------------------------------------------------------------------------------
// inventory.reservation.allocate (plan 2B.2 Task 29.1, PG §4.3 step 3; RG-7)
// -------------------------------------------------------------------------------------------------

/** inventory's answer to a confirmed alistamiento (consumed by warehouse.pick.record_allocation and, Task 29.2, by sales). */
export const RESERVATION_ALLOCATED = "inventory.reservation.allocated";

const allocateLine = z.object({
  orderLineId: id,
  productId: id,
  locationId: id,
  lotId: id.nullable().optional(),
  serialId: id.nullable().optional(),
  qty: positive,
}).strict();

const allocateOutput = z.object({
  status: z.enum(["allocated", "short"]),
  short: z.array(z.object({
    orderLineId: z.string(), productId: z.string(), locationId: z.string(), lotId: z.string().nullable(), serialId: z.string().nullable(),
    qty: z.number(), available: z.number(), reason: z.string(),
  })),
});

/**
 * The allocation of a confirmed alistamiento (consumer of warehouse.pick.confirmed, origin event): each picked line becomes an allocation of
 * its pedido line's active reservation (inventory.reservation_allocations: ubicación, lot, serial, quantity). Nothing moves (RG-7): the
 * stock moves at the entrega's ship. All or nothing per alistamiento: a line is short (`allocation_short`) when its bucket (product,
 * ubicación, lot, serial in the event's bodega; a lot inventory.lot_sellable refuses today holds nothing, RG-4) holds less than it, net of
 * what the allocations of every other active reservation (and the earlier lines of the alistamiento) already hold of it, or when its
 * reservation has less open (qty − released − already allocated) than it; then NOTHING is allocated and the answer names each short line
 * (with its bucket) and what was available. A line that takes more than its reservation has open first drops that excess of the line's
 * earlier allocations, newest first (a re-pick replaces the stale part, see the handler). The stock rows are locked first (lockStock, the
 * order of every movement and reservation), so two alistamientos of the last units queue. Idempotent on the event (a redelivery answers the
 * first run and emits nothing new). Answers by inventory.reservation.allocated { pickId, orderId, warehouseId, createDelivery, status,
 * lines, short }.
 */
export const reservationAllocate = defineProcess({
  id: "inventory.reservation.allocate",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [RESERVATION_ALLOCATED],
  description:
    "Asigna a la reserva de cada línea del pedido la ubicación, el lote y el serial de un alistamiento confirmado, sin mover existencias: todo o nada; si una ubicación no tiene lo tomado, no asigna nada y responde las líneas que faltan",
  idempotencyKey: (input) => `allocate:${input.eventId}`,
  input: z.object({
    eventId: id,
    pickId: id,
    orderId: id,
    warehouseId: id,
    createDelivery: z.boolean(),
    lines: z.array(allocateLine).min(1).max(5000),
  }).strict(),
  output: allocateOutput,
  handler: async (ctx, input) => {
    const facts = await productFacts(ctx, input.lines.map((l) => l.productId));
    const lines = input.lines.filter((l) => {
      const p = facts.get(l.productId);
      return p && p.kind !== "service" && p.trackStock;
    });
    await lockStock(ctx, input.warehouseId, [...new Set(lines.map((l) => l.productId))]);
    const orderLineIds = [...new Set(lines.map((l) => l.orderLineId))];
    const reservations = new Map((orderLineIds.length === 0 ? [] : await ctx.tx<{ id: string; source_line_id: string; open: string }[]>`
      select r.id, r.source_line_id,
             (r.qty - r.released_qty - coalesce((select sum(a.qty) from inventory.reservation_allocations a where a.reservation_id = r.id), 0))::text as open
      from inventory.reservations r
      where r.company_id = ${ctx.companyId} and r.source_entity = ${ORDER_LINE_SOURCE} and r.source_line_id = any(${orderLineIds}::uuid[])
        and r.warehouse_id = ${input.warehouseId} and r.status = 'active'
      for update`).map((r) => [r.source_line_id, { id: r.id, open: num(r.open) }]));
    // A re-pick replaces the earlier allocation (0170): a pedido line's allocation left by an earlier alistamiento whose entrega was voided
    // unshipped (sales says nothing to inventory for it), or that made no entrega (delivery_from_pick off), would keep the reservation full
    // forever. When this alistamiento takes more of a line than its reservation has open, only that excess (need − open) is dropped, from
    // the newest allocation back (the row audit keeps it): the alistamiento asks only what the pedido still has to deliver (qty − what the
    // entregas not voided take), so the excess is never more than the stale part, and what a live entrega still to ship holds (an older
    // allocation, the one its ship uses first) stays.
    const need = new Map<string, number>();
    for (const l of lines) need.set(l.orderLineId, round4((need.get(l.orderLineId) ?? 0) + l.qty));
    for (const [orderLineId, r] of reservations) {
      let excess = round4((need.get(orderLineId) ?? 0) - r.open);
      if (excess <= 0) continue;
      const held = await ctx.tx<{ id: string; qty: string }[]>`
        select id, qty::text from inventory.reservation_allocations where company_id = ${ctx.companyId} and reservation_id = ${r.id} order by seq desc for update`;
      for (const a of held) {
        if (excess <= 0) break;
        const cut = Math.min(excess, num(a.qty));
        if (round4(num(a.qty) - cut) <= 0) await ctx.tx`delete from inventory.reservation_allocations where id = ${a.id}`;
        else await ctx.tx`update inventory.reservation_allocations set qty = qty - ${cut} where id = ${a.id}`;
        excess = round4(excess - cut);
        r.open = round4(r.open + cut);
      }
    }
    // RG-4: only the stock FEFO may issue today is free: a blocked lot, or (block_expired) an expired one, is not (inventory.lot_sellable).
    const today = await companyToday(ctx);
    const bucketKey = (l: { productId: string; locationId: string; lotId?: string | null; serialId?: string | null }) =>
      `${l.productId}|${l.locationId}|${l.lotId ?? ""}|${l.serialId ?? ""}`;
    const free = new Map<string, number>();
    for (const l of lines) {
      const key = bucketKey(l);
      if (free.has(key)) continue;
      const [row] = await ctx.tx<{ free: string }[]>`
        select (coalesce((select sum(s.on_hand) from inventory.stock_levels s
                  where s.company_id = ${ctx.companyId} and s.warehouse_id = ${input.warehouseId} and s.product_id = ${l.productId}
                    and s.location_id = ${l.locationId} and s.lot_id is not distinct from ${l.lotId ?? null}::uuid
                    and inventory.lot_sellable(s.lot_id, ${today}::date)
                    and (${l.serialId ?? null}::uuid is null or s.serial_id = ${l.serialId ?? null}::uuid)), 0)
              - coalesce((select sum(a.qty) from inventory.reservation_allocations a join inventory.reservations r on r.id = a.reservation_id
                  where a.company_id = ${ctx.companyId} and r.status = 'active' and r.warehouse_id = ${input.warehouseId} and r.product_id = ${l.productId}
                    and a.location_id = ${l.locationId} and a.lot_id is not distinct from ${l.lotId ?? null}::uuid
                    and (${l.serialId ?? null}::uuid is null or a.serial_id = ${l.serialId ?? null}::uuid)), 0))::text as free`;
      free.set(key, num(row!.free));
    }
    const short: z.output<typeof allocateOutput>["short"] = [];
    const plan: { reservationId: string; line: (typeof lines)[number] }[] = [];
    for (const l of lines) {
      const key = bucketKey(l);
      const reservation = reservations.get(l.orderLineId);
      const inBucket = Math.max(free.get(key) ?? 0, 0);
      const open = Math.max(reservation?.open ?? 0, 0);
      if (!reservation || l.qty > inBucket || l.qty > open) {
        // The bucket travels with the answer, so warehouse marks the pick line of that ubicación, lot and serial.
        short.push({
          orderLineId: l.orderLineId, productId: l.productId, locationId: l.locationId, lotId: l.lotId ?? null, serialId: l.serialId ?? null,
          qty: l.qty, available: round4(Math.min(inBucket, open)), reason: "allocation_short",
        });
        continue;
      }
      free.set(key, round4(inBucket - l.qty));
      reservation.open = round4(open - l.qty);
      plan.push({ reservationId: reservation.id, line: l });
    }
    const status = short.length > 0 ? ("short" as const) : ("allocated" as const);
    if (status === "allocated" && plan.length > 0) {
      await ctx.tx`insert into inventory.reservation_allocations ${ctx.tx(plan.map((x) => ({
        company_id: ctx.companyId, reservation_id: x.reservationId, location_id: x.line.locationId, lot_id: x.line.lotId ?? null,
        serial_id: x.line.serialId ?? null, qty: x.line.qty,
      })))}`;
    }
    await ctx.emit(RESERVATION_ALLOCATED, {
      pickId: input.pickId,
      orderId: input.orderId,
      warehouseId: input.warehouseId,
      createDelivery: input.createDelivery,
      status,
      lines: status === "allocated" ? plan.map((x) => ({ ...x.line, lotId: x.line.lotId ?? null, serialId: x.line.serialId ?? null, reservationId: x.reservationId })) : [],
      short,
    });
    return { status, short };
  },
});

export const RESERVATION_PROCESSES = [reservationCreate, reservationRelease, reservationReserveAgain, reservationAllocate, reservationConsult];
