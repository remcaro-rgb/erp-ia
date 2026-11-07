import { countryPack, defineProcess, genericProcess, ProcessError, runLifecycle, writeSnapshot, type ProcessContext, type ProcessDef, type TaxLineInput, type TypedHooks } from "@erp/kernel";
import { assertSaleReady, lineDiscount, resolveLineDiscount, resolveLinePrice, type ResolvedPrice, type SaleParty, type SaleProduct } from "@erp/module-sales";
import { z } from "zod";
import { quoteEntity, type QuoteStage } from "../entities";
import { assertWritable, defined, id, idInput, money, num, refuse } from "./common";
import { quoteSettings } from "./settings";

// Cotizaciones (plan 2B Task 12, design §8 and §8.1 step 0): a documento numbered COT- on save that never posts. Each line is priced by
// sales' resolveLinePrice (the customer's price list, then the default list, then the product's list price; a price given by hand wins),
// discounted by a percent, and taxed by the company's country pack (computeTaxes, rule 5: no country rule here). The customer and every
// product must be invoice_ready (rule 10, §5.17; sales' assertSaleReady says why not). A line discount above the company's threshold
// (crm.settings) makes the cotización wait for approval (Pendiente de Aprobación) before it can be sent or accepted.
//
// Commercial stage (beside the lifecycle status): open → sent → accepted, or expired. Accept is allowed straight from open, never sent
// (intended: a customer may accept on the spot), as long as valid_until has not passed; expire needs no passed valid_until (the
// salesperson closes an offer the customer turned down) and applies to an open or sent cotización. Accepting emits crm.quote.accepted, the start of an
// order (Task 13: sales.order.from_quote copies its prices), and locks the lines and amounts (migration 0082 triggers). The payload repeats
// the oportunidad the cotización came from as `opportunityId` (omitted when there is none, never null: the contract of Task 11, so the
// order and its sales.order.confirmed can carry it on and the CRM marks the deal won).

const FEATURE = "crm.quotes";
export const QUOTE_SENT = "crm.quote.sent";
export const QUOTE_ACCEPTED = "crm.quote.accepted";
export const QUOTE_EXPIRED = "crm.quote.expired";
const NUMBER_PREFIX = "COT-";

/** What Grabar may change of a cotización (its lines and amounts change through crm.quote.update). */
const QUOTE_WRITABLE = ["notes", "valid_until", "extra", "extra_free"];
/** The lifecycle statuses whose lines may change (entity types D3: Borrador, Grabado, No aprobado). */
const EDITABLE = new Set(["draft", "saved", "rejected"]);

const date = z.iso.date();
const percent = z.number().finite().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
const qty = z.number().finite().positive().refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales");

export const quoteLineInput = z.object({
  productId: id,
  qty,
  /** The unit price; absent, the customer's price list, the default list or the product's list price gives it. */
  unitPrice: money.optional(),
  /** Percent off the line; absent, the customer's standing discount. */
  discountPct: percent.optional(),
  /** What the line prints besides the product's own description. */
  description: z.string().trim().min(1).max(300).optional(),
}).strict();

const quoteOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  stage: z.string(),
  requiresApproval: z.boolean(),
  subtotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
});
type QuoteOutput = z.output<typeof quoteOutput>;

/** Refuses a step the cotización's state does not allow: `invalid_state` whose message leads with the code. */
function refuseState(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_state", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

interface QuoteRow {
  id: string;
  number: string | null;
  status: string;
  stage: QuoteStage;
  requires_approval: boolean;
  party_id: string;
  opportunity_id: string | null;
  owner_id: string | null;
  issue_date: string;
  valid_until: string;
  currency: string;
  exchange_rate: string;
  subtotal: string;
  tax_total: string;
  total: string;
}

/** The cotización locked for the step, or `not_found` (one of another salesperson is invisible, as if it did not exist). */
async function lockQuote(ctx: ProcessContext, quoteId: string): Promise<QuoteRow> {
  const [row] = await ctx.tx<QuoteRow[]>`
    select id, number, status, stage, requires_approval, party_id, opportunity_id, owner_id, issue_date::text, valid_until::text, currency,
           exchange_rate::text, subtotal::text, tax_total::text, total::text
    from crm.quotes where id = ${quoteId} for update`;
  if (!row) throw new ProcessError("not_found", `quote ${quoteId} not found`);
  return row;
}

const label = (q: Pick<QuoteRow, "number" | "id">) => q.number ?? q.id;

/** The company's today (its time zone) as an ISO date. */
async function today(ctx: ProcessContext): Promise<string> {
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
 * Prices, discounts and taxes `lines` for `partyId` on `issueDate` in `currency`, after the invoice-readiness gate of the customer and
 * every product. The taxes are the company's country pack's (`computeTaxes`, per-line rounding).
 */
async function priceLines(ctx: ProcessContext, partyId: string, lines: z.output<typeof quoteLineInput>[], issueDate: string, currency: string): Promise<Priced> {
  const { party, products } = await assertSaleReady(ctx, partyId, lines.map((l) => l.productId));
  const priceErrors: string[] = [];
  const resolved: { unitPrice: number; priceListId: string | null; discountPct: number; product: SaleProduct; given: z.output<typeof quoteLineInput> }[] = [];
  // The customer's standing discount does not depend on the price: a line priced by hand (or one no list prices, as in another currency)
  // still carries it, and it still counts against the approval threshold.
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
      priceListId: found?.priceListId ?? null,
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

/** Whether a cotización whose largest line discount is `maxDiscountPct` waits for approval under the company's threshold. */
const needsApproval = (threshold: number | null, maxDiscountPct: number) => threshold !== null && maxDiscountPct > threshold;

const totals = (p: Priced, exchangeRate: number) => ({
  subtotal: p.subtotal,
  discount_total: p.discountTotal,
  tax_total: p.taxTotal,
  total: p.total,
  total_company: round2(p.total * exchangeRate),
  max_discount_pct: p.maxDiscountPct,
});

async function insertLines(ctx: ProcessContext, quoteId: string, lines: PricedLine[]): Promise<void> {
  if (lines.length === 0) return;
  await ctx.tx`insert into crm.quote_lines ${ctx.tx(lines.map((l) => ({ company_id: ctx.companyId, quote_id: quoteId, ...l })))}`;
}

/** After the cotización's lines or amounts changed: Grabar (and, when it now needs approval, Enviar a aprobación); the result's state. */
async function saveAndRoute(ctx: ProcessContext, quoteId: string, from: string, requiresApproval: boolean, changed: boolean): Promise<{ status: string; number: string | null }> {
  const entity = ctx.registry.entity(quoteEntity.id);
  const saved = await runLifecycle(ctx, entity, quoteId, "save");
  // Grabado → Grabado writes no snapshot of its own; the process changed the lines, so the version is kept here (spec §8).
  if (changed && from === saved.status && from !== "draft") await writeSnapshot(ctx, entity, quoteId, saved.status, null);
  let status: string = saved.status;
  if (requiresApproval && status === "saved") status = (await runLifecycle(ctx, entity, quoteId, "submit")).status;
  const [row] = await ctx.tx<{ number: string | null }[]>`select number from crm.quotes where id = ${quoteId}`;
  return { status, number: row?.number ?? null };
}

const output = (quoteId: string, state: { status: string; number: string | null }, stage: string, requiresApproval: boolean, p: { subtotal: number; taxTotal: number; total: number }): QuoteOutput => ({
  id: quoteId,
  number: state.number,
  status: state.status,
  stage,
  requiresApproval,
  subtotal: p.subtotal,
  taxTotal: p.taxTotal,
  total: p.total,
});

export const quoteCreate = defineProcess({
  id: "crm.quote.create",
  module: "crm",
  kind: "create",
  feature: FEATURE,
  description:
    "Crea una cotización para un cliente listo para facturar: precia cada línea con la lista de precios del cliente (o la predeterminada, o el precio de lista), calcula impuestos y totales, le asigna su número y la deja en aprobación si un descuento supera el tope de la empresa",
  input: z.object({
    partyId: id,
    /** The oportunidad it comes from (its tercero must be the customer). */
    opportunityId: id.optional(),
    /** The salesperson who owns it (default: the caller). */
    ownerId: id.optional(),
    /** Default: today in the company's time zone. */
    issueDate: date.optional(),
    /** Default: the issue date plus the company's validity days (crm.settings, 30). */
    validUntil: date.optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "Moneda ISO 4217 de tres letras").optional(),
    exchangeRate: z.number().finite().positive().optional(),
    notes: z.string().trim().max(2000).optional(),
    lines: z.array(quoteLineInput).min(1, "La cotización lleva al menos una línea").max(200),
  }).strict(),
  output: quoteOutput,
  handler: async (ctx, input) => {
    const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
    const companyCurrency = company!.currency_code.trim();
    const currency = input.currency ?? companyCurrency;
    if (currency !== companyCurrency && input.exchangeRate === undefined) refuse("exchange_rate_required", [`Indica la tasa de cambio de ${currency} a ${companyCurrency}`]);
    const exchangeRate = currency === companyCurrency ? 1 : input.exchangeRate!;
    if (input.opportunityId) {
      const [deal] = await ctx.tx<{ party_id: string | null; status: string }[]>`select party_id, status from crm.opportunities where id = ${input.opportunityId}`;
      if (!deal || deal.status === "voided") refuse("invalid_opportunity", ["La oportunidad no existe, no es visible o está anulada"]);
      if (deal.party_id && deal.party_id !== input.partyId) refuse("invalid_opportunity", ["La oportunidad es de otro tercero"]);
    }
    if (input.ownerId) {
      const [member] = await ctx.tx<{ ok: boolean }[]>`select crm.is_company_member(${input.ownerId}) as ok`;
      if (!member?.ok) refuse("invalid_owner", ["El vendedor no pertenece a la empresa"]);
    }
    const settings = await quoteSettings(ctx);
    const issueDate = input.issueDate ?? (await today(ctx));
    const [due] = await ctx.tx<{ d: string }[]>`select (${issueDate}::date + ${settings.validityDays}::int)::text as d`;
    const validUntil = input.validUntil ?? due!.d;
    if (validUntil < issueDate) refuse("invalid_validity", ["La cotización vence antes de su fecha"]);

    const priced = await priceLines(ctx, input.partyId, input.lines, issueDate, currency);
    const requiresApproval = needsApproval(settings.approvalDiscountPct, priced.maxDiscountPct);
    const [header] = await ctx.tx<{ id: string }[]>`
      insert into crm.quotes ${ctx.tx({
        company_id: ctx.companyId,
        party_id: input.partyId,
        opportunity_id: input.opportunityId ?? null,
        owner_id: input.ownerId ?? ctx.userId,
        issue_date: issueDate,
        valid_until: validUntil,
        stage: "open",
        currency,
        exchange_rate: exchangeRate,
        notes: input.notes ?? null,
        ...totals(priced, exchangeRate),
        // The cotización sets its own flags (ownFlags): approval by the discount threshold, never posted.
        requires_approval: requiresApproval,
        posts: false,
      })}
      returning id`;
    await insertLines(ctx, header!.id, priced.lines);
    const state = await saveAndRoute(ctx, header!.id, "draft", requiresApproval, false);
    return output(header!.id, state, "open", requiresApproval, priced);
  },
});

export const quoteUpdate = defineProcess({
  id: "crm.quote.update",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  description:
    "Cambia las líneas, la vigencia o las notas de una cotización abierta (Grabada o No aprobada): vuelve a preciar, recalcula impuestos y totales y la manda a aprobación si un descuento supera el tope",
  input: z.object({
    id,
    lines: z.array(quoteLineInput).min(1).max(200).optional(),
    validUntil: date.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  }).strict(),
  output: quoteOutput,
  handler: async (ctx, input) => {
    const quote = await lockQuote(ctx, input.id);
    if (quote.stage === "accepted") refuseState("quote_accepted", [`La cotización ${label(quote)} fue aceptada: sus líneas no cambian`]);
    if (quote.stage !== "open") refuseState("quote_not_open", [`La cotización ${label(quote)} ya fue enviada o venció: crea una nueva`]);
    if (!EDITABLE.has(quote.status)) refuseState("quote_not_editable", [`La cotización ${label(quote)} está en aprobación, aprobada o anulada: no cambia`]);
    const settings = await quoteSettings(ctx);
    const validUntil = input.validUntil ?? quote.valid_until;
    if (validUntil < quote.issue_date) refuse("invalid_validity", ["La cotización vence antes de su fecha"]);
    let priced: { subtotal: number; taxTotal: number; total: number } = { subtotal: num(quote.subtotal), taxTotal: num(quote.tax_total), total: num(quote.total) };
    let requiresApproval = quote.requires_approval;
    const set: Record<string, unknown> = defined({ valid_until: input.validUntil, notes: input.notes });
    if (input.lines) {
      const fresh = await priceLines(ctx, quote.party_id, input.lines, quote.issue_date, quote.currency);
      requiresApproval = needsApproval(settings.approvalDiscountPct, fresh.maxDiscountPct);
      Object.assign(set, totals(fresh, num(quote.exchange_rate)), { requires_approval: requiresApproval });
      await ctx.tx`delete from crm.quote_lines where quote_id = ${quote.id}`;
      await insertLines(ctx, quote.id, fresh.lines);
      priced = fresh;
    }
    if (Object.keys(set).length > 0) await ctx.tx`update crm.quotes set ${ctx.tx(set)} where id = ${quote.id}`;
    const state = await saveAndRoute(ctx, quote.id, quote.status, requiresApproval, Object.keys(set).length > 0);
    return output(quote.id, state, "open", requiresApproval, priced);
  },
});

/** Refuses sending or accepting a cotización whose lifecycle status does not allow it (waiting for, or refused, approval; voided). */
function assertCleared(quote: QuoteRow): void {
  if (quote.status === "pending") refuseState("quote_pending_approval", [`La cotización ${label(quote)} espera aprobación: se envía o se acepta una vez aprobada`]);
  if (quote.status === "rejected") refuseState("quote_rejected", [`La cotización ${label(quote)} no fue aprobada: corrígela y grábala de nuevo`]);
  if (quote.status === "voided") refuseState("quote_voided", [`La cotización ${label(quote)} está anulada`]);
  if (quote.requires_approval && quote.status !== "approved") refuseState("quote_pending_approval", [`La cotización ${label(quote)} necesita aprobación`]);
  if (quote.status !== "saved" && quote.status !== "approved") refuseState("quote_not_saved", [`La cotización ${label(quote)} no está grabada`]);
}

/** Keeps the version of a cotización whose stage changed (spec §8: every change past Borrador). */
async function snapshot(ctx: ProcessContext, quote: QuoteRow): Promise<void> {
  await writeSnapshot(ctx, ctx.registry.entity(quoteEntity.id), quote.id, quote.status as never, null);
}

const stageOutput = z.object({ id: z.string(), number: z.string().nullable(), stage: z.enum(["open", "sent", "accepted", "expired"]) });

export const quoteSend = defineProcess({
  id: "crm.quote.send",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  emits: [QUOTE_SENT],
  description: "Marca una cotización grabada (o aprobada, si necesitaba aprobación) como enviada al cliente; una en aprobación no se envía",
  input: idInput.strict(),
  output: stageOutput,
  handler: async (ctx, { id: quoteId }) => {
    const quote = await lockQuote(ctx, quoteId);
    if (quote.stage !== "open") refuseState("quote_not_open", [`La cotización ${label(quote)} ya fue ${quote.stage === "sent" ? "enviada" : quote.stage === "accepted" ? "aceptada" : "vencida"}`]);
    assertCleared(quote);
    await ctx.tx`update crm.quotes set stage = 'sent', sent_at = now() where id = ${quoteId}`;
    await snapshot(ctx, quote);
    await ctx.emit(QUOTE_SENT, { quoteId, number: quote.number, partyId: quote.party_id });
    return { id: quoteId, number: quote.number, stage: "sent" as const };
  },
});

export const quoteAccept = defineProcess({
  id: "crm.quote.accept",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  emits: [QUOTE_ACCEPTED],
  description:
    "Registra que el cliente aceptó una cotización vigente (grabada, o aprobada si lo necesitaba): sus líneas y valores quedan fijos y se avisa para crear el pedido",
  input: idInput.strict(),
  output: stageOutput,
  handler: async (ctx, { id: quoteId }) => {
    const quote = await lockQuote(ctx, quoteId);
    if (quote.stage === "accepted") refuseState("quote_accepted", [`La cotización ${label(quote)} ya fue aceptada`]);
    if (quote.stage === "expired") refuseState("quote_expired", [`La cotización ${label(quote)} venció`]);
    assertCleared(quote);
    if (quote.valid_until < (await today(ctx))) refuseState("quote_expired", [`La cotización ${label(quote)} venció el ${quote.valid_until}`]);
    const lines = await ctx.tx<{ id: string; line_no: number; product_id: string; description: string | null; qty: string; unit_price: string; price_list_id: string | null; discount_pct: string; discount: string; base: string; total: string }[]>`
      select id, line_no, product_id, description, qty::text, unit_price::text, price_list_id, discount_pct::text, discount::text, base::text, total::text
      from crm.quote_lines where quote_id = ${quoteId} order by line_no`;
    // Rule 10 holds at acceptance too: a customer or product that stopped being invoice_ready since the cotización was written is refused.
    await assertSaleReady(ctx, quote.party_id, lines.map((l) => l.product_id));
    await ctx.tx`update crm.quotes set stage = 'accepted', accepted_at = now() where id = ${quoteId}`;
    await snapshot(ctx, quote);
    await ctx.emit(QUOTE_ACCEPTED, {
      quoteId,
      number: quote.number,
      partyId: quote.party_id,
      ...(quote.opportunity_id ? { opportunityId: quote.opportunity_id } : {}),
      ownerId: quote.owner_id,
      issueDate: quote.issue_date,
      validUntil: quote.valid_until,
      currency: quote.currency,
      exchangeRate: num(quote.exchange_rate),
      subtotal: num(quote.subtotal),
      taxTotal: num(quote.tax_total),
      total: num(quote.total),
      lines: lines.map((l) => ({
        lineId: l.id,
        lineNo: l.line_no,
        productId: l.product_id,
        description: l.description,
        qty: num(l.qty),
        unitPrice: num(l.unit_price),
        priceListId: l.price_list_id,
        discountPct: num(l.discount_pct),
        discount: num(l.discount),
        base: num(l.base),
        total: num(l.total),
      })),
    });
    return { id: quoteId, number: quote.number, stage: "accepted" as const };
  },
});

export const quoteExpire = defineProcess({
  id: "crm.quote.expire",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  emits: [QUOTE_EXPIRED],
  description: "Da por vencida una cotización abierta o enviada (pasó su vigencia o el cliente no la tomó); una vencida ya no se acepta",
  input: idInput.strict(),
  output: stageOutput,
  handler: async (ctx, { id: quoteId }) => {
    const quote = await lockQuote(ctx, quoteId);
    if (quote.stage !== "open" && quote.stage !== "sent") refuseState("quote_closed", [`La cotización ${label(quote)} ya está ${quote.stage === "accepted" ? "aceptada" : "vencida"}`]);
    await ctx.tx`update crm.quotes set stage = 'expired', expired_at = now() where id = ${quoteId}`;
    await snapshot(ctx, quote);
    await ctx.emit(QUOTE_EXPIRED, { quoteId, number: quote.number, partyId: quote.party_id });
    return { id: quoteId, number: quote.number, stage: "expired" as const };
  },
});

export const quoteConsult = defineProcess({
  id: "crm.quote.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una cotización con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: quoteId }) => {
    const [row] = await ctx.tx`select * from crm.v_quotes where id = ${quoteId}`;
    if (!row) throw new ProcessError("not_found", `quote ${quoteId} not found`);
    return { ...row, id: quoteId };
  },
});

export const quoteLineConsult = defineProcess({
  id: "crm.quote_line.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de cotización con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from crm.v_quote_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `quote line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The hooks of a cotización: Grabar changes only its notes, validity and extra data, and only while it is open (its lines and amounts
 * change through crm.quote.update); Aprobar checks the customer and the products are still invoice_ready; the number is drawn on save from
 * the company counter (prefix COT-).
 */
export const quoteHooks: TypedHooks = {
  async validate(ctx, record, mode, { previous, data }) {
    if (mode === "approve") {
      const lines = await ctx.tx<{ product_id: string }[]>`select product_id from crm.quote_lines where quote_id = ${record.id} order by line_no`;
      await assertSaleReady(ctx, String(record.party_id), lines.map((l) => l.product_id));
      return;
    }
    if (mode !== "save" || !data) return;
    assertWritable("crm.quote.save", data, QUOTE_WRITABLE);
    if (previous.stage !== "open" && Object.keys(defined(data)).length > 0) {
      refuseState(previous.stage === "accepted" ? "quote_accepted" : "quote_not_open", ["Una cotización enviada, aceptada o vencida no cambia"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select crm.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

/**
 * Anular of the record frame: the generic `crm.quote.void` (same id, kind and audit action) that also marks the cotización's links as voided
 * (Task 31, design §22.27): a pedido made from it keeps its quote_to_order link, flagged, as the backfill (0125) marks it.
 */
const genericVoid = genericProcess({ id: quoteEntity.id, module: "crm", entityType: "documento" }, "void");
export const quoteVoid = {
  ...genericVoid,
  feature: FEATURE,
  handler: async (ctx: ProcessContext, input: unknown) => {
    const result = await genericVoid.handler(ctx, input);
    const { id: quoteId, reason } = input as { id: string; reason: string };
    await ctx.links!.markVoided({ entity: quoteEntity.id, id: quoteId, reason: reason.slice(0, 500) });
    return result;
  },
} as ProcessDef;

export const QUOTE_PROCESSES = [quoteVoid, quoteCreate, quoteUpdate, quoteSend, quoteAccept, quoteExpire, quoteConsult, quoteLineConsult];
