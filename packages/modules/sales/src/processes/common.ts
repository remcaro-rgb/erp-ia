import type { LinksApi, ProcessContext } from "@erp/kernel";

// The document links sales writes (design §22.27, plan 2B Task 31): through ctx.links only (rule 1), in the transaction of the document
// write, as the process that writes the document (the kernel's definer functions refuse anything else). Kinds: quote_to_order (a pedido
// from a cotización) and order_to_delivery (an entrega of a pedido). Voiding or cancelling a document marks every link it has.

const ORDER = "sales.order";
const DELIVERY = "sales.delivery";

function linksOf(ctx: ProcessContext): LinksApi {
  if (!ctx.links) throw new Error("ctx.links is not available: the kernel builds it for every run");
  return ctx.links;
}

/** The pedido's upstream: its cotización (crm's), when it came from one. Call after the pedido row exists. */
export async function linkOrderToQuote(ctx: ProcessContext, orderId: string, quoteId: string | null | undefined): Promise<void> {
  if (!quoteId) return;
  await linksOf(ctx).sync({ to: { entity: ORDER, id: orderId }, kind: "quote_to_order", from: [{ entity: "crm.quote", id: quoteId }] });
}

/** The entrega's upstream: its pedido. Call after the entrega row exists. */
export async function linkDeliveryToOrder(ctx: ProcessContext, deliveryId: string, orderId: string): Promise<void> {
  await linksOf(ctx).sync({ to: { entity: DELIVERY, id: deliveryId }, kind: "order_to_delivery", from: [{ entity: ORDER, id: orderId }] });
}

/** A pedido or an entrega was voided or cancelled: every link touching it is marked (kept, never deleted). */
export async function markLinksVoided(ctx: ProcessContext, entity: "sales.order" | "sales.delivery", id: string, reason: string): Promise<void> {
  await linksOf(ctx).markVoided({ entity, id, reason: reason.slice(0, 500) });
}
