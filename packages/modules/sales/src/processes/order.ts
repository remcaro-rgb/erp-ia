import { countryPack, defineProcess, ProcessError, runLifecycle, writeSnapshot, type ProcessContext, type TaxLineInput, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { orderEntity, type OrderStage } from "../entities";
import { lineDiscount, resolveLineDiscount, resolveLinePrice, type ResolvedPrice } from "../price";
import { assertSaleReady, type SaleParty, type SaleProduct } from "../readiness";
import { linkOrderToQuote, markLinksVoided } from "./common";

// Pedidos de venta (plan 2B Task 13, design §8 and §8.1 steps 1–2): a documento numbered PED- on save that never posts (the invoice posts,
// Task 16). Each line is priced like a cotización line (the customer's price list, then the default list, then the product's list price; a
// price given by hand wins) or, from an accepted cotización (sales.order.from_quote), with the cotización's own stored price, list and
// discount: what the customer accepted, never a fresh lookup. The taxes are the company's country pack's (computeTaxes, rule 5). The customer
// and every product must be invoice_ready (rule 10: assertSaleReady says why not), at create, update, approval and confirmation.
//
// Approval (requiere_aprobación, own flag): the pedido waits in Pendiente de Aprobación when
//   - credit: the customer has a credit limit (sales.customer_terms.credit_limit, company currency) and their confirmed pedidos plus this
//     one (total in the company currency) exceed it. Open receivables are not counted yet: invoicing (Task 16) will publish them, and the
//     ledger's accounting.v_open_items depends on the caller's account visibility (and sales does not depend on accounting), so it is not
//     used. The sum is read by sales.credit_exposure (migration 0084), which locks the customer's credit for the transaction so two
//     confirmations cannot both pass. Every confirm takes that lock, an approved pedido's too (its result is ignored there), so a saved
//     pedido confirming at the same time sees the approved one once it is confirmed. INTERIM (Task 13, reviewed 2026-11-05): Task 16
//     redefines the exposure as "confirmed pedidos not yet invoiced + open issued invoices", and Task 14 adds the delivery stage;
//   - discount: a line discount is above sales.settings.order_approval_discount_pct.
// Both are evaluated at every save of the lines, and the credit again at confirmation when the pedido was never approved (other pedidos may
// have been confirmed meanwhile): confirm then sends it to approval instead of confirming. An approved pedido is the approver's override.
//
// Commercial stage (beside the lifecycle status): open → confirmed → (partially_delivered → delivered, Task 14: as entregas ship; a voided
// entrega takes it back) or cancelled; a pedido with an entrega that is not voided is never cancelled. Confirm (Grabado, or Aprobado when it needed approval)
// emits sales.order.confirmed { orderId, number, opportunityId?, quoteId?, customer, warehouseId, dates, currency, totals, lines[] }: the
// inventory module's consumer reserves the stock of each line (inventory.reservation.create, origin event; sales never calls inventory) and
// the crm's marks the oportunidad won (`opportunityId` only when the pedido came from a cotización of one; absent, never null). A replay
// of confirm with the same `idempotencyKey` answers the first result. Cancel (Anular) voids the pedido and, when it was confirmed, emits
// sales.order.cancelled, whose inventory consumer releases the reservations.

const FEATURE = "sales.orders";
export const ORDER_CREATED = "sales.order.created";
export const ORDER_CONFIRMED = "sales.order.confirmed";
export const ORDER_CANCELLED = "sales.order.cancelled";
const NUMBER_PREFIX = "PED-";
/** The source entity of the reservations of a pedido line (inventory.reservations.source_entity). */
export const ORDER_LINE_SOURCE = "sales.order_line";

/** What Grabar may change of a pedido (its lines, dates and bodega change through sales.order.update). */
const ORDER_WRITABLE = ["notes", "extra", "extra_free"];
/** The lifecycle statuses whose lines may change (entity types D3: Borrador, Grabado, No aprobado). */
const EDITABLE = new Set(["draft", "saved", "rejected"]);

const id = z.uuid();
const date = z.iso.date();
const money = z.number().finite().min(0).refine((n) => n < 1e14, "Importe fuera de rango").refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
const percent = z.number().finite().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
const qty = z.number().finite().positive().refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales");
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const orderLineInput = z.object({
  productId: id,
  qty,
  /** The unit price; absent, the customer's price list, the default list or the product's list price gives it. */
  unitPrice: money.optional(),
  /** Percent off the line; absent, the customer's standing discount. */
  discountPct: percent.optional(),
  /** What the line prints besides the product's own description. */
  description: z.string().trim().min(1).max(300).optional(),
}).strict();
type LineInput = z.output<typeof orderLineInput> & { priceListId?: string | null; quoteLineId?: string };

const orderOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  stage: z.string(),
  requiresApproval: z.boolean(),
  creditExceeded: z.boolean(),
  discountExceeded: z.boolean(),
  subtotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
  confirmedAt: z.string().nullable(),
});
type OrderOutput = z.output<typeof orderOutput>;

/** A refusal whose message leads with its code; `details` lists every message. */
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}
/** Refuses a step the pedido's state does not allow: `invalid_state` whose message leads with the code. */
export function refuseState(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_state", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

interface OrderRow {
  id: string;
  number: string | null;
  status: string;
  stage: OrderStage;
  requires_approval: boolean;
  credit_exceeded: boolean;
  discount_exceeded: boolean;
  party_id: string;
  quote_id: string | null;
  opportunity_id: string | null;
  warehouse_id: string | null;
  issue_date: string;
  delivery_date: string | null;
  currency: string;
  exchange_rate: string;
  subtotal: string;
  tax_total: string;
  total: string;
  total_company: string;
  confirmed_at: string | null;
}

/** The pedido locked for the step, or `not_found` (one of another company, or hidden by a record rule, is as if it did not exist). */
async function lockOrder(ctx: ProcessContext, orderId: string): Promise<OrderRow> {
  const [row] = await ctx.tx<OrderRow[]>`
    select id, number, status, stage, requires_approval, credit_exceeded, discount_exceeded, party_id, quote_id, opportunity_id, warehouse_id,
           issue_date::text, delivery_date::text, currency, exchange_rate::text, subtotal::text, tax_total::text, total::text, total_company::text,
           to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as confirmed_at
    from sales.orders where id = ${orderId} for update`;
  if (!row) throw new ProcessError("not_found", `order ${orderId} not found`);
  return row;
}

const label = (o: Pick<OrderRow, "number" | "id">) => o.number ?? o.id;

/** The stages of a firm pedido (confirmed, then delivered in part or in full, Task 14): it no longer changes, and reserves or delivers. */
export const FIRM_STAGES: ReadonlySet<string> = new Set<OrderStage>(["confirmed", "partially_delivered", "delivered"]);

/** The company's today (its time zone) as an ISO date. */
export async function today(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ today: string }[]>`select (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today from kernel.companies where id = ${ctx.companyId}`;
  return row!.today;
}

/** A line as stored: its price, discount and the taxes of the country pack. */
interface PricedLine {
  line_no: number;
  product_id: string;
  description: string | null;
  qty: number;
  unit_price: number;
  price_list_id: string | null;
  discount_pct: number;
  discount: number;
  base: number;
  iva_rate: string | null;
  iva: number;
  inc_rate: string | null;
  inc: number;
  other_taxes: number;
  total: number;
  quote_line_id: string | null;
}

interface Priced {
  party: SaleParty;
  lines: PricedLine[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  maxDiscountPct: number;
}

/**
 * Prices, discounts and taxes `lines` for `partyId` on `issueDate` in `currency`, after the invoice-readiness gate of the customer and every
 * product. A line that brings its unit price (by hand, or copied from the accepted cotización with its list) keeps it; the others are
 * resolved. The taxes are the company's country pack's (`computeTaxes`, per-line rounding).
 */
async function priceLines(ctx: ProcessContext, partyId: string, lines: LineInput[], issueDate: string, currency: string): Promise<Priced> {
  const { party, products } = await assertSaleReady(ctx, partyId, lines.map((l) => l.productId));
  const priceErrors: string[] = [];
  const resolved: { unitPrice: number; priceListId: string | null; discountPct: number; product: SaleProduct; given: LineInput }[] = [];
  const standingDiscount = await resolveLineDiscount(ctx, partyId);
  for (const [i, line] of lines.entries()) {
    let found: ResolvedPrice | null = null;
    if (line.unitPrice === undefined) {
      try {
        found = await resolveLinePrice(ctx, { productId: line.productId, partyId, qty: line.qty, date: issueDate, currency });
      } catch (error) {
        // Only "no price" is caught (a JS refusal, the transaction is intact).
        if (!(error instanceof ProcessError) || error.code !== "invalid_input") throw error;
        priceErrors.push(`Línea ${i + 1}: ${Array.isArray(error.details) ? String(error.details[0]) : error.message}`);
        continue;
      }
    }
    resolved.push({
      unitPrice: line.unitPrice ?? found!.unitPrice,
      priceListId: found?.priceListId ?? line.priceListId ?? null,
      discountPct: line.discountPct ?? standingDiscount,
      product: products.get(line.productId)!,
      given: line,
    });
  }
  if (priceErrors.length > 0) refuse("price_not_found", priceErrors);

  const taxLines: TaxLineInput[] = resolved.map((r) => ({
    quantity: r.given.qty,
    unitPrice: r.unitPrice,
    discount: lineDiscount(r.given.qty, r.unitPrice, r.discountPct),
    kind: r.product.kind,
    ivaRate: r.product.ivaRate,
    ...(r.product.incRate ? { incRate: r.product.incRate } : {}),
    otherTaxes: r.product.otherTaxes,
    isFreeSample: r.product.isFreeSample,
    ...(r.product.referencePrice !== null ? { referencePrice: r.product.referencePrice } : {}),
  }));
  const [company] = await ctx.tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${ctx.companyId}`;
  const taxed = countryPack(company!.country_code).taxes.computeTaxes({
    lines: taxLines,
    party: { responsibilities: party.responsibilities, ...(party.personType ? { personType: party.personType } : {}) },
    date: issueDate,
  });
  const priced = resolved.map((r, i): PricedLine => {
    const t = taxed.lines[i]!;
    return {
      line_no: i + 1,
      product_id: r.product.id,
      description: r.given.description ?? null,
      qty: r.given.qty,
      unit_price: r.unitPrice,
      price_list_id: r.priceListId,
      discount_pct: r.discountPct,
      discount: taxLines[i]!.discount ?? 0,
      base: t.base,
      iva_rate: t.ivaRate === null ? null : String(r.product.ivaRate),
      iva: t.iva,
      inc_rate: t.incRate === null ? null : String(r.product.incRate),
      inc: t.inc,
      other_taxes: round2(t.otherTaxes.reduce((s, o) => s + o.amount, 0)),
      total: t.payable,
      quote_line_id: r.given.quoteLineId ?? null,
    };
  });
  return {
    party,
    lines: priced,
    subtotal: taxed.subtotal,
    discountTotal: round2(priced.reduce((s, l) => s + l.discount, 0)),
    taxTotal: taxed.taxTotal,
    total: taxed.total,
    maxDiscountPct: priced.reduce((m, l) => Math.max(m, l.discount_pct), 0),
  };
}

const totals = (p: Priced, exchangeRate: number) => ({
  subtotal: p.subtotal,
  discount_total: p.discountTotal,
  tax_total: p.taxTotal,
  total: p.total,
  total_company: round2(p.total * exchangeRate),
  max_discount_pct: p.maxDiscountPct,
});

/** The company's discount threshold for pedidos (sales.settings), or null when none is set. */
async function discountThreshold(ctx: ProcessContext): Promise<number | null> {
  const [row] = await ctx.tx<{ pct: string | null }[]>`select order_approval_discount_pct::text as pct from sales.settings where company_id = ${ctx.companyId}`;
  return row?.pct === null || row?.pct === undefined ? null : Number(row.pct);
}

/**
 * Whether a pedido of `totalCompany` (company currency) takes the customer above their credit limit: their other confirmed pedidos plus
 * this one. False when the customer has no limit. sales.credit_exposure locks the customer's credit until the transaction ends.
 */
async function overCreditLimit(ctx: ProcessContext, partyId: string, orderId: string | null, totalCompany: number): Promise<boolean> {
  // Interim exposure (confirmed pedidos only); Task 16 adds open issued invoices and leaves out invoiced pedidos.
  const [row] = await ctx.tx<{ credit_limit: string | null; exposure: string }[]>`
    select credit_limit::text, exposure::text from sales.credit_exposure(${partyId}::uuid, ${orderId}::uuid)`;
  if (!row || row.credit_limit === null) return false;
  return num(row.exposure) + totalCompany > num(row.credit_limit);
}

async function approvalOf(ctx: ProcessContext, partyId: string, orderId: string | null, priced: Priced, exchangeRate: number) {
  const threshold = await discountThreshold(ctx);
  const discountExceeded = threshold !== null && priced.maxDiscountPct > threshold;
  const creditExceeded = await overCreditLimit(ctx, partyId, orderId, round2(priced.total * exchangeRate));
  return { creditExceeded, discountExceeded, requiresApproval: creditExceeded || discountExceeded };
}

async function insertLines(ctx: ProcessContext, orderId: string, lines: PricedLine[]): Promise<void> {
  if (lines.length === 0) return;
  await ctx.tx`insert into sales.order_lines ${ctx.tx(lines.map((l) => ({ company_id: ctx.companyId, order_id: orderId, ...l })))}`;
}

/** After the pedido's lines or amounts changed: Grabar (and, when it now needs approval, Enviar a aprobación); the result's state. */
async function saveAndRoute(ctx: ProcessContext, orderId: string, from: string, requiresApproval: boolean, changed: boolean): Promise<{ status: string; number: string | null }> {
  const entity = ctx.registry.entity(orderEntity.id);
  const saved = await runLifecycle(ctx, entity, orderId, "save");
  // Grabado → Grabado writes no snapshot of its own; the process changed the lines, so the version is kept here (spec §8).
  if (changed && from === saved.status && from !== "draft") await writeSnapshot(ctx, entity, orderId, saved.status, null);
  let status: string = saved.status;
  if (requiresApproval && status === "saved") status = (await runLifecycle(ctx, entity, orderId, "submit")).status;
  const [row] = await ctx.tx<{ number: string | null }[]>`select number from sales.orders where id = ${orderId}`;
  return { status, number: row?.number ?? null };
}

/** The pedido as the processes answer it, read after the step. */
async function outputOf(ctx: ProcessContext, orderId: string): Promise<OrderOutput> {
  const row = await lockOrder(ctx, orderId);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    stage: row.stage,
    requiresApproval: row.requires_approval,
    creditExceeded: row.credit_exceeded,
    discountExceeded: row.discount_exceeded,
    subtotal: num(row.subtotal),
    taxTotal: num(row.tax_total),
    total: num(row.total),
    confirmedAt: row.confirmed_at,
  };
}

/** Refuses a bodega that is not there, not visible or not usable (inventory's published view of its bodegas, read only). */
export async function assertWarehouse(ctx: ProcessContext, warehouseId: string): Promise<void> {
  const [row] = await ctx.tx<{ usable: boolean }[]>`select kernel.record_usable('inventory.warehouse', id) as usable from inventory.v_warehouses where id = ${warehouseId}`;
  if (!row) refuse("invalid_warehouse", ["La bodega no existe o no es visible"]);
  if (row.usable !== true) refuse("invalid_warehouse", ["La bodega no está activa"]);
}

/**
 * Runs the pedido's insert; a concurrent conversion of the same cotización that committed first (the unique index orders_one_per_quote,
 * 0084) is refused as quote_already_ordered, like the check before it.
 */
async function oneLivePerQuote<T>(quoteId: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string };
    if (quoteId && pg.code === "23505" && pg.constraint_name === "orders_one_per_quote") {
      throw new ProcessError("invalid_state", "quote_already_ordered: La cotización ya tiene un pedido", { details: ["La cotización ya tiene un pedido"], cause: error });
    }
    throw error;
  }
}

interface NewOrder {
  partyId: string;
  issueDate?: string;
  deliveryDate?: string;
  warehouseId?: string;
  currency?: string;
  exchangeRate?: number;
  notes?: string;
  quoteId?: string;
  opportunityId?: string | null;
  lines: LineInput[];
}

/** Writes a new pedido (header, priced lines), Grabar and, when it needs it, Enviar a aprobación; emits sales.order.created. */
async function createOrder(ctx: ProcessContext, input: NewOrder): Promise<OrderOutput> {
  const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
  const companyCurrency = company!.currency_code.trim();
  const currency = input.currency ?? companyCurrency;
  if (currency !== companyCurrency && input.exchangeRate === undefined) refuse("exchange_rate_required", [`Indica la tasa de cambio de ${currency} a ${companyCurrency}`]);
  const exchangeRate = currency === companyCurrency ? 1 : input.exchangeRate!;
  if (input.warehouseId) await assertWarehouse(ctx, input.warehouseId);
  const issueDate = input.issueDate ?? (await today(ctx));
  if (input.deliveryDate && input.deliveryDate < issueDate) refuse("invalid_delivery_date", ["La fecha de entrega es anterior a la del pedido"]);

  const priced = await priceLines(ctx, input.partyId, input.lines, issueDate, currency);
  const approval = await approvalOf(ctx, input.partyId, null, priced, exchangeRate);
  const [header] = await oneLivePerQuote(input.quoteId, () => ctx.tx<{ id: string }[]>`
    insert into sales.orders ${ctx.tx({
      company_id: ctx.companyId,
      party_id: input.partyId,
      quote_id: input.quoteId ?? null,
      opportunity_id: input.opportunityId ?? null,
      owner_id: ctx.userId,
      warehouse_id: input.warehouseId ?? null,
      issue_date: issueDate,
      delivery_date: input.deliveryDate ?? null,
      stage: "open",
      currency,
      exchange_rate: exchangeRate,
      notes: input.notes ?? null,
      ...totals(priced, exchangeRate),
      credit_exceeded: approval.creditExceeded,
      discount_exceeded: approval.discountExceeded,
      // The pedido sets its own flags (ownFlags): approval by credit limit or discount threshold, never posted.
      requires_approval: approval.requiresApproval,
      posts: false,
    })}
    returning id`);
  await insertLines(ctx, header!.id, priced.lines);
  // quote_to_order, in this transaction (Task 31): the cotización this pedido came from.
  await linkOrderToQuote(ctx, header!.id, input.quoteId);
  const state = await saveAndRoute(ctx, header!.id, "draft", approval.requiresApproval, false);
  await ctx.emit(ORDER_CREATED, {
    orderId: header!.id,
    number: state.number,
    partyId: input.partyId,
    ...(input.quoteId ? { quoteId: input.quoteId } : {}),
    ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
  });
  return outputOf(ctx, header!.id);
}

const headerInput = {
  partyId: id,
  /** Default: today in the company's time zone. */
  issueDate: date.optional(),
  /** When the customer expects the goods. */
  deliveryDate: date.optional(),
  /** The bodega whose stock the pedido reserves (inventory's); without one nothing is reserved. */
  warehouseId: id.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Moneda ISO 4217 de tres letras").optional(),
  exchangeRate: z.number().finite().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
};

export const orderCreate = defineProcess({
  id: "sales.order.create",
  module: "sales",
  kind: "create",
  feature: FEATURE,
  emits: [ORDER_CREATED],
  description:
    "Crea un pedido de venta para un cliente listo para facturar: precia cada línea con la lista de precios del cliente (o la predeterminada, o el precio de lista), calcula impuestos y totales, le asigna su número y lo deja en aprobación si supera el cupo de crédito del cliente o un descuento supera el tope",
  input: z.object({ ...headerInput, lines: z.array(orderLineInput).min(1, "El pedido lleva al menos una línea").max(200) }).strict(),
  output: orderOutput,
  handler: (ctx, input) => createOrder(ctx, input),
});

/** A cotización as crm publishes it for its pedido (crm.v_quote_offers, migration 0084). */
interface QuoteOffer {
  id: string;
  number: string | null;
  party_id: string;
  opportunity_id: string | null;
  stage: string;
  status: string;
  currency: string;
  exchange_rate: string;
  notes: string | null;
}

export const orderFromQuote = defineProcess({
  id: "sales.order.from_quote",
  module: "sales",
  kind: "create",
  // A new pedido: no existing record is changed (the cotización is read under its own visibility, never written).
  recordAccess: "none",
  feature: FEATURE,
  emits: [ORDER_CREATED],
  description:
    "Convierte una cotización aceptada en un pedido de venta: copia sus líneas con los precios, listas y descuentos que el cliente aceptó (no vuelve a buscar precios), su moneda y su oportunidad; una cotización da un solo pedido",
  input: z.object({
    quoteId: id,
    issueDate: date.optional(),
    deliveryDate: date.optional(),
    warehouseId: id.optional(),
    notes: z.string().trim().max(2000).optional(),
  }).strict(),
  output: orderOutput,
  handler: async (ctx, input) => {
    const [quote] = await ctx.tx<QuoteOffer[]>`
      select id, number, party_id, opportunity_id, stage, status, currency, exchange_rate::text, notes from crm.v_quote_offers where id = ${input.quoteId}`;
    if (!quote) throw new ProcessError("not_found", `quote ${input.quoteId} not found`);
    const quoteLabel = quote.number ?? quote.id;
    if (quote.status === "voided") refuseState("quote_voided", [`La cotización ${quoteLabel} está anulada`]);
    if (quote.stage !== "accepted") refuseState("quote_not_accepted", [`La cotización ${quoteLabel} no ha sido aceptada por el cliente`]);
    const [taken] = await ctx.tx<{ number: string | null }[]>`
      select number from sales.orders where quote_id = ${quote.id} and stage <> 'cancelled' and status <> 'voided' limit 1`;
    if (taken) refuseState("quote_already_ordered", [`La cotización ${quoteLabel} ya tiene el pedido ${taken.number ?? ""}`.trim()]);
    const lines = await ctx.tx<{ id: string; product_id: string; description: string | null; qty: string; unit_price: string; price_list_id: string | null; discount_pct: string }[]>`
      select id, product_id, description, qty::text, unit_price::text, price_list_id, discount_pct::text from crm.v_quote_offer_lines where quote_id = ${quote.id} order by line_no`;
    if (lines.length === 0) refuse("invalid_quote", [`La cotización ${quoteLabel} no tiene líneas`]);
    return createOrder(ctx, {
      partyId: quote.party_id,
      ...(input.issueDate ? { issueDate: input.issueDate } : {}),
      ...(input.deliveryDate ? { deliveryDate: input.deliveryDate } : {}),
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      currency: quote.currency,
      exchangeRate: num(quote.exchange_rate),
      notes: input.notes ?? quote.notes ?? undefined,
      quoteId: quote.id,
      opportunityId: quote.opportunity_id,
      lines: lines.map((l) => ({
        productId: l.product_id,
        qty: num(l.qty),
        unitPrice: num(l.unit_price),
        discountPct: num(l.discount_pct),
        priceListId: l.price_list_id,
        quoteLineId: l.id,
        ...(l.description ? { description: l.description } : {}),
      })),
    });
  },
});

/** Refuses changing or confirming a pedido past its open stage. */
function assertOpen(order: OrderRow): void {
  if (FIRM_STAGES.has(order.stage)) refuseState("order_confirmed", [`El pedido ${label(order)} ya está confirmado`]);
  if (order.stage === "cancelled" || order.status === "voided") refuseState("order_cancelled", [`El pedido ${label(order)} está cancelado`]);
}

export const orderUpdate = defineProcess({
  id: "sales.order.update",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  description:
    "Cambia las líneas, la fecha de entrega, la bodega o las notas de un pedido abierto (Grabado o No aprobado): vuelve a preciar, recalcula impuestos y totales y lo manda a aprobación si supera el cupo de crédito o un descuento supera el tope",
  input: z.object({
    id,
    lines: z.array(orderLineInput).min(1).max(200).optional(),
    deliveryDate: date.nullable().optional(),
    warehouseId: id.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  }).strict(),
  output: orderOutput,
  handler: async (ctx, input) => {
    const order = await lockOrder(ctx, input.id);
    assertOpen(order);
    if (!EDITABLE.has(order.status)) refuseState("order_not_editable", [`El pedido ${label(order)} está en aprobación o aprobado: no cambia`]);
    if (input.warehouseId) await assertWarehouse(ctx, input.warehouseId);
    if (input.deliveryDate && input.deliveryDate < order.issue_date) refuse("invalid_delivery_date", ["La fecha de entrega es anterior a la del pedido"]);
    const set: Record<string, unknown> = Object.fromEntries(
      Object.entries({ delivery_date: input.deliveryDate, warehouse_id: input.warehouseId, notes: input.notes }).filter(([, v]) => v !== undefined),
    );
    let requiresApproval = order.requires_approval;
    if (input.lines) {
      const fresh = await priceLines(ctx, order.party_id, input.lines, order.issue_date, order.currency);
      const approval = await approvalOf(ctx, order.party_id, order.id, fresh, num(order.exchange_rate));
      requiresApproval = approval.requiresApproval;
      Object.assign(set, totals(fresh, num(order.exchange_rate)), {
        requires_approval: approval.requiresApproval,
        credit_exceeded: approval.creditExceeded,
        discount_exceeded: approval.discountExceeded,
      });
      await ctx.tx`delete from sales.order_lines where order_id = ${order.id}`;
      await insertLines(ctx, order.id, fresh.lines);
    }
    if (Object.keys(set).length > 0) await ctx.tx`update sales.orders set ${ctx.tx(set)} where id = ${order.id}`;
    await saveAndRoute(ctx, order.id, order.status, requiresApproval, Object.keys(set).length > 0);
    return outputOf(ctx, order.id);
  },
});

/** Keeps the version of a pedido whose stage changed (spec §8: every change past Borrador). */
async function snapshot(ctx: ProcessContext, orderId: string, status: string): Promise<void> {
  await writeSnapshot(ctx, ctx.registry.entity(orderEntity.id), orderId, status as never, null);
}

export const orderConfirm = defineProcess({
  id: "sales.order.confirm",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  emits: [ORDER_CONFIRMED],
  description:
    "Confirma un pedido grabado (o aprobado, si lo necesitaba): queda en firme y se reservan sus existencias en la bodega; si el cliente quedaría por encima de su cupo de crédito, el pedido pasa a aprobación en lugar de confirmarse",
  input: z.object({
    id,
    /** One per confirmation the user asks for (a form submit): a retry with the same key answers the first result. */
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  output: orderOutput,
  auditInput: (input) => ({ id: input.id }),
  idempotencyKey: (input) => (input.idempotencyKey ? `confirm:${input.id}:${input.idempotencyKey}` : undefined),
  handler: async (ctx, { id: orderId, idempotencyKey }) => {
    const order = await lockOrder(ctx, orderId);
    // A run with the same key that confirmed while this one waited for the pedido's lock: answer its stored result (the kernel stores it in
    // the run's transaction, so it is visible once that run committed and released the lock).
    if (FIRM_STAGES.has(order.stage) && idempotencyKey) {
      const [stored] = await ctx.tx<{ result: OrderOutput }[]>`
        select result from kernel.process_idempotency where company_id = ${ctx.companyId} and process_id = 'sales.order.confirm' and key = ${`confirm:${orderId}:${idempotencyKey}`}`;
      if (stored) return stored.result;
    }
    assertOpen(order);
    if (order.status === "pending") refuseState("order_pending_approval", [`El pedido ${label(order)} espera aprobación: se confirma una vez aprobado`]);
    if (order.status === "rejected") refuseState("order_rejected", [`El pedido ${label(order)} no fue aprobado: corrígelo y grábalo de nuevo`]);
    if (order.requires_approval && order.status !== "approved") refuseState("order_pending_approval", [`El pedido ${label(order)} necesita aprobación`]);
    if (order.status !== "saved" && order.status !== "approved") refuseState("order_not_saved", [`El pedido ${label(order)} no está grabado`]);

    const lines = await ctx.tx<{ id: string; line_no: number; product_id: string; description: string | null; qty: string; unit_price: string; discount_pct: string; base: string; total: string }[]>`
      select id, line_no, product_id, description, qty::text, unit_price::text, discount_pct::text, base::text, total::text
      from sales.order_lines where order_id = ${orderId} order by line_no`;
    // Rule 10 holds at confirmation too: a customer or product that stopped being invoice_ready since the pedido was written is refused.
    const { party } = await assertSaleReady(ctx, order.party_id, lines.map((l) => l.product_id));

    // Every confirm takes the customer's credit lock (inside sales.credit_exposure). Never approved: the credit is checked again (pedidos
    // confirmed since it was saved count); over the limit, it goes to approval instead. Approved: the result is ignored (the override), but
    // the lock still serializes it with the customer's other confirmations.
    const over = await overCreditLimit(ctx, order.party_id, order.id, num(order.total_company));
    if (order.status === "saved" && over) {
      await ctx.tx`update sales.orders set requires_approval = true, credit_exceeded = true where id = ${orderId}`;
      await runLifecycle(ctx, ctx.registry.entity(orderEntity.id), orderId, "submit");
      return outputOf(ctx, orderId);
    }

    const [confirmed] = await ctx.tx<{ at: string }[]>`
      update sales.orders set stage = 'confirmed', confirmed_at = now() where id = ${orderId}
      returning to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`;
    await snapshot(ctx, orderId, order.status);
    await ctx.emit(ORDER_CONFIRMED, {
      orderId,
      number: order.number,
      ...(order.opportunity_id ? { opportunityId: order.opportunity_id } : {}),
      ...(order.quote_id ? { quoteId: order.quote_id } : {}),
      customer: { partyId: order.party_id, name: party.name },
      ...(order.warehouse_id ? { warehouseId: order.warehouse_id } : {}),
      dates: { issueDate: order.issue_date, deliveryDate: order.delivery_date, confirmedAt: confirmed!.at },
      currency: order.currency,
      exchangeRate: num(order.exchange_rate),
      subtotal: num(order.subtotal),
      taxTotal: num(order.tax_total),
      total: num(order.total),
      totalCompany: num(order.total_company),
      lines: lines.map((l) => ({
        lineId: l.id,
        lineNo: l.line_no,
        productId: l.product_id,
        description: l.description,
        qty: num(l.qty),
        unitPrice: num(l.unit_price),
        discountPct: num(l.discount_pct),
        base: num(l.base),
        total: num(l.total),
        ...(order.warehouse_id ? { warehouseId: order.warehouse_id } : {}),
      })),
    });
    return outputOf(ctx, orderId);
  },
});

const cancelInput = z.object({
  id,
  reason: z.string().trim().min(1, "Indica por qué se cancela el pedido").max(500),
  /** The `updated_at` the caller read (the record frame's Anular): a pedido changed since then is refused. */
  expectedUpdatedAt: z.string().optional(),
}).strict();

/** Cancels (voids) a pedido; when it was confirmed, emits sales.order.cancelled so its reservations are released. */
async function cancelOrder(ctx: ProcessContext, input: z.output<typeof cancelInput>): Promise<OrderOutput> {
  const order = await lockOrder(ctx, input.id);
  if (order.stage === "cancelled" || order.status === "voided") refuseState("order_cancelled", [`El pedido ${label(order)} ya está cancelado`]);
  // Task 14 (ruling): a pedido with any entrega that is not voided is not cancelled, not even its remainder: the entrega is voided first
  // (which gives its stock back), or the remainder simply stays undelivered.
  const [delivery] = await ctx.tx<{ number: string | null; stage: string }[]>`
    select number, stage from sales.deliveries where order_id = ${order.id} and status <> 'voided' order by (stage = 'shipped') desc, seq limit 1`;
  if (delivery) {
    refuseState(delivery.stage === "shipped" ? "order_delivered" : "order_has_deliveries", [
      delivery.stage === "shipped"
        ? `El pedido ${label(order)} ya tiene la entrega ${delivery.number ?? "sin número"} despachada: no se cancela (anula la entrega primero)`
        : `El pedido ${label(order)} tiene la entrega ${delivery.number ?? "sin número"} en curso: anúlala antes de cancelar el pedido`,
    ]);
  }
  // Task 16 fix round 1: a pedido an issued invoice bills (on_order_confirmation invoices before any entrega) is never cancelled. Asked of
  // invoicing's published invoicing.order_invoiced under the pedido's lock, which «Emitir» also takes (FOR SHARE, sales.lock_orders_for_invoice):
  // a cancel waits for an «Emitir» in flight and then sees its invoice.
  const [billed] = await ctx.tx<{ invoiced: boolean }[]>`select invoicing.order_invoiced(${order.id}::uuid) as invoiced`;
  if (billed?.invoiced) refuseState("order_invoiced", [`El pedido ${label(order)} ya está facturado: anula primero la factura (nota crédito)`]);
  await runLifecycle(ctx, ctx.registry.entity(orderEntity.id), order.id, "void", { reason: input.reason, ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}) });
  await ctx.tx`update sales.orders set stage = 'cancelled', cancelled_at = now() where id = ${order.id}`;
  // The void keeps its links, marked (Task 31): a cotización ordered again shows the cancelled pedido and the new one.
  await markLinksVoided(ctx, "sales.order", order.id, input.reason);
  if (FIRM_STAGES.has(order.stage)) {
    const lines = await ctx.tx<{ id: string; line_no: number; product_id: string; qty: string }[]>`
      select id, line_no, product_id, qty::text from sales.order_lines where order_id = ${order.id} order by line_no`;
    await ctx.emit(ORDER_CANCELLED, {
      orderId: order.id,
      number: order.number,
      ...(order.opportunity_id ? { opportunityId: order.opportunity_id } : {}),
      reason: input.reason,
      ...(order.warehouse_id ? { warehouseId: order.warehouse_id } : {}),
      lines: lines.map((l) => ({ lineId: l.id, lineNo: l.line_no, productId: l.product_id, qty: num(l.qty) })),
    });
  }
  return outputOf(ctx, order.id);
}

export const orderCancel = defineProcess({
  id: "sales.order.cancel",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  recordAccess: { entity: "sales.order", idField: "id", right: "void" },
  emits: [ORDER_CANCELLED],
  description: "Cancela un pedido de venta (lo anula con su motivo); si estaba confirmado, se liberan las existencias que tenía reservadas",
  input: cancelInput,
  output: orderOutput,
  handler: cancelOrder,
});

// Anular of the record frame is the same step: the kernel's generic void would leave the reservations of a confirmed pedido in place.
export const orderVoid = defineProcess({
  id: "sales.order.void",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  emits: [ORDER_CANCELLED],
  description: "Anula un pedido de venta con su motivo (es cancelarlo): si estaba confirmado, se liberan las existencias que tenía reservadas",
  input: cancelInput,
  output: orderOutput,
  handler: cancelOrder,
});

export const orderConsult = defineProcess({
  id: "sales.order.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un pedido de venta con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: orderId }) => {
    const [row] = await ctx.tx`select * from sales.v_orders where id = ${orderId}`;
    if (!row) throw new ProcessError("not_found", `order ${orderId} not found`);
    return { ...row, id: orderId };
  },
});

export const orderLineConsult = defineProcess({
  id: "sales.order_line.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de pedido de venta con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from sales.v_order_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `order line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The hooks of a pedido: Grabar changes only its notes and extra data, and only while it is open (its lines, dates and bodega change through
 * sales.order.update); Aprobar checks the customer and the products are still invoice_ready; the number is drawn on save from the company
 * counter (prefix PED-).
 */
export const orderHooks: TypedHooks = {
  async validate(ctx, record, mode, { previous, data }) {
    if (mode === "approve") {
      const lines = await ctx.tx<{ product_id: string }[]>`select product_id from sales.order_lines where order_id = ${record.id} order by line_no`;
      await assertSaleReady(ctx, String(record.party_id), lines.map((l) => l.product_id));
      return;
    }
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data).filter((name) => !ORDER_WRITABLE.includes(name));
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for sales.order.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    if (previous.stage !== "open" && Object.values(data).some((v) => v !== undefined)) {
      refuseState(FIRM_STAGES.has(String(previous.stage)) ? "order_confirmed" : "order_cancelled", ["Un pedido confirmado o cancelado no cambia"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select sales.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

export const ORDER_PROCESSES = [orderCreate, orderFromQuote, orderUpdate, orderConfirm, orderCancel, orderVoid, orderConsult, orderLineConsult];
