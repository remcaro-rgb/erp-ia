import { defineProcess, emitAndPostStrict, ProcessError, runLifecycle, type ProcessContext, type TypedHooks, type TypedRecord } from "@erp/kernel";
import { z } from "zod";
import { invoiceEntity, type InvoiceStage } from "../entities";
import { allocatedTo } from "../consumers/payments";
import { assertInvoiceReady, readInvoiceFacts } from "../readiness";
import {
  assertDianAccepted, checkSources, companyAmounts, date, FEATURE_INVOICES, id, INVOICE_CREATED, INVOICE_ISSUED, money, num, packOf, pendingDeliveryLines, percent, priceLines, qty,
  refuse, refuseState, settingsOf, today, writeParts, type DraftLine,
} from "./common";

// Facturas de venta (plan 2B Task 16, design §8 and §8.1 step 5, OD-2, OD-7). A documento that posts (contabiliza) and never waits for
// approval (own flags). Borrador while it is written: invoicing.invoice.create (by hand, or from what a pedido shipped: «Por facturar»,
// invoicing.invoice.from_orders; or by an automatic mode, auto.ts) and invoicing.invoice.update. Not numbered: Eliminar removes it (D1).
//
// «Emitir» (invoicing.invoice.issue: the Grabar of a Borrador, not step-up) in ONE transaction, through the typed lifecycle:
//   1. validate (save): the lines that bill a sale are checked again under the locks of their pedidos and entregas (an entrega voided
//      meanwhile is refused, an Anular in flight is waited for, nothing is invoiced twice: common.checkSources); the customer and every
//      product must be invoice_ready, with the reasons (rule 10); the invoice is dated on the company's today (its time zone: DIAN numbers
//      are consecutive and the issue date is the date it is generated; controller ruling of fix round 1), the date it had (the entrega's,
//      the pedido's or the Borrador's own) kept as its service_date; the taxes are evaluated again by the country pack (rule 5) on that
//      date; the PRICES are kept (owner item 17: «Recalcular precios», invoicing.invoice.reprice, is the user's action; «Emitir» only warns
//      when price_date is not the issue date); the due date follows the payment form (contado: today; crédito: today plus the term the Borrador had);
//   2. number (on save, D9): the next consecutive of the company's DIAN resolution (the pack's nextNumber over core.next_document_number,
//      in this transaction: a refused issue leaves no gap); out of range, expired, not yet valid or no resolution is refused with the
//      resolution's data. The CUFE is computed with it (the pack's invoiceCode: number, date and time, totals, both tax ids, the
//      resolution's technical key, the DIAN environment of the Parámetros). One number and one CUFE per invoice, never reused;
//   3. post (D8): stage issued and invoicing.invoice.issued posted STRICT and INLINE (emitAndPostStrict, requireRule): receivable /
//      revenue per line (the cost center: the invoice's, else the Parámetros' default) / IVA per tax. A closed period, a customer the
//      ledger cannot take or a missing mapping refuses the whole issue with nothing written; a company without accounting issues and the
//      event parks; a ledger never started is refused (ledger_not_started).
// A retry of «Emitir» with the same idempotency key answers the first result.
//
// Anular (invoicing.invoice.void, STEP-UP, OD-7): a Borrador is deleted (Eliminar); an issued invoice is annulled only by a credit note
// of annulment (Task 18: invoicing.note.issue_annulment, run nested here only, never on its own), never by a status change. The invoice
// stays `issued` until the DIAN accepts that note (then it is voided and names it; its number is never reused). Refused: an invoice a
// posted receipt settles (paid or partly paid, read under the invoice's lock: void the receipt first, Task 23), one with a note already,
// and one the DIAN has not accepted (common.assertDianAccepted says what to do).

/** What Grabar may change of an invoice (its lines, dates, customer and terms change through invoicing.invoice.update). */
const WRITABLE = ["notes", "extra", "extra_free"];

export const manualLineInput = z.object({
  productId: id,
  qty,
  /** The unit price; absent, the product's list price. */
  unitPrice: money.optional(),
  discountPct: percent.optional(),
  description: z.string().trim().min(1).max(300).optional(),
}).strict();

const headerInput = {
  issueDate: date.optional(),
  dueDate: date.optional(),
  /** 1 contado, 2 crédito (DIAN table 13.3.4.1). */
  paymentForm: z.enum(["1", "2"]).optional(),
  /** A DIAN payment means code (table 13.3.4.2) the country pack accepts. */
  paymentMeans: z.string().trim().min(1).max(5).optional(),
  costCenterId: id.optional(),
  notes: z.string().trim().max(2000).optional(),
};

/** invoicing.invoice.update: an omitted field keeps its value; null clears the cost center and the notes. */
const updateHeaderInput = {
  ...headerInput,
  costCenterId: id.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
};

export const invoiceOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  cufe: z.string().nullable(),
  status: z.string(),
  stage: z.string(),
  dianStatus: z.string(),
  origin: z.string(),
  partyId: z.string(),
  issueDate: z.string(),
  /** Set by «Emitir» only: the Borrador's prices are from another day than the issue date (owner item 17); null/absent: they are from the issue date. */
  priceWarning: z.string().nullable().optional(),
  /** The date of what the invoice bills (entrega, pedido or the Borrador's own date); «Emitir» dates the invoice today. */
  serviceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  subtotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
  issuedAt: z.string().nullable(),
});
export type InvoiceOutput = z.output<typeof invoiceOutput>;

export interface InvoiceRow {
  id: string; number: string | null; cufe: string | null; status: string; stage: InvoiceStage; dian_status: string; origin: string; party_id: string;
  issue_date: string; service_date: string | null; due_date: string | null; payment_form: "1" | "2"; payment_means: string; currency: string; exchange_rate: string;
  subtotal: string; tax_total: string; total: string; cost_center_id: string | null; issued_at: string | null; paid_amount: string;
  credited_amount: string; debited_amount: string; annulment_note_id: string | null; auto_source: string | null;
}
export interface LineRow {
  line_no: number; product_id: string; description: string | null; qty: string; unit_price: string; discount_pct: string; base: string; free_sample: boolean;
  category_id: string | null; order_id: string | null; order_line_id: string | null; delivery_id: string | null; delivery_line_id: string | null;
}

export const label = (row: { number: string | null; id: string }) => row.number ?? row.id;

export async function readInvoice(ctx: ProcessContext, invoiceId: string, lock = false): Promise<InvoiceRow> {
  const rows = lock
    ? await ctx.tx<InvoiceRow[]>`
        select id, number, cufe, status, stage, dian_status, origin, party_id, issue_date::text, service_date::text, due_date::text, payment_form, payment_means, currency,
               exchange_rate::text, subtotal::text, tax_total::text, total::text, cost_center_id, paid_amount::text, credited_amount::text, debited_amount::text, annulment_note_id, auto_source,
               to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at
        from invoicing.invoices where id = ${invoiceId} for update`
    : await ctx.tx<InvoiceRow[]>`
        select id, number, cufe, status, stage, dian_status, origin, party_id, issue_date::text, service_date::text, due_date::text, payment_form, payment_means, currency,
               exchange_rate::text, subtotal::text, tax_total::text, total::text, cost_center_id, paid_amount::text, credited_amount::text, debited_amount::text, annulment_note_id, auto_source,
               to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at
        from invoicing.invoices where id = ${invoiceId}`;
  if (!rows[0]) throw new ProcessError("not_found", `invoice ${invoiceId} not found`);
  return rows[0];
}

export async function outputOf(ctx: ProcessContext, invoiceId: string): Promise<InvoiceOutput> {
  const r = await readInvoice(ctx, invoiceId);
  return {
    id: r.id, number: r.number, cufe: r.cufe, status: r.status, stage: r.stage, dianStatus: r.dian_status, origin: r.origin, partyId: r.party_id,
    issueDate: r.issue_date, serviceDate: r.service_date, dueDate: r.due_date, currency: r.currency, subtotal: num(r.subtotal), taxTotal: num(r.tax_total), total: num(r.total), issuedAt: r.issued_at,
  };
}

async function linesOf(ctx: ProcessContext, invoiceId: string): Promise<LineRow[]> {
  return ctx.tx<LineRow[]>`
    select line_no, product_id, description, qty::text, unit_price::text, discount_pct::text, base::text, free_sample, category_id, order_id, order_line_id, delivery_id, delivery_line_id
    from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`;
}

const draftOf = (l: LineRow): DraftLine => ({
  productId: l.product_id, qty: num(l.qty), unitPrice: num(l.unit_price), discountPct: num(l.discount_pct), description: l.description,
  orderId: l.order_id, orderLineId: l.order_line_id, deliveryId: l.delivery_id, deliveryLineId: l.delivery_line_id,
});

async function assertPaymentMeans(ctx: ProcessContext, means: string | undefined): Promise<void> {
  if (means === undefined) return;
  const { einvoice } = await packOf(ctx);
  if (!einvoice.paymentMeans.includes(means)) refuse("invalid_payment_means", [`El medio de pago ${means} no es un código DIAN aceptado`]);
}

/** The due date of an invoice: contado (1) the issue date unless one is given; crédito (2) the given one, else the days of credit. */
async function dueDateOf(ctx: ProcessContext, form: "1" | "2", issueDate: string, given: string | null | undefined): Promise<string> {
  if (given) {
    if (given < issueDate) refuse("invalid_due_date", ["El vencimiento no puede ser anterior a la fecha de la factura"]);
    return given;
  }
  if (form === "1") return issueDate;
  const { creditDays } = await settingsOf(ctx);
  const [row] = await ctx.tx<{ due: string }[]>`select (${issueDate}::date + ${creditDays}::int)::text as due`;
  return row!.due;
}

export interface CreateArgs {
  partyId: string;
  issueDate: string;
  /** The date of what the invoice bills (an entrega's date); absent, the issue date. */
  serviceDate?: string | undefined;
  dueDate?: string | undefined;
  paymentForm?: "1" | "2" | undefined;
  paymentMeans?: string | undefined;
  currency?: string | undefined;
  exchangeRate?: number | undefined;
  costCenterId?: string | undefined;
  notes?: string | undefined;
  lines: DraftLine[];
  origin: "manual" | "from_orders" | "on_delivery" | "on_order_confirmation";
  autoSource?: string;
  /** An automatic invoice (origin event): a customer or product not invoice_ready leaves the Borrador with `notReady` instead of refusing. */
  allowNotReady: boolean;
}

/** Writes a Borrador invoice with its lines and taxes (after the readiness gate and the checks of what it bills) and emits invoicing.invoice.created. */
export async function createInvoice(ctx: ProcessContext, args: CreateArgs): Promise<{ id: string; notReady: string[] }> {
  if (args.lines.length === 0) refuse("nothing_to_invoice", ["La factura no tiene líneas"]);
  const facts = await readInvoiceFacts(ctx, args.partyId, args.lines.map((l) => l.productId));
  if (facts.notReady.length > 0 && !args.allowNotReady) refuse("not_invoice_ready", facts.notReady);
  await assertPaymentMeans(ctx, args.paymentMeans);
  const { einvoice } = await packOf(ctx);
  const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
  const currency = args.currency ?? company!.currency_code;
  if (currency !== company!.currency_code && !args.exchangeRate) refuse("exchange_rate_required", [`Indica la tasa de cambio de ${currency} a ${company!.currency_code}`]);
  const exchangeRate = currency === company!.currency_code ? 1 : args.exchangeRate!;
  await checkSources(ctx, { id: null, partyId: args.partyId, currency }, args.lines);
  const paymentForm = args.paymentForm ?? "1";
  const dueDate = await dueDateOf(ctx, paymentForm, args.issueDate, args.dueDate);
  const priced = await priceLines(ctx, facts.party, facts.products, args.lines, args.issueDate);
  const [row] = await ctx.tx<{ id: string }[]>`
    insert into invoicing.invoices ${ctx.tx({
      company_id: ctx.companyId,
      party_id: args.partyId,
      issue_date: args.issueDate,
      service_date: args.serviceDate ?? args.issueDate,
      price_date: await today(ctx),
      due_date: dueDate,
      payment_form: paymentForm,
      payment_means: args.paymentMeans ?? einvoice.defaultPaymentMeans,
      origin: args.origin,
      auto_source: args.autoSource ?? null,
      currency,
      exchange_rate: exchangeRate,
      cost_center_id: args.costCenterId ?? null,
      notes: args.notes ?? null,
      // An invoice never waits for approval and always posts (ownFlags): explicit, so the Parámetros switches never apply.
      requires_approval: false,
      posts: true,
    })} returning id`;
  await writeParts(ctx, row!.id, priced, exchangeRate);
  // The entregas and pedidos this invoice bills no longer wait on a refused automatic invoice: their recommendations close (Task 38).
  const billed = [
    ...new Set(args.lines.flatMap((l) => (l.deliveryId ? [`sales.delivery:${l.deliveryId}`] : []))),
    ...new Set(args.lines.flatMap((l) => (l.orderId ? [`sales.order:${l.orderId}`] : []))),
  ];
  for (const key of billed) {
    const [entity, id] = key.split(":") as [string, string];
    await ctx.recommendations?.close({ subject: { entity, id } });
  }
  await ctx.emit(INVOICE_CREATED, { invoiceId: row!.id, partyId: args.partyId, origin: args.origin, issueDate: args.issueDate, currency, total: priced.total });
  return { id: row!.id, notReady: facts.notReady };
}

/** Manual lines priced at the given price or the product's list price, 0 % off unless given. */
async function manualLines(ctx: ProcessContext, partyId: string, lines: z.output<typeof manualLineInput>[]): Promise<DraftLine[]> {
  const facts = await readInvoiceFacts(ctx, partyId, lines.map((l) => l.productId));
  const missing: string[] = [];
  const out = lines.map((l, i): DraftLine => {
    const p = facts.products.get(l.productId)!;
    const unitPrice = l.unitPrice ?? p.listPrice;
    if (unitPrice === null || unitPrice === undefined) missing.push(`Línea ${i + 1}: el producto ${p.sku} no tiene precio de lista: indica el precio`);
    return { productId: l.productId, qty: l.qty, unitPrice: unitPrice ?? 0, discountPct: l.discountPct ?? 0, description: l.description ?? null };
  });
  if (missing.length > 0) refuse("price_not_found", missing);
  return out;
}

export const invoiceCreate = defineProcess({
  id: "invoicing.invoice.create",
  module: "invoicing",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  emits: [INVOICE_CREATED],
  description:
    "Crea una factura de venta en borrador para un cliente con sus líneas (producto, cantidad, precio y descuento); los impuestos los calcula el paquete del país. El cliente y los productos deben estar listos para facturar",
  input: z.object({
    partyId: id,
    ...headerInput,
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    exchangeRate: z.number().finite().positive().optional(),
    lines: z.array(manualLineInput).min(1).max(500),
  }).strict(),
  output: invoiceOutput,
  handler: async (ctx, input) => {
    const lines = await manualLines(ctx, input.partyId, input.lines);
    const created = await createInvoice(ctx, {
      ...input,
      issueDate: input.issueDate ?? (await today(ctx)),
      lines,
      origin: "manual",
      allowNotReady: false,
    });
    return outputOf(ctx, created.id);
  },
});

export const invoiceUpdate = defineProcess({
  id: "invoicing.invoice.update",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  description:
    "Cambia una factura en borrador: fechas, forma y medio de pago, centro de costo, notas y, si se escribió a mano, sus líneas; los impuestos se recalculan",
  input: z.object({
    id,
    ...updateHeaderInput,
    lines: z.array(manualLineInput).min(1).max(500).optional(),
    expectedUpdatedAt: z.string().optional(),
  }).strict(),
  output: invoiceOutput,
  handler: async (ctx, input) => {
    const invoice = await readInvoice(ctx, input.id, true);
    if (invoice.stage !== "draft" || invoice.status !== "draft") refuseState("invoice_issued", [`La factura ${label(invoice)} ya se emitió: se corrige con una nota`]);
    if (input.lines && invoice.origin !== "manual") refuse("lines_from_sale", ["Las líneas de una factura de un pedido vienen de lo despachado: elimina el borrador y créalo de nuevo"]);
    await assertPaymentMeans(ctx, input.paymentMeans);
    const issueDate = input.issueDate ?? invoice.issue_date;
    const paymentForm = input.paymentForm ?? invoice.payment_form;
    const dueDate = await dueDateOf(ctx, paymentForm, issueDate, input.dueDate ?? (input.issueDate || input.paymentForm ? null : invoice.due_date));
    const [current] = await ctx.tx<{ notes: string | null }[]>`select notes from invoicing.invoices where id = ${invoice.id}`;
    await ctx.tx`
      update invoicing.invoices set issue_date = ${issueDate},
             service_date = ${input.issueDate !== undefined && invoice.service_date === invoice.issue_date ? input.issueDate : invoice.service_date},
             due_date = ${dueDate}, payment_form = ${paymentForm}, payment_means = ${input.paymentMeans ?? invoice.payment_means},
             cost_center_id = ${input.costCenterId === undefined ? invoice.cost_center_id : input.costCenterId},
             notes = ${input.notes === undefined ? current!.notes : input.notes}
      where id = ${invoice.id}`;
    const drafts = input.lines ? await manualLines(ctx, invoice.party_id, input.lines) : (await linesOf(ctx, invoice.id)).map(draftOf);
    const facts = await assertInvoiceReady(ctx, invoice.party_id, drafts.map((l) => l.productId));
    await writeParts(ctx, invoice.id, await priceLines(ctx, facts.party, facts.products, drafts, issueDate), num(invoice.exchange_rate));
    // New lines are priced now (the list of today or the typed price): their price date is today. A change of dates or terms keeps it.
    if (input.lines) await ctx.tx`update invoicing.invoices set price_date = ${await today(ctx)} where id = ${invoice.id}`;
    return outputOf(ctx, invoice.id);
  },
});

/**
 * «Recalcular precios» (owner item 17, ruling R50-17): the Borrador keeps its prices until the user asks. This sets every line's unit price
 * from its product's list price of today (a product with no list price keeps the line's price; the discount stays), taxes the lines again
 * with the country pack on the invoice's own date (the issue date is moved to today by «Emitir», which taxes again then) and writes
 * price_date = the company's today. A Borrador only.
 */
export const invoiceReprice = defineProcess({
  id: "invoicing.invoice.reprice",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  description:
    "Recalcula los precios de una factura en borrador con la lista de precios de hoy y vuelve a calcular sus impuestos; «Emitir» ya no cambia los precios. Una factura emitida no se recalcula",
  input: z.object({ id, expectedUpdatedAt: z.string().optional() }).strict(),
  output: invoiceOutput,
  handler: async (ctx, input) => {
    const invoice = await readInvoice(ctx, input.id, true);
    if (invoice.stage !== "draft" || invoice.status !== "draft") refuseState("invoice_issued", [`La factura ${label(invoice)} ya se emitió: los precios no se recalculan; se corrigen con una nota`]);
    const drafts = (await linesOf(ctx, invoice.id)).map(draftOf);
    if (drafts.length === 0) refuse("nothing_to_invoice", ["La factura no tiene líneas"]);
    const facts = await assertInvoiceReady(ctx, invoice.party_id, drafts.map((l) => l.productId));
    const repriced = drafts.map((l) => ({ ...l, unitPrice: facts.products.get(l.productId)!.listPrice ?? l.unitPrice }));
    await writeParts(ctx, invoice.id, await priceLines(ctx, facts.party, facts.products, repriced, invoice.issue_date), num(invoice.exchange_rate));
    await ctx.tx`update invoicing.invoices set price_date = ${await today(ctx)} where id = ${invoice.id}`;
    return outputOf(ctx, invoice.id);
  },
});

/**
 * «Facturar pedidos» (OD-2 manual, «Por facturar»): one Borrador per customer and currency with what shipped of `orderIds` and is not yet on
 * an invoice, at the pedido's price and discount.
 */
export const invoiceFromOrders = defineProcess({
  id: "invoicing.invoice.from_orders",
  module: "invoicing",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  emits: [INVOICE_CREATED],
  description:
    "Crea las facturas en borrador de lo despachado y aún no facturado de los pedidos indicados (una por cliente y moneda), al precio y descuento de cada pedido",
  input: z.object({
    orderIds: z.array(id).min(1).max(50),
    ...headerInput,
    /** The rate of a foreign-currency invoice on its date (rule 8: the document's snapshot); absent, each pedido's own rate. */
    exchangeRate: z.number().finite().positive().optional(),
  }).strict(),
  output: z.object({ invoices: z.array(invoiceOutput) }),
  handler: async (ctx, input) => {
    const pending = await pendingDeliveryLines(ctx, { orderIds: [...new Set(input.orderIds)] });
    if (pending.length === 0) refuseState("nothing_to_invoice", ["Los pedidos no tienen nada despachado por facturar"]);
    const rates = new Map((await ctx.tx<{ order_id: string; exchange_rate: string }[]>`
      select distinct order_id, exchange_rate::text from sales.v_invoice_order_lines where order_id = any(${[...new Set(pending.map((p) => p.order_id))]}::uuid[])`).map((r) => [r.order_id, num(r.exchange_rate)]));
    const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
    // One invoice per customer, currency and rate: an invoice has one rate snapshot (rule 8); pedidos at different rates are not merged.
    const rateOf = (p: (typeof pending)[number]) => (p.currency === company!.currency_code ? 1 : input.exchangeRate ?? rates.get(p.order_id) ?? 1);
    const groups = new Map<string, (typeof pending)[number][]>();
    for (const p of pending) {
      const key = `${p.party_id}:${p.currency}:${rateOf(p)}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const issueDate = input.issueDate ?? (await today(ctx));
    const invoices: InvoiceOutput[] = [];
    for (const lines of groups.values()) {
      const first = lines[0]!;
      const created = await createInvoice(ctx, {
        ...input,
        partyId: first.party_id,
        issueDate,
        currency: first.currency,
        exchangeRate: rateOf(first),
        lines: lines.map((p) => ({
          productId: p.product_id, qty: num(p.pending_qty), unitPrice: num(p.unit_price), discountPct: num(p.discount_pct), description: p.description,
          orderId: p.order_id, orderLineId: p.order_line_id, deliveryId: p.delivery_id, deliveryLineId: p.delivery_line_id,
        })),
        origin: "from_orders",
        allowNotReady: false,
      });
      invoices.push(await outputOf(ctx, created.id));
    }
    return { invoices };
  },
});

export const invoiceIssue = defineProcess({
  id: "invoicing.invoice.issue",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  emits: [INVOICE_ISSUED],
  description:
    "Emite una factura en borrador: la numera con la resolución DIAN vigente, calcula su CUFE y la contabiliza en la misma operación (cuenta por cobrar, ingreso e IVA)",
  input: z.object({
    id,
    /** One per «Emitir» the user asks for (a form submit): a retry with the same key answers the first result. */
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
    notes: z.string().trim().max(2000).optional(),
  }).strict(),
  output: invoiceOutput,
  auditInput: (input) => ({ id: input.id }),
  idempotencyKey: (input) => (input.idempotencyKey ? `issue:${input.id}:${input.idempotencyKey}` : undefined),
  handler: async (ctx, { id: invoiceId, idempotencyKey, notes }) => {
    const invoice = await readInvoice(ctx, invoiceId, true);
    if (invoice.stage !== "draft") {
      // A run with the same key that issued while this one waited for the invoice's lock: its stored result.
      if (idempotencyKey) {
        const [stored] = await ctx.tx<{ result: InvoiceOutput }[]>`
          select result from kernel.process_idempotency where company_id = ${ctx.companyId} and process_id = 'invoicing.invoice.issue' and key = ${`issue:${invoiceId}:${idempotencyKey}`}`;
        if (stored) return stored.result;
      }
      refuseState("invoice_issued", [`La factura ${label(invoice)} ya se emitió`]);
    }
    await runLifecycle(ctx, ctx.registry.entity(invoiceEntity.id), invoiceId, "save", notes === undefined ? {} : { data: { notes } });
    // Owner item 17: «Emitir» keeps the prices; it only says when they are from another day than the issue date.
    const [dates] = await ctx.tx<{ price_date: string | null; issue_date: string }[]>`select price_date::text, issue_date::text from invoicing.invoices where id = ${invoiceId}`;
    const priceWarning = dates?.price_date && dates.price_date !== dates.issue_date ? `Los precios son del ${dates.price_date}, no de la fecha de emisión (${dates.issue_date})` : null;
    return { ...(await outputOf(ctx, invoiceId)), priceWarning };
  },
});

/**
 * Anular is refused while receipts settle the invoice (Task 23: void the receipt first). The allocations of the posted receipts are read
 * under the invoice's lock (payments' published allocated_amounts), the lock «Registrar pago» takes: a receipt that committed before this
 * lock counts even if invoicing's consumer has not recorded it on paid_amount yet, and a receipt waiting for the lock finds the annulment
 * note in progress and is refused (invoice_annulment_pending).
 */
export async function assertNoPayments(ctx: ProcessContext, invoice: InvoiceRow): Promise<void> {
  const settled = (await allocatedTo(ctx, [invoice.id])).get(invoice.id) ?? 0;
  if (invoice.stage === "paid" || num(invoice.paid_amount) > 0 || settled > 0) {
    refuseState("invoice_paid", [`La factura ${label(invoice)} tiene pagos aplicados: anula primero los recibos de caja que la pagan`]);
  }
}

/** Task 18's process: the credit note of annulment of an issued invoice (OD-7). */
export const ANNULMENT_PROCESS = "invoicing.note.issue_annulment";

export const invoiceVoid = defineProcess({
  id: "invoicing.invoice.void",
  module: "invoicing",
  kind: "update",
  feature: FEATURE_INVOICES,
  sensitivity: "step-up",
  // The annulment credit note it issues as a nested run (invoicing.note.issue_annulment) emits invoicing.note.issued in this run (NOTE_ISSUED,
  // note.ts, which imports this file): the confirmation card asks the ledger what that note posts (plan 2B Task 25).
  emits: ["invoicing.note.issued"],
  description:
    "Anula una factura: un borrador se elimina; una factura emitida y aceptada por la DIAN se anula solo con una nota crédito de anulación, y queda anulada cuando la DIAN acepta la nota. Se rechaza si está pagada, ya tiene una nota o la DIAN no la ha aceptado",
  input: z.object({
    id,
    reason: z.string().trim().min(1, "Indica por qué se anula la factura").max(500),
    expectedUpdatedAt: z.string().optional(),
  }).strict(),
  output: z.object({ id: z.string(), deleted: z.boolean(), annulmentNoteId: z.string().nullable() }),
  handler: async (ctx, input) => {
    const invoice = await readInvoice(ctx, input.id, true);
    if (invoice.stage === "draft") {
      await runLifecycle(ctx, ctx.registry.entity(invoiceEntity.id), invoice.id, "delete", input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {});
      return { id: invoice.id, deleted: true, annulmentNoteId: null };
    }
    if (invoice.stage === "voided" || invoice.status === "voided") refuseState("invoice_voided", [`La factura ${label(invoice)} ya está anulada`]);
    if (invoice.annulment_note_id || num(invoice.credited_amount) > 0 || num(invoice.debited_amount) > 0) {
      refuseState("invoice_has_note", [`La factura ${label(invoice)} ya tiene una nota crédito o débito: no se anula de nuevo`]);
    }
    await assertNoPayments(ctx, invoice);
    // Only an invoice the DIAN accepted is annulled (its CUFE is what the note references); rejected, failed or not yet answered: refused
    // with what to do (Task 18).
    await assertDianAccepted(ctx, invoice);
    if (!ctx.registry.processes({ module: "invoicing" }).some((p) => p.id === ANNULMENT_PROCESS) || !ctx.runProcess) {
      refuseState("annulment_not_available", [`Una factura emitida se anula con una nota crédito de anulación, que aún no está disponible: la factura ${label(invoice)} sigue vigente`]);
    }
    const note = await ctx.runProcess<{ id: string }>(ANNULMENT_PROCESS, { invoiceId: invoice.id, reason: input.reason });
    return { id: invoice.id, deleted: false, annulmentNoteId: note.id };
  },
});

export const invoiceConsult = defineProcess({
  id: "invoicing.invoice.consult",
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_INVOICES,
  description: "Consulta una factura de venta con sus líneas, sus impuestos, su envío a la DIAN (estado y errores) y los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })), taxes: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: invoiceId }) => {
    const [row] = await ctx.tx`select * from invoicing.v_invoices where id = ${invoiceId}`;
    if (!row) throw new ProcessError("not_found", `invoice ${invoiceId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from invoicing.v_invoice_lines where invoice_id = ${invoiceId} order by line_no`;
    const taxes = await ctx.tx<{ id: string }[]>`select * from invoicing.v_invoice_taxes where invoice_id = ${invoiceId} order by seq`;
    const recommendations = await ctx.tx<{ id: string }[]>`select * from invoicing.v_invoice_recommendations where invoice_id = ${invoiceId} order by seq desc`;
    // Its DIAN submission (Task 17): status, trackId, attempts and the errors of a rejection, as the role may see them.
    // The invoice's own (Task 19 fix round 2): its notes' submissions carry its invoice_id too.
    const [einvoice] = await ctx.tx`select * from invoicing.v_einvoice_submissions where invoice_id = ${invoiceId} and note_id is null`;
    return { ...row, id: invoiceId, lines, taxes, recommendations, einvoice: einvoice ?? null };
  },
});

const consultOf = (entity: string, view: string, what: string) => defineProcess({
  id: `${entity}.consult`,
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_INVOICES,
  description: `Consulta ${what} con los campos que el rol puede ver`,
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: rowId }) => {
    const [row] = await ctx.tx.unsafe(`select * from invoicing.${view} where id = $1`, [rowId]);
    if (!row) throw new ProcessError("not_found", `${entity} ${rowId} not found`);
    return { ...row, id: rowId };
  },
});

export const invoiceLineConsult = consultOf("invoicing.invoice_line", "v_invoice_lines", "una línea de factura");
export const invoiceTaxConsult = consultOf("invoicing.invoice_tax", "v_invoice_taxes", "un impuesto de una factura");
export const recommendationConsult = consultOf("invoicing.invoice_recommendation", "v_invoice_recommendations", "una recomendación de una factura automática que quedó en borrador");

// ---------------------------------------------------------------------------------------------
// The typed hooks of the invoice: what «Emitir» checks, numbers and posts.
// ---------------------------------------------------------------------------------------------

const resolutionText = (r: { number: string; prefix: string; from: number; to: number; validFrom: string; validTo: string } | undefined) =>
  r ? `resolución DIAN ${r.number} (prefijo ${r.prefix || "sin prefijo"}, del ${r.from} al ${r.to}, vigente del ${r.validFrom} al ${r.validTo})` : "resolución DIAN";

const NUMBER_REFUSALS: Record<string, (r: string) => string> = {
  out_of_range: (r) => `La ${r} agotó su rango: solicita una nueva resolución a la DIAN y regístrala`,
  expired: (r) => `La ${r} está vencida para la fecha de la factura: registra la resolución vigente`,
  not_yet_valid: (r) => `La ${r} aún no está vigente para la fecha de la factura`,
  no_resolution: () => "La empresa no tiene una resolución DIAN de facturación registrada",
};

/** The issue time as the CUFE and the XML carry it: HH:mm:ss and the company's UTC offset (Colombia -05:00). */
async function issueTime(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ t: string; off: number }[]>`
    select to_char(now() at time zone tz, 'HH24:MI:SS') as t,
           round(extract(epoch from ((now() at time zone tz) - (now() at time zone 'UTC'))) / 60)::int as off
    from (select coalesce(timezone, 'America/Bogota') as tz from kernel.companies where id = ${ctx.companyId}) c`;
  const off = row!.off;
  const abs = Math.abs(off);
  return `${row!.t}${off < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export const invoiceHooks: TypedHooks = {
  async validate(ctx, record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (data) {
      const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
      if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for invoicing.invoice.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    }
    // Only «Emitir» (Grabar from Borrador) checks and taxes again; a Grabar of the notes of an issued invoice is refused by its status.
    if (previous.status !== "draft") return;
    const invoice = await readInvoice(ctx, record.id as string);
    const drafts = (await linesOf(ctx, invoice.id)).map(draftOf);
    if (drafts.length === 0) refuse("nothing_to_invoice", ["La factura no tiene líneas"]);
    await checkSources(ctx, { id: invoice.id, partyId: invoice.party_id, currency: invoice.currency }, drafts);
    const facts = await assertInvoiceReady(ctx, invoice.party_id, drafts.map((l) => l.productId));
    // Dated today (ruling, fix round 1): the date the Borrador had is its service date; crédito keeps the term it had (due − date).
    // Prices are NOT recalculated here (owner item 17): the lines keep their stored unit price (draftOf); only the taxes are evaluated on the
    // issue date. «Recalcular precios» (invoicing.invoice.reprice) is the user's own action.
    const issueDate = await today(ctx);
    const [term] = await ctx.tx<{ days: number | null }[]>`select (${invoice.due_date}::date - ${invoice.issue_date}::date) as days`;
    const [dated] = await ctx.tx<{ due: string }[]>`select (${issueDate}::date + ${invoice.payment_form === "2" ? Math.max(term?.days ?? 0, 0) : 0}::int)::text as due`;
    await ctx.tx`
      update invoicing.invoices set issue_date = ${issueDate}, service_date = coalesce(service_date, issue_date), due_date = ${dated!.due}
      where id = ${invoice.id}`;
    await writeParts(ctx, invoice.id, await priceLines(ctx, facts.party, facts.products, drafts, issueDate), num(invoice.exchange_rate));
  },
  async number(ctx, record: TypedRecord) {
    const invoice = await readInvoice(ctx, record.id as string);
    const { einvoice } = await packOf(ctx);
    const drawn = await einvoice.nextNumber(ctx.tx as never, ctx.companyId, "invoice", invoice.issue_date);
    if (!drawn.ok) {
      const message = NUMBER_REFUSALS[drawn.code]!(resolutionText(drawn.resolution));
      throw new ProcessError("invalid_input", `${drawn.code}: ${message}`, { details: [message, ...(drawn.resolution ? [JSON.stringify(drawn.resolution)] : [])] });
    }
    if (!drawn.technicalKey || !drawn.resolution) {
      const message = NUMBER_REFUSALS.no_resolution!("");
      throw new ProcessError("invalid_input", `no_resolution: ${message}`, { details: [message] });
    }
    const facts = await readInvoiceFacts(ctx, invoice.party_id, []);
    if (!einvoice.taxIdUsable(facts.party.taxId, facts.party.documentType ?? undefined)) {
      refuseState("customer_tax_id_missing", [`El cliente ${facts.party.name} no tiene un número de identificación que la factura electrónica pueda llevar: corrígelo en el tercero`]);
    }
    const [company] = await ctx.tx<{ tax_id: string | null; country_code: string }[]>`select tax_id, country_code from kernel.companies where id = ${ctx.companyId}`;
    const settings = await settingsOf(ctx);
    const taxes = await ctx.tx<{ family: "IVA" | "INC" | "OTHER"; code: string; rate: string | null; base: string; amount: string }[]>`
      select family, code, rate::text, base::text, amount::text from invoicing.invoice_taxes where invoice_id = ${invoice.id} order by seq`;
    const fresh = await readInvoice(ctx, invoice.id);
    const time = await issueTime(ctx);
    const cufe = einvoice.invoiceCode({
      number: drawn.full,
      issueDate: invoice.issue_date,
      issueTime: time,
      taxed: {
        subtotal: num(fresh.subtotal),
        total: num(fresh.total),
        taxes: taxes.map((t) => ({ family: t.family, code: t.code, rate: t.rate === null ? null : num(t.rate), base: num(t.base), amount: num(t.amount) })),
      },
      issuerTaxId: company?.tax_id ?? "",
      customerTaxId: facts.party.taxId,
      ...(facts.party.documentType ? { customerDocumentType: facts.party.documentType } : {}),
      technicalKey: drawn.technicalKey,
      environment: settings.dianEnvironment,
    });
    // The DIAN environment the CUFE names is frozen with it (Task 19 fix round 1): the QR, the document and the transport follow it.
    // Whether it is an export is frozen here (Task 18 fix round 1): a buyer of another country than the company's; its notes and its
    // resends follow it, never the buyer's master data of later.
    const isExport = (facts.party.countryCode ?? company!.country_code) !== company!.country_code;
    await ctx.tx`
      update invoicing.invoices set number = ${drawn.full}, prefix = ${drawn.prefix}, consecutive = ${drawn.number}, cufe = ${cufe},
             issue_time = ${time}, resolution = ${ctx.tx.json(drawn.resolution as never)}, is_export = ${isExport},
             dian_environment = ${settings.dianEnvironment}
      where id = ${invoice.id}`;
    return drawn.full;
  },
  async post(ctx, record) {
    const invoice = await readInvoice(ctx, record.id as string);
    await ctx.tx`update invoicing.invoice_recommendations set status = 'resolved', resolved_at = now() where invoice_id = ${invoice.id} and status = 'open'`;
    const settings = await settingsOf(ctx);
    const costCenterId = invoice.cost_center_id ?? settings.defaultCostCenterId;
    const rate = num(invoice.exchange_rate);
    const lines = await linesOf(ctx, invoice.id);
    const taxes = await ctx.tx<{ ledger_code: string; rate: string | null; base: string; amount: string }[]>`
      select ledger_code, rate::text, base::text, amount::text from invoicing.invoice_taxes where invoice_id = ${invoice.id} order by seq`;
    const facts = await readInvoiceFacts(ctx, invoice.party_id, []);
    // Amounts in the company currency (the ledger's), the one rounding rule: the receivable is their sum and is the invoice's total_company.
    const company = companyAmounts(lines, taxes, rate);
    const revenue = company.revenue.map(({ line, subtotal }) => ({ subtotal, categoryId: line.category_id, ...(costCenterId ? { costCenterId } : {}) }));
    const taxLines = company.taxLines.map(({ tax, amount, base }) => ({ code: tax.ledger_code, rate: tax.rate === null ? null : num(tax.rate), amount, base }));
    const total = company.total;
    await ctx.tx`update invoicing.invoices set stage = 'issued', issued_at = now(), total_company = ${total} where id = ${invoice.id}`;
    await emitAndPostStrict(ctx, INVOICE_ISSUED, {
      date: invoice.issue_date,
      number: invoice.number,
      invoiceId: invoice.id,
      dueDate: invoice.due_date,
      customer: { partyId: invoice.party_id, legalName: facts.party.name },
      ...(costCenterId ? { costCenterId } : {}),
      totals: { total },
      lines: revenue,
      taxes: taxLines,
      currency: invoice.currency,
      exchangeRate: rate,
      cufe: invoice.cufe,
      origin: invoice.origin,
      orderIds: [...new Set(lines.flatMap((l) => (l.order_id ? [l.order_id] : [])))],
      deliveryIds: [...new Set(lines.flatMap((l) => (l.delivery_id ? [l.delivery_id] : [])))],
    }, { requireRule: true });
  },
};

export const INVOICE_PROCESSES = [
  invoiceCreate, invoiceUpdate, invoiceReprice, invoiceFromOrders, invoiceIssue, invoiceVoid, invoiceConsult, invoiceLineConsult, invoiceTaxConsult, recommendationConsult,
];
