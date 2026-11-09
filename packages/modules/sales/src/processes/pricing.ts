import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { resolveLineDiscount, resolveLinePrice } from "../price";

// Pricing parameters of the sales module (plan 2B Task 12): the company's default price list (sales.settings) and each customer's
// commercial terms (sales.customer_terms: their price list and standing discount), plus the price resolution as a consult process (the
// line editors and the assistant ask it). The price lists are core's; they are named here by id and checked through core's published view.

const FEATURE = "sales.pricing";

const id = z.uuid();
const money = z.number().finite().min(0).refine((n) => n < 1e14, "Importe fuera de rango").refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
const percent = z.number().finite().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");

/** A refusal whose message leads with its code; `details` lists the messages. */
function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

/** Refuses a price list the caller cannot see or that is not usable (inactive, deleted, not approved when it requires approval). */
async function assertUsableList(ctx: ProcessContext, listId: string): Promise<void> {
  const [row] = await ctx.tx<{ usable: boolean }[]>`select kernel.record_usable('core.price_list', id) as usable from core.v_price_lists where id = ${listId}`;
  if (!row) refuse("invalid_price_list", ["La lista de precios no existe o no es visible"]);
  if (row.usable !== true) refuse("invalid_price_list", ["La lista de precios no está activa o no está aprobada"]);
}

export const settingsUpdate = defineProcess({
  id: "sales.settings.update",
  module: "sales",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  description:
    "Cambia los parámetros de ventas de la empresa: la lista de precios predeterminada (la que da el precio cuando el cliente no tiene lista propia o su lista no trae el producto) y el descuento máximo de un pedido sin aprobación",
  input: z.object({
    defaultPriceListId: id.nullable().optional(),
    /** A pedido with a line discount above this percent waits for approval; null: no pedido does by its discount. */
    orderApprovalDiscountPct: percent.nullable().optional(),
  }).strict(),
  output: z.object({ id: z.string(), defaultPriceListId: z.string().nullable(), orderApprovalDiscountPct: z.number().nullable() }),
  handler: async (ctx, input) => {
    if (input.defaultPriceListId) await assertUsableList(ctx, input.defaultPriceListId);
    const values = Object.fromEntries(
      Object.entries({ default_price_list_id: input.defaultPriceListId, order_approval_discount_pct: input.orderApprovalDiscountPct }).filter(([, v]) => v !== undefined),
    );
    const [current] = await ctx.tx<{ id: string }[]>`select id from sales.settings where company_id = ${ctx.companyId} for update`;
    type Row = { id: string; default_price_list_id: string | null; order_approval_discount_pct: string | null };
    const [row] = current
      ? Object.keys(values).length > 0
        ? await ctx.tx<Row[]>`update sales.settings set ${ctx.tx(values)} where id = ${current.id} returning id, default_price_list_id, order_approval_discount_pct::text`
        : await ctx.tx<Row[]>`select id, default_price_list_id, order_approval_discount_pct::text from sales.settings where id = ${current.id}`
      : await ctx.tx<Row[]>`insert into sales.settings ${ctx.tx({ company_id: ctx.companyId, ...values })} returning id, default_price_list_id, order_approval_discount_pct::text`;
    return {
      id: row!.id,
      defaultPriceListId: row!.default_price_list_id,
      orderApprovalDiscountPct: row!.order_approval_discount_pct === null ? null : Number(row!.order_approval_discount_pct),
    };
  },
});

export const settingsConsult = defineProcess({
  id: "sales.settings.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta los parámetros de ventas de la empresa (la lista de precios predeterminada)",
  input: z.object({}).strict(),
  output: z.looseObject({ configured: z.boolean() }),
  handler: async (ctx) => {
    const [row] = await ctx.tx`select * from sales.v_settings where company_id = ${ctx.companyId}`;
    return row ? { ...row, configured: true } : { configured: false, default_price_list_id: null };
  },
});

export const customerTermsSet = defineProcess({
  id: "sales.customer_terms.set",
  module: "sales",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  description:
    "Fija las condiciones comerciales de un cliente: la lista de precios con la que compra, su descuento habitual (porcentaje) y su cupo de crédito (en la moneda de la empresa; un pedido que lo supere espera aprobación)",
  input: z.object({
    partyId: id,
    priceListId: id.nullable().optional(),
    discountPct: percent.optional(),
    /** The customer's credit limit in the company currency (their confirmed pedidos may not exceed it without approval); null: none. */
    creditLimit: money.nullable().optional(),
    notes: z.string().trim().max(500).optional(),
  }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [party] = await ctx.tx<{ kind: string[] | null }[]>`select kind from core.v_party_sales where id = ${input.partyId}`;
    if (!party) refuse("invalid_party", ["El tercero no existe o no es visible"]);
    if (!(party.kind ?? []).includes("customer")) refuse("invalid_party", ["El tercero no es un cliente"]);
    if (input.priceListId) await assertUsableList(ctx, input.priceListId);
    // A key left out keeps what the customer has (a new customer: no list, no discount, no limit).
    const given = Object.fromEntries(
      Object.entries({ price_list_id: input.priceListId, discount_pct: input.discountPct, credit_limit: input.creditLimit, notes: input.notes }).filter(([, v]) => v !== undefined),
    );
    const [current] = await ctx.tx<{ id: string }[]>`select id from sales.customer_terms where party_id = ${input.partyId} for update`;
    if (current) {
      if (Object.keys(given).length > 0) await ctx.tx`update sales.customer_terms set ${ctx.tx(given)} where id = ${current.id}`;
      return { id: current.id };
    }
    const values = { price_list_id: null, discount_pct: 0, credit_limit: null, notes: null, ...given };
    const [row] = await ctx.tx<{ id: string }[]>`insert into sales.customer_terms ${ctx.tx({ company_id: ctx.companyId, party_id: input.partyId, ...values })} returning id`;
    return { id: row!.id };
  },
});

export const customerTermsConsult = defineProcess({
  id: "sales.customer_terms.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta las condiciones comerciales de un cliente (lista de precios y descuento habitual) con los campos que el rol puede ver",
  input: z.object({ partyId: id }).strict(),
  output: z.looseObject({ configured: z.boolean() }),
  handler: async (ctx, { partyId }) => {
    const [row] = await ctx.tx`select * from sales.v_customer_terms where party_id = ${partyId}`;
    return row ? { ...row, configured: true } : { configured: false, party_id: partyId, price_list_id: null, discount_pct: 0 };
  },
});

export const priceResolve = defineProcess({
  id: "sales.price.resolve",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description:
    "Da el precio unitario de un producto para un cliente: el de la lista de precios del cliente, si no el de la lista predeterminada, si no el precio de lista del producto (en otra moneda, convertido a la tasa del documento); con el descuento habitual del cliente",
  input: z.object({
    productId: id, partyId: id, qty: z.number().finite().positive(), date: z.iso.date(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    /** The document's rate (company currency per unit) in another currency: the list price converts at it (Task 34.3). */
    exchangeRate: z.number().finite().positive().optional(),
  }).strict(),
  output: z.object({
    unitPrice: z.number(), priceListId: z.string().optional(), discountPct: z.number(), source: z.enum(["customer_list", "default_list", "list_price", "converted"]),
    convertedFrom: z.object({ amount: z.number(), currency: z.string(), rate: z.number() }).optional(),
  }),
  handler: (ctx, input) => resolveLinePrice(ctx, input),
});

export const discountResolve = defineProcess({
  id: "sales.discount.resolve",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Da el descuento habitual de un cliente (porcentaje; 0 si no tiene), que se propone en cada línea aunque el precio se escriba a mano",
  input: z.object({ partyId: id }).strict(),
  output: z.object({ discountPct: z.number() }),
  handler: async (ctx, input) => ({ discountPct: await resolveLineDiscount(ctx, input.partyId) }),
});

export const PRICING_PROCESSES = [settingsUpdate, settingsConsult, customerTermsSet, customerTermsConsult, priceResolve, discountResolve];
