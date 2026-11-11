import { ProcessError, type EventConsumer } from "@erp/kernel";
import { z } from "zod";

// The alistamientos of the warehouse module (plan 2B.2 Task 29.1, PG §4.3 step 3): inventory consumes warehouse.pick.confirmed by name
// (it does not depend on warehouse; warehouse depends on inventory and never writes its tables, rule 3) and allocates the pedido lines'
// reservations as picked (inventory.reservation.allocate, origin event, as the system user). The answer goes back by
// inventory.reservation.allocated. A redelivered confirmation answers the first run (idempotent on the event id).

/** The event warehouse emits when an alistamiento is confirmed (warehouse's PICK_CONFIRMED; repeated here: inventory does not import warehouse). */
export const PICK_CONFIRMED = "warehouse.pick.confirmed";

const uuid = z.uuid();
const confirmedPayload = z.object({
  pickId: uuid,
  orderId: uuid,
  warehouseId: uuid,
  createDelivery: z.boolean(),
  lines: z.array(z.object({
    orderLineId: uuid, productId: uuid, locationId: uuid, lotId: uuid.nullable().optional(), serialId: uuid.nullable().optional(), qty: z.number().positive(),
  })),
});

export const onPickConfirmed: EventConsumer = async (ctx, payload) => {
  const parsed = confirmedPayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${PICK_CONFIRMED} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const pick = parsed.data;
  if (pick.lines.length === 0) return;
  await ctx.runProcess("inventory.reservation.allocate", {
    eventId: ctx.event.id,
    pickId: pick.pickId,
    orderId: pick.orderId,
    warehouseId: pick.warehouseId,
    createDelivery: pick.createDelivery,
    lines: pick.lines.map((l) => ({ orderLineId: l.orderLineId, productId: l.productId, locationId: l.locationId, lotId: l.lotId ?? null, serialId: l.serialId ?? null, qty: l.qty })),
  });
};
