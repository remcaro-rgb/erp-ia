import { countryPack, ProcessError, type EInvoicePack, type LinksApi, type ProcessContext, type TaxedDocument, type TaxLineInput, type Tx } from "@erp/kernel";
import { z } from "zod";
import type { InvoiceCreation } from "../entities";
import { refuse, type InvoiceParty, type InvoiceProduct } from "../readiness";

// What the invoicing processes share: the settings, the pricing of the lines through the company's country pack (computeTaxes, rule 5),
// the writing of the lines and taxes of a Borrador, and the checks of what an invoice bills of the sales chain (pedido and entrega lines,
// read only through sales' published views, rule 3) under the locks «Emitir» takes.

export { refuse };
export const FEATURE_INVOICES = "invoicing.invoices";
export const FEATURE_SETTINGS = "invoicing.settings";
export { DOCUMENT_ENVIRONMENT_MISSING } from "../document-environment";
export const INVOICE_CREATED = "invoicing.invoice.created";
export const INVOICE_ISSUED = "invoicing.invoice.issued";

/**
 * The Parámetros of invoicing are the company admin's only (Task 19 fix round 2): whatever the role matrix grants, the process refuses
 * any other caller, so the page, a direct server action, the API and the assistant are all covered.
 */
export async function requireCompanyAdmin(ctx: ProcessContext, message: string): Promise<void> {
  const [who] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
  if (!who?.admin) throw new ProcessError("forbidden", message);
}

/** Refuses a step the invoice's state does not allow: `invalid_state` whose message leads with the code. */
export function refuseState(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_state", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

export const id = z.uuid();
export const date = z.iso.date();
export const money = z.number().finite().min(0).refine((n) => n < 1e14, "Importe fuera de rango").refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
export const percent = z.number().finite().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
export const qty = z.number().finite().positive().refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales");
export const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const qtyText = (n: number) => String(round4(n)).replace(".", ",");

/** The company's today (its time zone) as an ISO date. */
export async function today(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ today: string }[]>`select (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today from kernel.companies where id = ${ctx.companyId}`;
  return row!.today;
}

export interface Settings { invoiceCreation: InvoiceCreation; dianEnvironment: "habilitacion" | "produccion"; defaultCostCenterId: string | null; creditDays: number; dianItemInstance: boolean }

/** Parámetros de facturación of the company (a company without a row: manual, habilitación, no cost center, 30 days, no lots in the XML). */
export async function settingsOf(ctx: ProcessContext): Promise<Settings> {
  const [row] = await ctx.tx<{ invoice_creation: InvoiceCreation; dian_environment: Settings["dianEnvironment"]; default_cost_center_id: string | null; credit_days: number; dian_item_instance: boolean }[]>`
    select invoice_creation, dian_environment, default_cost_center_id, credit_days, dian_item_instance from invoicing.settings where company_id = ${ctx.companyId}`;
  return {
    invoiceCreation: row?.invoice_creation ?? "manual",
    dianEnvironment: row?.dian_environment ?? "habilitacion",
    defaultCostCenterId: row?.default_cost_center_id ?? null,
    creditDays: row?.credit_days ?? 30,
    dianItemInstance: row?.dian_item_instance ?? false,
  };
}

/** The company's country pack, with its electronic-invoicing entry (server-only; fail closed when the server did not register it). */
export async function packOf(ctx: ProcessContext): Promise<{ taxes: ReturnType<typeof countryPack>["taxes"]; einvoice: EInvoicePack; countryCode: string }> {
  const [company] = await ctx.tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${ctx.companyId}`;
  const pack = countryPack(company!.country_code);
  if (!pack.einvoice) throw new ProcessError("invalid_state", "einvoice_not_available: El paquete del país no tiene facturación electrónica registrada", { details: ["El paquete del país no tiene facturación electrónica registrada"] });
  return { taxes: pack.taxes, einvoice: pack.einvoice, countryCode: company!.country_code };
}

/** An export: the buyer is of another country than the company's (InvoiceTypeCode 02, frozen at «Emitir» as `is_export`; a buyer without a country is domestic). */
export const isExportFor = (party: Pick<InvoiceParty, "countryCode">, companyCountry: string): boolean => (party.countryCode ?? companyCountry) !== companyCountry;

/** Percent off the line, as an amount rounded half-up to cents (the same rule as the sales documents). */
export function lineDiscount(lineQty: number, unitPrice: number, discountPct: number): number {
  const raw = (lineQty * unitPrice * discountPct) / 100;
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

/** A line of an invoice before pricing: what it sells and, from a sale, the pedido and entrega lines it bills. */
export interface DraftLine {
  productId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  description: string | null;
  orderId?: string | null;
  orderLineId?: string | null;
  deliveryId?: string | null;
  deliveryLineId?: string | null;
}

/** A line as stored. */
export interface PricedLine {
  line_no: number;
  product_id: string;
  description: string | null;
  qty: number;
  unit_price: number;
  discount_pct: number;
  discount: number;
  base: number;
  iva_rate: string | null;
  iva: number;
  inc_rate: string | null;
  inc: number;
  other_taxes: number;
  total: number;
  free_sample: boolean;
  category_id: string | null;
  order_id: string | null;
  order_line_id: string | null;
  delivery_id: string | null;
  delivery_line_id: string | null;
}

export interface PricedTax { family: "IVA" | "INC" | "OTHER"; code: string; ledger_code: string; rate: number | null; base: number; amount: number }

export interface Priced {
  lines: PricedLine[];
  taxes: PricedTax[];
  taxed: TaxedDocument;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
}

/** Taxes `lines` for `party` on `date` with the company's country pack (per-line rounding); every tax carries the ledger's code. */
export async function priceLines(ctx: ProcessContext, party: InvoiceParty, products: Map<string, InvoiceProduct>, lines: DraftLine[], on: string): Promise<Priced> {
  const { taxes, countryCode } = await packOf(ctx);
  const taxLines: TaxLineInput[] = lines.map((l) => {
    const p = products.get(l.productId)!;
    return {
      quantity: l.qty,
      unitPrice: l.unitPrice,
      discount: lineDiscount(l.qty, l.unitPrice, l.discountPct),
      kind: p.kind,
      ivaRate: p.ivaRate,
      ...(p.incRate ? { incRate: p.incRate } : {}),
      otherTaxes: p.otherTaxes,
      isFreeSample: p.isFreeSample,
      ...(p.referencePrice !== null ? { referencePrice: p.referencePrice } : {}),
    };
  });
  const taxed = taxes.computeTaxes({
    lines: taxLines,
    party: { responsibilities: party.responsibilities, ...(party.personType ? { personType: party.personType } : {}) },
    date: on,
    // The pack's export exemption (owner item 134): a good sold abroad is IVA 0 % exento from the Borrador on.
    export: isExportFor(party, countryCode),
  });
  const priced = lines.map((l, i): PricedLine => {
    const t = taxed.lines[i]!;
    const p = products.get(l.productId)!;
    return {
      line_no: i + 1,
      product_id: l.productId,
      description: l.description,
      qty: l.qty,
      unit_price: l.unitPrice,
      discount_pct: l.discountPct,
      discount: taxLines[i]!.discount ?? 0,
      base: t.base,
      // The rate the pack applied (an export turns 5 % into 0 %), not the product's.
      iva_rate: t.ivaRate === null ? null : String(t.ivaRate),
      iva: t.iva,
      inc_rate: t.incRate === null ? null : String(p.incRate),
      inc: t.inc,
      other_taxes: round2(t.otherTaxes.reduce((s, o) => s + o.amount, 0)),
      total: t.payable,
      free_sample: t.freeSample,
      category_id: p.categoryId,
      order_id: l.orderId ?? null,
      order_line_id: l.orderLineId ?? null,
      delivery_id: l.deliveryId ?? null,
      delivery_line_id: l.deliveryLineId ?? null,
    };
  });
  const ledgerCode = taxes.ledgerTaxCode ?? ((t: TaxedDocument["taxes"][number]) => t.code);
  return {
    lines: priced,
    taxes: taxed.taxes.map((t) => ({ family: t.family, code: t.code, ledger_code: ledgerCode(t), rate: t.rate, base: t.base, amount: t.amount })),
    taxed,
    subtotal: taxed.subtotal,
    discountTotal: round2(priced.reduce((s, l) => s + l.discount, 0)),
    taxTotal: taxed.taxTotal,
    total: taxed.total,
  };
}

/**
 * `amount` (document currency) × `rate` in the company currency, half-up to the cent on the exact decimal product (FX §4): the value
 * migration 0148's `round(amount * exchange_rate, 2)` gives, never one cent off by binary noise (`12,37 × 4.123,45`).
 */
export function toCompany(amount: number, rate: number): number {
  const exact = Number((amount * rate).toFixed(8));
  const sign = exact < 0 ? -1 : 1;
  return (sign * Math.round(Number(`${Math.abs(exact)}e2`))) / 100 || 0;
}

/**
 * The invoice's (or note's) amounts in the company currency, the ledger's ONE rounding rule (fix round 1; Task 34.4, FX §4): each revenue
 * line (its base, free samples aside) and each tax converted and rounded to the cent; the receivable is their sum, so the entry balances and
 * total_company is exactly what the ledger owes (sales' credit exposure and the open invoices read it). A line or tax that already stores
 * its company amount (`subtotal_company`, `amount_company`, written at «Emitir», rule 8) is read as stored. Beside each company amount, its
 * document amount (`*Doc`, R34-4): the same parts in the document's currency, whose sum is `totalDoc`.
 */
export function companyAmounts<
  L extends { base: number | string; free_sample: boolean; subtotal_company?: number | string | null },
  T extends { amount: number | string; base: number | string; amount_company?: number | string | null },
>(lines: L[], taxes: T[], rate: number) {
  const stored = (value: number | string | null | undefined, amount: number) => (value === undefined || value === null ? toCompany(amount, rate) : num(value));
  const revenue = lines.filter((l) => !l.free_sample && num(l.base) > 0)
    .map((l) => ({ line: l, subtotal: stored(l.subtotal_company, num(l.base)), subtotalDoc: round2(num(l.base)) }));
  const taxLines = taxes.filter((t) => num(t.amount) > 0)
    .map((t) => ({ tax: t, amount: stored(t.amount_company, num(t.amount)), amountDoc: round2(num(t.amount)), base: toCompany(num(t.base), rate) }));
  const total = round2(revenue.reduce((s, l) => s + l.subtotal, 0) + taxLines.reduce((s, t) => s + t.amount, 0));
  const totalDoc = round2(revenue.reduce((s, l) => s + l.subtotalDoc, 0) + taxLines.reduce((s, t) => s + t.amountDoc, 0));
  return { revenue, taxLines, total, totalDoc };
}

/** The company amount each line and tax stores (Task 34.4, 0148): its document amount at the document's rate, per line half-up. */
export function withCompanyAmounts<L extends { base: number }, T extends { amount: number }>(lines: L[], taxes: T[], rate: number) {
  return {
    lines: lines.map((l) => ({ ...l, subtotal_company: toCompany(l.base, rate) })),
    taxes: taxes.map((t) => ({ ...t, amount_company: toCompany(t.amount, rate) })),
  };
}

// The document links invoicing writes (design §22.27, plan 2B Task 31): through ctx.links only (rule 1), in the transaction of the write of
// the invoice's lines, as the process that writes them. delivery_to_invoice: one link per entrega a line bills; order_to_invoice: one per
// pedido a line bills with no entrega (an invoice made on the pedido). A line with both names the entrega only (the pedido is upstream of it).
// Voiding an invoice marks every link it has (kept, never deleted); a Borrador's delete takes them away.

const INVOICE = "invoicing.invoice";

function linksOf(ctx: ProcessContext): LinksApi {
  if (!ctx.links) throw new Error("ctx.links is not available: the kernel builds it for every run");
  return ctx.links;
}

/**
 * Makes the invoice's upstream links equal what its lines bill (insert, edit and every rewrite of the lines of a Borrador). The Emitir hook
 * rewrites the lines after the lifecycle left the Borrador status: the same from-set then, so the sync inserts and removes nothing.
 */
export async function syncInvoiceLinks(ctx: ProcessContext, invoiceId: string, lines: readonly { order_id?: string | null; delivery_id?: string | null }[]): Promise<void> {
  const deliveries = [...new Set(lines.flatMap((l) => (l.delivery_id ? [l.delivery_id] : [])))];
  const orders = [...new Set(lines.flatMap((l) => (!l.delivery_id && l.order_id ? [l.order_id] : [])))];
  const to = { entity: INVOICE, id: invoiceId };
  await linksOf(ctx).sync({ to, kind: "delivery_to_invoice", from: deliveries.map((id) => ({ entity: "sales.delivery", id })) });
  await linksOf(ctx).sync({ to, kind: "order_to_invoice", from: orders.map((id) => ({ entity: "sales.order", id })) });
}

/** The Borrador is about to be deleted: its links go first (the kernel removes them only while it is a Borrador). */
export async function unlinkInvoice(ctx: ProcessContext, invoiceId: string): Promise<void> {
  await syncInvoiceLinks(ctx, invoiceId, []);
}

/** The invoice was voided (its annulment accepted): every link touching it is marked. */
export async function markInvoiceLinksVoided(ctx: ProcessContext, invoiceId: string, reason: string): Promise<void> {
  await linksOf(ctx).markVoided({ entity: INVOICE, id: invoiceId, reason: reason.slice(0, 500) });
}

/** A lot or serial a line bills (Task 28.4): what sales published of the entrega line it was written from (sales.v_invoice_delivery_lines.lots). */
export interface LineLot { lotCode: string | null; expiresOn: string | null; serialNo: string | null; qty: number }

/**
 * The lots and serials of each entrega line of `lines` (Task 28.4, RG-5), read from sales' published view (rule 3) as the caller: what
 * inventory issued of the line (null when it issued no lot or serial, an untracked product).
 */
async function deliveryLineLots(ctx: ProcessContext, lines: readonly PricedLine[]): Promise<Map<string, LineLot[]>> {
  const ids = [...new Set(lines.flatMap((l) => (l.delivery_line_id ? [l.delivery_line_id] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx<{ id: string; lots: LineLot[] | null }[]>`select id, lots from sales.v_invoice_delivery_lines where id = any(${ids}::uuid[])`;
  return new Map(rows.flatMap((r) => (r.lots && r.lots.length > 0 ? [[r.id, r.lots] as const] : [])));
}

/** The refusal code of a line whose entrega lots are still being recorded: retryable (`invalid_state`), never final. */
export const LOTS_PENDING = "lots_pending";
/** The refusal code of a line whose lots will not come by themselves (their event dead-lettered): a person must act. */
export const LOTS_NOT_RECORDED = "lots_not_recorded";
const LOTS_NOT_RECORDED_TEXT = (line: string) =>
  `Inventario no registró los lotes de ${line}: su evento quedó en los eventos con error (Administración › Módulos). Reintenta ese evento o anula la entrega`;

/**
 * «Emitir» freezes the lots of every line written from an entrega line (Task 28.4 review): a line whose lot- or serial-tracked product has
 * no lots recorded yet in sales' published view (lots_pending, migration 0169: inventory's sale_issue.allocated has not reached sales) is
 * refused `lots_pending` (invalid_state, retryable) instead of being issued and frozen without them.
 */
export async function assertLotsRecorded(ctx: ProcessContext, lines: readonly { deliveryLineId?: string | null | undefined }[]): Promise<void> {
  const ids = [...new Set(lines.flatMap((l) => (l.deliveryLineId ? [l.deliveryLineId] : [])))];
  if (ids.length === 0) return;
  const rows = await ctx.tx<{ delivery_number: string | null; delivery_id: string; line_no: number; lots_failed: boolean }[]>`
    select delivery_number, delivery_id, line_no, lots_failed from sales.v_invoice_delivery_lines
    where id = any(${ids}::uuid[]) and (lots_pending or lots_failed) order by delivery_id, line_no`;
  const name = (r: (typeof rows)[number]) => `la línea ${r.line_no} de la entrega ${r.delivery_number ?? r.delivery_id}`;
  // The event that brings the lots dead-lettered (lots_failed, 0169): it never clears by itself, so the refusal says what to do.
  const failed = rows.filter((r) => r.lots_failed);
  if (failed.length > 0) refuseState(LOTS_NOT_RECORDED, failed.map((r) => LOTS_NOT_RECORDED_TEXT(name(r))));
  if (rows.length === 0) return;
  refuseState(LOTS_PENDING, rows.map((r) => `Los lotes de ${name(r)} aún se están registrando; inténtalo de nuevo en un momento`));
}

/**
 * Replaces the lines and taxes of the Borrador `invoiceId` and its totals with `priced`. A line written from an entrega line copies that
 * line's lots (invoice_lines.lots, Task 28.4): «Emitir» rewrites the lines, so they are the entrega's at the issue and frozen from there on.
 */
export async function writeParts(ctx: ProcessContext, invoiceId: string, priced: Priced, exchangeRate: number): Promise<void> {
  await ctx.tx`delete from invoicing.invoice_taxes where invoice_id = ${invoiceId}`;
  await ctx.tx`delete from invoicing.invoice_lines where invoice_id = ${invoiceId}`;
  // Each line and tax with its company amount at the invoice's rate (Task 34.4): «Emitir» rewrites them at the frozen rate (validate hook).
  const stored = withCompanyAmounts(priced.lines, priced.taxes, exchangeRate);
  const lots = await deliveryLineLots(ctx, priced.lines);
  await ctx.tx`insert into invoicing.invoice_lines ${ctx.tx(stored.lines.map((l) => {
    const billed = l.delivery_line_id ? lots.get(l.delivery_line_id) : undefined;
    return { company_id: ctx.companyId, invoice_id: invoiceId, ...l, lots: billed ? ctx.tx.json(billed as never) : null };
  }))}`;
  await syncInvoiceLinks(ctx, invoiceId, priced.lines);
  if (stored.taxes.length > 0) {
    await ctx.tx`insert into invoicing.invoice_taxes ${ctx.tx(stored.taxes.map((t) => ({ company_id: ctx.companyId, invoice_id: invoiceId, ...t })))}`;
  }
  await ctx.tx`
    update invoicing.invoices set subtotal = ${priced.subtotal}, discount_total = ${priced.discountTotal}, tax_total = ${priced.taxTotal},
           total = ${priced.total}, total_company = ${companyAmounts(priced.lines, priced.taxes, exchangeRate).total}
    where id = ${invoiceId}`;
}

interface OrderLineFacts { id: string; order_id: string; order_number: string | null; party_id: string; order_stage: string; order_status: string; currency: string; exchange_rate: string; qty: string; unit_price: string; discount_pct: string; product_id: string; description: string | null }
interface DeliveryLineFacts { id: string; delivery_id: string; delivery_number: string | null; order_line_id: string; qty: string }

/**
 * The checks of what an invoice (`invoiceId`, or a new one: null) bills of the sales chain, under the locks every invoice of the same pedidos
 * and entregas takes: a transaction-scoped lock per pedido (in id order: two invoices of the same pedido count each other), then every pedido
 * FOR SHARE (sales' published sales.lock_orders_for_invoice: a cancel of the pedido, FOR UPDATE, waits for this transaction and this one for
 * a cancel in flight), then every entrega it bills FOR SHARE (sales.lock_deliveries_for_invoice: likewise with an Anular of the entrega).
 * Every fact is read AFTER the locks (fix round 1). Refuses, with the lines named:
 *   - `delivery_voided` / `delivery_not_shipped`: an entrega that is voided or was never shipped (or not visible);
 *   - `order_cancelled` / `order_not_confirmed`: a pedido that is cancelled or not firm;
 *   - `invalid_order_line`: a line of another customer, a currency other than the invoice's, or a product other than the pedido line's;
 *   - `over_invoicing`: more than what the pedido line orders, or than what the entrega line delivered, once every other invoice that is
 *     not voided (Borradores included) is counted.
 */
export async function checkSources(ctx: ProcessContext, invoice: { id: string | null; partyId: string; currency: string }, lines: DraftLine[]): Promise<void> {
  const sourced = lines.filter((l) => l.orderLineId);
  if (sourced.length === 0) return;
  const orderLineIds = [...new Set(sourced.map((l) => l.orderLineId!))];
  // The pedido of a line never changes: read it to know what to lock, then read everything again under the locks.
  const owners = await ctx.tx<{ order_id: string }[]>`select distinct order_id from sales.v_invoice_order_lines where id = any(${orderLineIds}::uuid[])`;
  const orderIds = [...new Set([...owners.map((r) => r.order_id), ...sourced.flatMap((l) => (l.orderId ? [l.orderId] : []))])].sort();
  for (const orderId of orderIds) {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`invoicing.order:${ctx.companyId}:${orderId}`}, 0))`;
  }
  const orders = await ctx.tx<{ id: string; number: string | null; status: string; stage: string }[]>`
    select id, number, status, stage from sales.lock_orders_for_invoice(${orderIds}::uuid[])`;
  const rows = await ctx.tx<OrderLineFacts[]>`
    select id, order_id, order_number, party_id, order_stage, order_status, currency, exchange_rate::text, qty::text, unit_price::text, discount_pct::text, product_id, description
    from sales.v_invoice_order_lines where id = any(${orderLineIds}::uuid[])`;
  const orderLines = new Map(rows.map((r) => [r.id, r]));
  const deliveryIds = [...new Set(sourced.flatMap((l) => (l.deliveryId ? [l.deliveryId] : [])))];
  const problems: string[] = [];
  if (deliveryIds.length > 0) {
    const locked = await ctx.tx<{ id: string; number: string | null; status: string; stage: string; order_id: string; party_id: string }[]>`
      select id, number, status, stage, order_id, party_id from sales.lock_deliveries_for_invoice(${deliveryIds}::uuid[])`;
    const byId = new Map(locked.map((d) => [d.id, d]));
    for (const deliveryId of deliveryIds) {
      const d = byId.get(deliveryId);
      if (!d) refuseState("delivery_not_shipped", ["La entrega no existe o no es visible"]);
      if (d.status === "voided") refuseState("delivery_voided", [`La entrega ${d.number ?? d.id} está anulada: no se factura`]);
      if (d.stage !== "shipped") refuseState("delivery_not_shipped", [`La entrega ${d.number ?? d.id} no se ha despachado: se factura lo despachado`]);
    }
  }
  for (const o of orders) {
    if (o.stage === "cancelled" || o.status === "voided") refuseState("order_cancelled", [`El pedido ${o.number ?? o.id} está cancelado`]);
    if (!["confirmed", "partially_delivered", "delivered"].includes(o.stage)) refuseState("order_not_confirmed", [`El pedido ${o.number ?? o.id} no está confirmado`]);
  }
  sourced.forEach((l) => {
    const o = orderLines.get(l.orderLineId!);
    const at = `Línea ${lines.indexOf(l) + 1}`;
    if (!o) return problems.push(`${at}: la línea del pedido no existe o no es visible`);
    if (o.party_id !== invoice.partyId) return problems.push(`${at}: el pedido ${o.order_number ?? o.order_id} es de otro cliente`);
    if (o.currency !== invoice.currency) return problems.push(`${at}: el pedido ${o.order_number ?? o.order_id} está en ${o.currency}, la factura en ${invoice.currency}`);
    if (o.product_id !== l.productId || o.order_id !== l.orderId) return problems.push(`${at}: el producto o el pedido no corresponden a la línea del pedido`);
    return undefined;
  });
  if (problems.length > 0) refuse("invalid_order_line", problems);

  const deliveryLineIds = [...new Set(sourced.flatMap((l) => (l.deliveryLineId ? [l.deliveryLineId] : [])))];
  const delivered = deliveryLineIds.length === 0 ? [] : await ctx.tx<DeliveryLineFacts[]>`
    select id, delivery_id, delivery_number, order_line_id, qty::text from sales.v_invoice_delivery_lines where id = any(${deliveryLineIds}::uuid[])`;
  const deliveryLines = new Map(delivered.map((d) => [d.id, d]));
  const counted = await ctx.tx<{ order_line_id: string; delivery_line_id: string | null; qty: string }[]>`
    select order_line_id, delivery_line_id, qty::text from invoicing.invoiced_quantities(${orderLineIds}::uuid[], ${invoice.id}::uuid)`;
  const byOrderLine = new Map<string, number>();
  const byDeliveryLine = new Map<string, number>();
  for (const c of counted) {
    byOrderLine.set(c.order_line_id, (byOrderLine.get(c.order_line_id) ?? 0) + num(c.qty));
    if (c.delivery_line_id) byDeliveryLine.set(c.delivery_line_id, (byDeliveryLine.get(c.delivery_line_id) ?? 0) + num(c.qty));
  }
  const over: string[] = [];
  const thisOrderLine = new Map<string, number>();
  const thisDeliveryLine = new Map<string, number>();
  sourced.forEach((l) => {
    thisOrderLine.set(l.orderLineId!, (thisOrderLine.get(l.orderLineId!) ?? 0) + l.qty);
    if (l.deliveryLineId) thisDeliveryLine.set(l.deliveryLineId, (thisDeliveryLine.get(l.deliveryLineId) ?? 0) + l.qty);
  });
  for (const [lineId, asked] of thisOrderLine) {
    const o = orderLines.get(lineId)!;
    const before = byOrderLine.get(lineId) ?? 0;
    if (round4(before + asked) > num(o.qty)) {
      over.push(`El pedido ${o.order_number ?? o.order_id} pide ${qtyText(num(o.qty))} de la línea, ya van ${qtyText(before)} en facturas y esta factura lleva ${qtyText(asked)}`);
    }
  }
  for (const [lineId, asked] of thisDeliveryLine) {
    const d = deliveryLines.get(lineId);
    if (!d) {
      over.push("La línea de la entrega no existe o no es visible");
      continue;
    }
    const before = byDeliveryLine.get(lineId) ?? 0;
    if (round4(before + asked) > num(d.qty)) {
      over.push(`La entrega ${d.delivery_number ?? d.delivery_id} despachó ${qtyText(num(d.qty))}, ya van ${qtyText(before)} en facturas y esta factura lleva ${qtyText(asked)}`);
    }
  }
  if (over.length > 0) refuse("over_invoicing", over);
}

/** What is left to invoice of the shipped entrega lines of `orderIds` (or of entrega `deliveryId`): «Por facturar». */
export async function pendingDeliveryLines(ctx: ProcessContext, filter: { orderIds?: string[]; deliveryId?: string }) {
  return ctx.tx<{ party_id: string; order_id: string; delivery_id: string; delivery_line_id: string; order_line_id: string; product_id: string; description: string | null; pending_qty: string; unit_price: string; discount_pct: string; currency: string }[]>`
    select party_id, order_id, delivery_id, delivery_line_id, order_line_id, product_id, description, pending_qty::text, unit_price::text, discount_pct::text, currency
    from invoicing.v_pending_to_invoice
    where (${filter.orderIds ?? null}::uuid[] is null or order_id = any(${filter.orderIds ?? null}::uuid[]))
      and (${filter.deliveryId ?? null}::uuid is null or delivery_id = ${filter.deliveryId ?? null}::uuid)
    order by order_id, delivery_id, delivery_line_id`;
}

/**
 * The DIAN status an invoice must have to be corrected by a note or annulled (plan 2B Task 18, OD-7): the DIAN accepted it. A note
 * references the invoice's CUFE, which the DIAN knows only once it accepted the invoice; anything else is refused with what to do:
 *   - rejected: the invoice is not valid before the DIAN: corrected and sent again with «Reintentar envío» (same number, same CUFE);
 *   - failed (the run stopped, e.g. currency_not_supported) or not_configured: «Reintentar envío» (or the bulk sweep) first;
 *   - never sent (no submission yet) or on its way (queued, processing, submitted): wait for the DIAN's answer.
 */
export async function assertDianAccepted(ctx: ProcessContext, invoice: { id: string; number: string | null; dian_status: string }): Promise<void> {
  if (invoice.dian_status === "accepted") return;
  const name = invoice.number ?? invoice.id;
  if (invoice.dian_status === "rejected") {
    refuseState("invoice_rejected", [`La DIAN rechazó la factura ${name}: corrígela y usa «Reintentar envío»; una nota solo corrige una factura que la DIAN aceptó`]);
  }
  const [s] = await ctx.tx<{ status: string; last_error: string | null }[]>`
    select status, last_error from invoicing.einvoice_submissions where invoice_id = ${invoice.id} and note_id is null`;
  if (!s) refuseState("invoice_not_sent", [`La factura ${name} aún no se ha enviado a la DIAN: una nota solo corrige una factura que la DIAN aceptó`]);
  if (s.status === "failed") {
    refuseState("invoice_send_failed", [`El envío de la factura ${name} a la DIAN se detuvo (${s.last_error ?? "sin motivo"}): usa «Reintentar envío» y espera su aceptación`]);
  }
  if (s.status === "not_configured") {
    refuseState("einvoice_not_configured", [`La factura ${name} no se envió a la DIAN: registra el software de facturación electrónica y usa «Reintentar envío»`]);
  }
  refuseState("invoice_not_accepted", [`La factura ${name} está en camino a la DIAN y aún no tiene su respuesta: espera a que la acepte`]);
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

/** How far an invoice's rate may stand from the TRM of its issue date before «Emitir» warns (R34-8): 0,005 % of the TRM. */
export const RATE_WARNING_TOLERANCE = 0.00005;

/** Whether `rate` differs from `trm` by more than RATE_WARNING_TOLERANCE of it (R34-8; the issue output and the record's chip). */
export const rateDiffers = (rate: number, trm: number): boolean => trm > 0 && Math.abs(rate - trm) > trm * RATE_WARNING_TOLERANCE;

/** The refusal's detail when a foreign-currency document has no rate (FX §2). */
export const exchangeRateMissing = (currency: string, date: string): string =>
  `No hay tasa de cambio para ${currency} el ${date}; regístrala en Tasas de cambio o escríbela en el documento`;
