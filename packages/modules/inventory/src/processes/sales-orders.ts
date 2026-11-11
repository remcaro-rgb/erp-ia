import { ProcessError, type EventConsumer } from "@erp/kernel";
import { z } from "zod";

// The stock of a pedido de venta (plan 2B Task 13, design §8.1 step 3: "inventory → reservation"): inventory consumes the sales module's
// events by name (it does not depend on sales; sales never calls inventory, rule 3). sales.order.confirmed reserves each line in the pedido's
// bodega (inventory.reservation.create, origin event, as the system user); sales.order.cancelled releases them. The source of every
// reservation is the pedido line (`sales.order_line`, its id), so both are idempotent on redelivery (one active reservation per line;
// releasing what is released answers it).
//
// Short stock: a line reserves what the bodega has available and the rest stays a backorder (allowPartial; a line with nothing available
// reserves nothing). The pedido is confirmed either way: confirming never fails for stock, and its delivery (Task 14) moves what there is.
// A line reserved once is never reserved again by a late redelivery of the confirmation (once), and the cancellation closes a line that has
// no reservation yet (tombstone: a released row), so whatever order the two events are consumed in, a cancelled pedido keeps nothing reserved.
// A pedido without bodega reserves nothing; a service or a product that keeps no stock is answered `not_tracked` by the process.

/** The source entity of a pedido line's reservation (sales' ORDER_LINE_SOURCE; repeated here: inventory does not import sales). */
export const ORDER_LINE_SOURCE = "sales.order_line";

const uuid = z.uuid();
const confirmedPayload = z.object({
  orderId: uuid,
  warehouseId: uuid.optional(),
  lines: z.array(z.object({ lineId: uuid, productId: uuid, qty: z.number().positive(), warehouseId: uuid.optional() })),
});
const cancelledPayload = z.object({
  orderId: uuid,
  warehouseId: uuid.optional(),
  lines: z.array(z.object({ lineId: uuid, productId: uuid.optional(), qty: z.number().positive().optional() })),
});

function parse<T extends z.ZodTypeAny>(schema: T, event: string, payload: unknown): z.output<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${event} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

export const onOrderConfirmed: EventConsumer = async (ctx, payload) => {
  const order = parse(confirmedPayload, "sales.order.confirmed", payload);
  for (const line of order.lines) {
    const warehouseId = line.warehouseId ?? order.warehouseId;
    if (!warehouseId) continue;
    await ctx.runProcess("inventory.reservation.create", {
      sourceEntity: ORDER_LINE_SOURCE,
      sourceLineId: line.lineId,
      productId: line.productId,
      warehouseId,
      qty: line.qty,
      allowPartial: true,
      once: true,
    });
  }
};

export const onOrderCancelled: EventConsumer = async (ctx, payload) => {
  const order = parse(cancelledPayload, "sales.order.cancelled", payload);
  for (const line of order.lines) {
    // tombstone: a line with no reservation yet (its confirmation not consumed, or short) is closed, so a late confirmation reserves nothing.
    const closable = order.warehouseId && line.productId && line.qty !== undefined;
    await ctx.runProcess("inventory.reservation.release", {
      sourceEntity: ORDER_LINE_SOURCE,
      sourceLineId: line.lineId,
      ...(closable ? { tombstone: true, productId: line.productId, warehouseId: order.warehouseId, qty: line.qty } : {}),
    });
  }
};
