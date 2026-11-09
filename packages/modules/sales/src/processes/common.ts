import type { LinksApi, ProcessContext, Tx } from "@erp/kernel";

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

/** How many days before a document's date a rate still answers for it (a weekend, a holiday): core.exchange_rate.for_date's lookback. */
const RATE_LOOKBACK_DAYS = 3;

/**
 * The default rate of a document in `currency` on `date` (Task 34.3, FX §2, R34-2): the company's row of Tasas de cambio for that day, else
 * the latest within the 3 days before, read through core's published view core.v_exchange_rates (rule 3; a rate the caller may not see is
 * no rate). Null when there is none: the caller refuses with exchange_rate_missing unless the user typed a rate.
 */
export async function defaultRate(tx: Tx, currency: string, date: string): Promise<number | null> {
  const [row] = await tx<{ rate: string | null }[]>`
    select rate::text from core.v_exchange_rates
    where company_id = kernel.current_company_id() and currency = ${currency} and rate is not null
      and rate_date between ${date}::date - ${RATE_LOOKBACK_DAYS}::int and ${date}::date
    order by rate_date desc limit 1`;
  return row?.rate ? Number(row.rate) : null;
}

/** The refusal's detail when a foreign-currency document has no rate (FX §2). */
export const exchangeRateMissing = (currency: string, date: string): string =>
  `No hay tasa de cambio para ${currency} el ${date}; regístrala en Tasas de cambio o escríbela en el documento`;
