import { defineProcess, ProcessError, type ConsumerContext, type EventConsumer, type ProcessContext, type Tx } from "@erp/kernel";
import { z } from "zod";
import type { InvoiceCreation } from "../entities";
import { FEATURE_INVOICES, id, INVOICE_CREATED, num, pendingDeliveryLines, settingsOf, today, type DraftLine } from "./common";
import { createInvoice, readInvoice } from "./invoice";

// Automatic invoices (OD-2, main design §22.25): the Parámetros' invoice_creation says when an invoice is created by itself.
//   - manual (default): never; «Por facturar» lists what shipped and is not invoiced (invoicing.invoice.from_orders);
//   - on_delivery: each shipped entrega (sales.delivery.shipped) is invoiced with exactly what shipped and is not yet invoiced;
//   - on_order_confirmation: each confirmed pedido (sales.order.confirmed) is invoiced whole; its entregas then add nothing to invoice.
// The consumers run the same processes a person does: invoicing.invoice.auto_create (origin event: the Borrador, idempotent by its source,
// one per entrega or pedido) and invoicing.invoice.issue. A customer or product not invoice_ready, or a refusal of the issue (no resolution, a
// closed period…), never fails the entrega or the pedido: the Borrador stays and invoicing.invoice.recommend writes why
// (invoicing.invoice_recommendations), until someone issues it. A refusal of the creation itself (what the entrega or pedido bills is already
// invoiced, the pedido was cancelled or is not firm, the tercero is not a customer…) leaves nothing to recommend on: auto_create answers
// `skipped` with the reason (kept in its audit row) instead of failing the event into the dead letter (fix round 1), and raises a kernel
// recommendation for whoever may create invoices (owner item 26, plan 2B Task 38): one open per entrega or pedido and reason (a redelivery
// merges into it), closed by the invoice that later bills that entrega or pedido (invoice.ts createInvoice). Either way the invoice
// is dated on the day it is issued; the entrega's or the pedido's date is its service_date (ruling, fix round 1).

const RECOMMEND = "invoicing.invoice.recommend";
/** Who is told when no Borrador could be created: whoever may create the invoice by hand. */
const SKIPPED_AUDIENCE = "invoicing.invoice.create";

const trigger = z.discriminatedUnion("trigger", [
  z.object({ trigger: z.literal("delivery"), deliveryId: id }).strict(),
  z.object({ trigger: z.literal("order"), orderId: id }).strict(),
]);

const autoOutput = z.object({
  id: z.string().nullable(),
  created: z.boolean(),
  stage: z.string().nullable(),
  notReady: z.array(z.string()),
  /** A creation refused for good (over_invoicing, order_cancelled, invalid_party…): nothing was written; the reason and its details. */
  skipped: z.string().optional(),
  details: z.array(z.string()).optional(),
});

export const invoiceAutoCreate = defineProcess({
  id: "invoicing.invoice.auto_create",
  module: "invoicing",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  emits: [INVOICE_CREATED],
  description:
    "Crea la factura en borrador de una entrega despachada o de un pedido confirmado cuando la empresa factura automáticamente; solo lo ejecuta el evento de ventas",
  input: trigger,
  output: autoOutput,
  handler: async (ctx, input) => {
    const settings = await settingsOf(ctx);
    const wanted: InvoiceCreation = input.trigger === "delivery" ? "on_delivery" : "on_order_confirmation";
    if (settings.invoiceCreation !== wanted) return { id: null, created: false, stage: null, notReady: [] };
    const source = input.trigger === "delivery" ? `delivery:${input.deliveryId}` : `order:${input.orderId}`;
    const [existing] = await ctx.tx<{ id: string; stage: string }[]>`select id, stage from invoicing.invoices where company_id = ${ctx.companyId} and auto_source = ${source}`;
    if (existing) return { id: existing.id, created: false, stage: existing.stage, notReady: [] };

    let partyId: string;
    let currency: string;
    let exchangeRate: number;
    const issueDate = await today(ctx);
    let serviceDate: string;
    let costCenterId: string | null = null;
    let lines: DraftLine[];
    if (input.trigger === "delivery") {
      const pending = await pendingDeliveryLines(ctx, { deliveryId: input.deliveryId });
      if (pending.length === 0) return { id: null, created: false, stage: null, notReady: [] };
      const [delivery] = await ctx.tx<{ delivery_date: string; cost_center_id: string | null }[]>`
        select delivery_date::text, cost_center_id from sales.v_invoice_delivery_lines where delivery_id = ${input.deliveryId} limit 1`;
      const [order] = await ctx.tx<{ exchange_rate: string }[]>`select exchange_rate::text from sales.v_invoice_order_lines where order_id = ${pending[0]!.order_id} limit 1`;
      partyId = pending[0]!.party_id;
      currency = pending[0]!.currency;
      exchangeRate = num(order?.exchange_rate ?? 1);
      serviceDate = delivery?.delivery_date ?? issueDate;
      costCenterId = delivery?.cost_center_id ?? null;
      lines = pending.map((p) => ({
        productId: p.product_id, qty: num(p.pending_qty), unitPrice: num(p.unit_price), discountPct: num(p.discount_pct), description: p.description,
        orderId: p.order_id, orderLineId: p.order_line_id, deliveryId: p.delivery_id, deliveryLineId: p.delivery_line_id,
      }));
    } else {
      const orderLines = await ctx.tx<{ id: string; order_id: string; party_id: string; currency: string; exchange_rate: string; product_id: string; description: string | null; qty: string; unit_price: string; discount_pct: string; order_date: string }[]>`
        select id, order_id, party_id, currency, exchange_rate::text, product_id, description, qty::text, unit_price::text, discount_pct::text, order_date::text
        from sales.v_invoice_order_lines where order_id = ${input.orderId} order by line_no`;
      if (orderLines.length === 0) return { id: null, created: false, stage: null, notReady: [] };
      const first = orderLines[0]!;
      partyId = first.party_id;
      currency = first.currency;
      exchangeRate = num(first.exchange_rate);
      serviceDate = first.order_date;
      lines = orderLines.map((l) => ({
        productId: l.product_id, qty: num(l.qty), unitPrice: num(l.unit_price), discountPct: num(l.discount_pct), description: l.description,
        orderId: l.order_id, orderLineId: l.id,
      }));
    }
    let created: Awaited<ReturnType<typeof createInvoice>>;
    try {
      created = await createInvoice(ctx, {
        partyId, issueDate, serviceDate, currency, exchangeRate, ...(costCenterId ? { costCenterId } : {}), lines,
        paymentForm: "2",
        origin: wanted,
        autoSource: source,
        allowNotReady: true,
      });
    } catch (error) {
      // A refusal (a ProcessError thrown before anything is written: the checks run before the insert) is final for this entrega or pedido.
      if (!(error instanceof ProcessError) || (error.code !== "invalid_input" && error.code !== "invalid_state")) throw error;
      const details = Array.isArray(error.details) ? error.details.map((d) => (typeof d === "string" ? d : JSON.stringify(d))) : [error.message];
      const skipped = error.message.split(":")[0]!;
      await raiseSkipped(ctx, input, skipped);
      return { id: null, created: false, stage: null, notReady: [], skipped, details };
    }
    if (created.notReady.length > 0) {
      await writeRecommendation(ctx.tx, ctx.companyId, created.id, "not_invoice_ready", created.notReady);
    }
    return { id: created.id, created: true, stage: "draft", notReady: created.notReady };
  },
});

/** The refusal codes a recommendation names as its reason (a code of the refusal helpers); anything else reads as `refused`. */
const REASON = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * Raises the recommendation of a refused automatic creation: about the entrega or the pedido it was for, its number a param of that
 * document's `number` field (masked for a role that does not see it), the refusal code as the reason.
 */
async function raiseSkipped(ctx: ProcessContext, input: z.output<typeof trigger>, code: string): Promise<void> {
  const subject = input.trigger === "delivery" ? { entity: "sales.delivery", id: input.deliveryId } : { entity: "sales.order", id: input.orderId };
  const [doc] = input.trigger === "delivery"
    ? await ctx.tx<{ number: string | null }[]>`select delivery_number as number from sales.v_invoice_delivery_lines where delivery_id = ${input.deliveryId} limit 1`
    : await ctx.tx<{ number: string | null }[]>`select order_number as number from sales.v_invoice_order_lines where order_id = ${input.orderId} limit 1`;
  await ctx.recommendations?.raise({
    audienceProcess: SKIPPED_AUDIENCE,
    subject,
    reason: REASON.test(code) ? code : "refused",
    titleKey: "invoicing.recommendation.auto_skipped.title",
    bodyKey: "invoicing.recommendation.auto_skipped.body",
    params: { document: { value: doc?.number ?? null, entity: subject.entity, field: "number" } },
  });
}

async function writeRecommendation(tx: Tx, companyId: string, invoiceId: string, code: string, details: string[]): Promise<void> {
  const message = `La factura automática quedó en borrador: ${details[0] ?? code}`.slice(0, 2000);
  const [open] = await tx<{ id: string }[]>`select id from invoicing.invoice_recommendations where invoice_id = ${invoiceId} and status = 'open' for update`;
  if (open) {
    await tx`update invoicing.invoice_recommendations set code = ${code}, message = ${message}, details = ${tx.json(details as never)} where id = ${open.id}`;
    return;
  }
  await tx`insert into invoicing.invoice_recommendations ${tx({ company_id: companyId, invoice_id: invoiceId, code, message, details: tx.json(details as never) })}`;
}

export const invoiceRecommend = defineProcess({
  id: RECOMMEND,
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_INVOICES,
  origins: ["event"],
  description: "Registra por qué una factura automática quedó en borrador (cliente o producto no listo, emisión rechazada); solo lo ejecuta el evento de ventas",
  input: z.object({ invoiceId: id, code: z.string().trim().min(1).max(100), details: z.array(z.string().max(2000)).min(1).max(50) }).strict(),
  output: z.object({ recorded: z.boolean() }),
  handler: async (ctx, input) => {
    const invoice = await readInvoice(ctx, input.invoiceId);
    if (invoice.stage !== "draft") return { recorded: false };
    await writeRecommendation(ctx.tx, ctx.companyId, invoice.id, input.code, input.details);
    return { recorded: true };
  },
});

/** The company's mode, read before running anything (a company in manual mode writes no audit row per entrega or pedido). */
async function modeOf(ctx: ConsumerContext): Promise<InvoiceCreation> {
  const [row] = await ctx.sql<{ invoice_creation: InvoiceCreation }[]>`select invoice_creation from invoicing.settings where company_id = ${ctx.companyId}`;
  return row?.invoice_creation ?? "manual";
}

/** Creates the automatic Borrador and issues it when it is ready; a refusal of the issue becomes a recommendation. */
async function autoInvoice(ctx: ConsumerContext, input: z.input<typeof trigger>): Promise<void> {
  const created = (await ctx.runProcess("invoicing.invoice.auto_create", input)) as z.output<typeof autoOutput>;
  if (!created.id || created.stage !== "draft" || created.notReady.length > 0) return;
  try {
    await ctx.runProcess("invoicing.invoice.issue", { id: created.id, idempotencyKey: "auto" });
  } catch (error) {
    // Only a refusal (the transaction of the issue rolled back whole): the Borrador stays with the reason. Anything else is the dispatcher's.
    if (!(error instanceof ProcessError) || (error.code !== "invalid_input" && error.code !== "invalid_state")) throw error;
    const details = Array.isArray(error.details) ? error.details.map((d) => (typeof d === "string" ? d : JSON.stringify(d))) : [error.message];
    await ctx.runProcess(RECOMMEND, { invoiceId: created.id, code: error.message.split(":")[0]!.slice(0, 100), details: details.slice(0, 50).map((d) => d.slice(0, 2000)) });
  }
}

const shippedPayload = z.looseObject({ deliveryId: id });
const confirmedPayload = z.looseObject({ orderId: id });

/** Consumer of sales.delivery.shipped (OD-2 on_delivery). */
export const onDeliveryShipped: EventConsumer = async (ctx, payload) => {
  const parsed = shippedPayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `sales.delivery.shipped payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if ((await modeOf(ctx)) !== "on_delivery") return;
  await autoInvoice(ctx, { trigger: "delivery", deliveryId: parsed.data.deliveryId });
};

/** Consumer of sales.order.confirmed (OD-2 on_order_confirmation). */
export const onOrderConfirmed: EventConsumer = async (ctx, payload) => {
  const parsed = confirmedPayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `sales.order.confirmed payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if ((await modeOf(ctx)) !== "on_order_confirmation") return;
  await autoInvoice(ctx, { trigger: "order", orderId: parsed.data.orderId });
};

export const AUTO_PROCESSES = [invoiceAutoCreate, invoiceRecommend];
