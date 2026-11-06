import { ProcessError, type ProcessContext } from "@erp/kernel";

// Price resolution of a sale line (plan 2B Task 12): the customer's price list (sales.customer_terms), then the company's default price
// list (sales.settings), then the product's list price. The price lists and the product are core's: read through core's published views as
// the caller (company RLS, record-level read, field visibility: a price the caller may not see is no price), and a list is used only while
// it is usable (live, active, approved when it requires approval: kernel.record_usable). The discount is the customer's standing one; it
// does not depend on the price (resolveLineDiscount), so a line priced by hand, or one no list prices, still carries it.
// Quotes (crm), orders (Task 13) and invoices call it; it reads only published views (sales.v_*, core.v_*), so a module that calls it reads
// nothing it does not publish (rule 3).
//
// `qty` and `date` are part of the contract for quantity breaks and dated lists; core's price lists carry neither yet (one price per
// product and list), so today they only travel with the request.

export type PriceSource = "customer_list" | "default_list" | "list_price";

export interface ResolvedPrice {
  unitPrice: number;
  /** The price list the price came from; absent when it is the product's list price. */
  priceListId?: string;
  /** The customer's standing discount, percent (0 when they have none). */
  discountPct: number;
  source: PriceSource;
}

/** One candidate list: its id and the product's price in it (null when the list does not carry the product, or the price is masked). */
export interface ListCandidate {
  priceListId: string;
  price: number | null;
}

export interface PriceCandidates {
  customer?: ListCandidate | null;
  fallback?: ListCandidate | null;
  /** The product's list price (null when masked, or when the document is in another currency than the product's). */
  listPrice: number | null;
  discountPct?: number | null;
}

/** The price a line takes from its candidates, in order: the customer's list, the default list, the list price; null when none has one. */
export function choosePrice(c: PriceCandidates): ResolvedPrice | null {
  const discountPct = c.discountPct ?? 0;
  if (c.customer && c.customer.price !== null) return { unitPrice: c.customer.price, priceListId: c.customer.priceListId, discountPct, source: "customer_list" };
  if (c.fallback && c.fallback.price !== null) return { unitPrice: c.fallback.price, priceListId: c.fallback.priceListId, discountPct, source: "default_list" };
  if (c.listPrice !== null) return { unitPrice: c.listPrice, discountPct, source: "list_price" };
  return null;
}

/** The amount a percent discount takes off a line: quantity × price × percent / 100, rounded half up to the cent. */
export function lineDiscount(qty: number, unitPrice: number, discountPct: number): number {
  const raw = (qty * unitPrice * discountPct) / 100;
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

export interface PriceRequest {
  productId: string;
  partyId: string;
  qty: number;
  /** ISO date of the document. */
  date: string;
  /** The document currency; a list in another currency is skipped, and the list price applies only in the company currency. Default: the company currency. */
  currency?: string;
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** The customer's standing discount, percent, as the caller sees their terms (0 when they have none). Independent of any price. */
export async function resolveLineDiscount(ctx: ProcessContext, partyId: string): Promise<number> {
  const [terms] = await ctx.tx<{ discount_pct: string | null }[]>`select discount_pct::text from sales.v_customer_terms where party_id = ${partyId}`;
  return num(terms?.discount_pct) ?? 0;
}

/** The product's price in list `listId` when the list is usable and in `currency`, as the caller sees it. */
async function listPrice(ctx: ProcessContext, listId: string | null, productId: string, currency: string): Promise<ListCandidate | null> {
  if (!listId) return null;
  const [list] = await ctx.tx<{ currency_code: string | null; usable: boolean }[]>`
    select l.currency_code, kernel.record_usable('core.price_list', l.id) as usable from core.v_price_lists l where l.id = ${listId}`;
  if (!list || list.usable !== true || (list.currency_code ?? "").trim() !== currency) return null;
  const [item] = await ctx.tx<{ price: string | null }[]>`
    select price::text from core.v_price_list_items where price_list_id = ${listId} and product_id = ${productId}`;
  return { priceListId: listId, price: num(item?.price) };
}

/**
 * The unit price, its price list and the customer's discount for one line of `partyId` buying `productId` (see the file comment). Throws
 * `invalid_input` `price_not_found` when nothing gives a price (the product is not visible, its list price is masked, or the document is in
 * another currency and no list in that currency carries it): the caller then gives the price by hand, and takes the discount from
 * resolveLineDiscount.
 */
export async function resolveLinePrice(ctx: ProcessContext, request: PriceRequest): Promise<ResolvedPrice> {
  const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
  const companyCurrency = (company?.currency_code ?? "COP").trim();
  const currency = request.currency ?? companyCurrency;
  const [terms] = await ctx.tx<{ price_list_id: string | null }[]>`select price_list_id from sales.v_customer_terms where party_id = ${request.partyId}`;
  const [settings] = await ctx.tx<{ default_price_list_id: string | null }[]>`select default_price_list_id from sales.v_settings where company_id = ${ctx.companyId}`;
  const [product] = await ctx.tx<{ list_price: string | null }[]>`select list_price::text from core.v_products where id = ${request.productId}`;
  const customer = await listPrice(ctx, terms?.price_list_id ?? null, request.productId, currency);
  const fallback = settings?.default_price_list_id && settings.default_price_list_id !== terms?.price_list_id
    ? await listPrice(ctx, settings.default_price_list_id, request.productId, currency)
    : null;
  const chosen = choosePrice({
    customer,
    fallback,
    listPrice: product && currency === companyCurrency ? num(product.list_price) : null,
    discountPct: await resolveLineDiscount(ctx, request.partyId),
  });
  if (!chosen) {
    throw new ProcessError("invalid_input", "price_not_found: el producto no tiene precio en las listas del cliente ni precio de lista", {
      details: ["price_not_found: el producto no tiene precio en las listas del cliente ni precio de lista; indica el precio unitario"],
    });
  }
  return chosen;
}
