import { ProcessError, type EventConsumer } from "@erp/kernel";
import { z } from "zod";

// What the warehouse module does with other modules' events (plan 2B.2 Task 29.1, PG §4.3 steps 1, 3 and 7), by event name (it does not
// import sales or inventory, rule 4). Each consumer runs a registered process with origin `event`, as the system user:
//   sales.order.confirmed        → warehouse.pick.create (only while auto_pick_on_confirm is on; RG-10 for a replayed confirmation);
//   sales.order.cancelled        → warehouse.pick.void of each of the pedido's alistamientos not yet voided (inventory's release of the
//                                  reservation drops the allocations of a confirmed one), then warehouse.pack.void of their open empaques;
//   inventory.reservation.allocated → warehouse.pick.record_allocation (allocated, or short: back to «En proceso»);
//   inventory.movement.posted    → warehouse.putaway.notify for a receipt (Task 29.3): the «por ubicar» recommendation when a rule
//                                  places some of it elsewhere (RG-10: not for a receipt posted before the module started); for a
//                                  relocation, the put-away confirmed on its chain is recorded as relocated (0174).
// A redelivered event changes nothing: create and record_allocation are idempotent on the event id, and a voided alistamiento is skipped.

export const ORDER_CONFIRMED = "sales.order.confirmed";
export const ORDER_CANCELLED = "sales.order.cancelled";
export const RESERVATION_ALLOCATED = "inventory.reservation.allocated";
export const MOVEMENT_POSTED = "inventory.movement.posted";

const uuid = z.uuid();

function parse<T extends z.ZodTypeAny>(schema: T, event: string, payload: unknown): z.output<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${event} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

const confirmedPayload = z.looseObject({
  orderId: uuid,
  dates: z.looseObject({ confirmedAt: z.union([z.string(), z.date()]).nullable().optional() }).optional(),
});

export const onOrderConfirmed: EventConsumer = async (ctx, payload) => {
  const order = parse(confirmedPayload, ORDER_CONFIRMED, payload);
  const at = order.dates?.confirmedAt;
  // When the pedido was confirmed (RG-10); the event's own time when the payload does not say.
  const confirmedAt = at instanceof Date ? at.toISOString() : (at ?? ctx.event.createdAt.toISOString());
  await ctx.runProcess("warehouse.pick.create", { orderId: order.orderId, eventId: ctx.event.id, confirmedAt });
};

const cancelledPayload = z.looseObject({ orderId: uuid, reason: z.string().optional() });

export const onOrderCancelled: EventConsumer = async (ctx, payload) => {
  const order = parse(cancelledPayload, ORDER_CANCELLED, payload);
  const picks = await ctx.sql<{ id: string }[]>`
    select id from warehouse.picks where company_id = ${ctx.companyId} and order_id = ${order.orderId} and status <> 'voided' order by seq`;
  const reason = `Pedido cancelado${order.reason ? `: ${order.reason}` : ""}`.slice(0, 1000);
  for (const pick of picks) await ctx.runProcess("warehouse.pick.void", { id: pick.id, reason });
  // The open empaques of those alistamientos go with them (a closed one stays as it was packed: it no longer changes).
  const packs = await ctx.sql<{ id: string }[]>`
    select id from warehouse.packs where company_id = ${ctx.companyId} and order_id = ${order.orderId} and status <> 'voided' and stage = 'open' order by seq`;
  for (const pack of packs) await ctx.runProcess("warehouse.pack.void", { id: pack.id, reason });
};

const allocatedPayload = z.looseObject({
  pickId: uuid,
  status: z.enum(["allocated", "short"]),
  short: z.array(z.looseObject({
    orderLineId: uuid, productId: uuid, qty: z.number(), available: z.number(),
    locationId: uuid.nullable().optional(), lotId: uuid.nullable().optional(), serialId: uuid.nullable().optional(),
  })).default([]),
});

export const onReservationAllocated: EventConsumer = async (ctx, payload) => {
  const answer = parse(allocatedPayload, RESERVATION_ALLOCATED, payload);
  await ctx.runProcess("warehouse.pick.record_allocation", {
    pickId: answer.pickId,
    eventId: ctx.event.id,
    status: answer.status,
    // The short bucket (ubicación, lot, serial) when inventory names it: record_allocation marks that pick line.
    short: answer.short.map((s) => ({
      orderLineId: s.orderLineId, productId: s.productId, qty: s.qty, available: s.available,
      ...(s.locationId !== undefined ? { locationId: s.locationId } : {}),
      ...(s.lotId !== undefined ? { lotId: s.lotId } : {}),
      ...(s.serialId !== undefined ? { serialId: s.serialId } : {}),
    })),
  });
};

const movementPayload = z.looseObject({ movementId: uuid, kind: z.string() });

export const onMovementPosted: EventConsumer = async (ctx, payload) => {
  const movement = parse(movementPayload, MOVEMENT_POSTED, payload);
  // A receipt is put away; a relocation may be inventory's answer to a confirmed put-away (recorded on its chain, 0174); an issue, a sale … is not.
  if (movement.kind !== "receipt" && movement.kind !== "relocation") return;
  await ctx.runProcess("warehouse.putaway.notify", { movementId: movement.movementId, eventId: ctx.event.id });
};
