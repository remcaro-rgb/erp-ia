import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { entityId, id, idInput, num, productFacts, qtyText, quantity, refuse } from "./common";
import { lockStock } from "./movement";
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

    const [stock] = await ctx.tx<{ available: string; is_short: boolean }[]>`
      with on_hand as (
        select coalesce(sum(on_hand), 0) as v from inventory.stock_levels
        where company_id = ${ctx.companyId} and product_id = ${input.productId} and warehouse_id = ${input.warehouseId}
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
    const stock = await ctx.tx<{ product_id: string; on_hand: string; reserved: string }[]>`
      select p as product_id,
             coalesce((select sum(on_hand) from inventory.stock_levels where company_id = ${ctx.companyId} and warehouse_id = ${input.warehouseId} and product_id = p), 0)::text as on_hand,
             coalesce((select sum(qty - released_qty) from inventory.reservations where company_id = ${ctx.companyId} and warehouse_id = ${input.warehouseId} and product_id = p and status = 'active'), 0)::text as reserved
      from unnest(${products}::uuid[]) as p`;
    const short: z.output<typeof reserveAgainOutput>["short"] = [];
    for (const s of stock) {
      const needed = round4(tracked.filter((l) => l.productId === s.product_id).reduce((sum, l) => sum + l.qty, 0));
      const available = round4(num(s.on_hand) - num(s.reserved));
      if (needed > available) short.push({ productId: s.product_id, sku: facts.get(s.product_id)!.sku, needed, available: Math.max(available, 0) });
    }
    // R43-14: a reservation is only ever topped up in the bodega whose stock was checked and locked above. A line whose active reservation sits
    // in another bodega (its entrega shipped from a different one) cannot be covered there without checking and locking that stock, and the
    // one-active-row-per-line index forbids a second row: it is answered as short (available 0) and nothing is reserved.
    const elsewhere = await ctx.tx<{ source_line_id: string }[]>`
      select source_line_id from inventory.reservations
      where company_id = ${ctx.companyId} and source_entity = ${ORDER_LINE_SOURCE} and status = 'active'
        and source_line_id = any(${tracked.map((l) => l.orderLineId)}::uuid[]) and warehouse_id <> ${input.warehouseId}`;
    for (const row of elsewhere) {
      const line = tracked.find((l) => l.orderLineId === row.source_line_id)!;
      const known = short.find((x) => x.productId === line.productId);
      if (known) continue;
      short.push({ productId: line.productId, sku: facts.get(line.productId)!.sku, needed: round4(tracked.filter((l) => l.productId === line.productId).reduce((sum, l) => sum + l.qty, 0)), available: 0 });
    }
    if (short.length > 0) return { status: "insufficient" as const, lines: [], short };
    for (const line of tracked) {
      const active = await reservationOf(ctx, ORDER_LINE_SOURCE, line.orderLineId, true);
      if (active?.status === "active") {
        await ctx.tx`update inventory.reservations set qty = qty + ${line.qty} where id = ${active.id}`;
      } else {
        await ctx.tx`
          insert into inventory.reservations ${ctx.tx({ company_id: ctx.companyId, source_entity: ORDER_LINE_SOURCE, source_line_id: line.orderLineId, product_id: line.productId, warehouse_id: input.warehouseId, qty: line.qty })}`;
      }
    }
    return { status: "reserved" as const, lines: tracked.map((l) => ({ orderLineId: l.orderLineId, productId: l.productId, qty: l.qty })), short: [] };
  },
});

export const RESERVATION_PROCESSES = [reservationCreate, reservationRelease, reservationReserveAgain, reservationConsult];
