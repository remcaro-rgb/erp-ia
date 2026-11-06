import { defineProcess, ProcessError, runLifecycle, type EventConsumer, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { opportunityEntity, type Outcome } from "../entities";
import { assertWritable, defined, id, idInput, idOutput, money, num, refuse, rejectErrors, visibleParties } from "./common";
import { defaultPipeline, stagesOf, type StageRow } from "./pipeline";

// Oportunidades (plan 2B Task 11, design §8.1): a documento numbered OP- on save that never posts and never waits for approval (ownFlags).
// It sits in one etapa of one embudo; the etapa's kind decides its outcome (open / won / lost) and its probability is the etapa's.
// Moving it (stage_move) is a process of its own: the row audit keeps the etapa, probability and outcome before and after (rule 16), and
// crm.opportunity.stage_moved goes to the outbox. A salesperson sees only their own (migration 0079); crm.opportunity.reassign, which only
// a sales manager is given, hands one to someone else and is what lets its holder see them all.
//
// Won by an order: the consumer of sales.order.confirmed (Tasks 12–13 emit it) reads `opportunityId` from the event payload. The quote
// (Task 12) and the order (Task 13) carry that id from the oportunidad they come from, and the order's confirmed event repeats it:
//   sales.order.confirmed   { orderId: uuid, opportunityId?: uuid, … }
//   invoicing.invoice.paid  { invoiceId: uuid, number?: string, opportunityId?: uuid, partyId?: uuid, amount?: number, … }
// An event without `opportunityId` (an order that did not come from a deal) is ignored.

const FEATURE = "crm.opportunities";
export const OPPORTUNITY_STAGE_MOVED = "crm.opportunity.stage_moved";
export const OPPORTUNITY_WON = "crm.opportunity.won";
export const OPPORTUNITY_LOST = "crm.opportunity.lost";
const NUMBER_PREFIX = "OP-";

const date = z.iso.date();
const currency = z.string().regex(/^[A-Z]{3}$/, "Moneda ISO 4217 de tres letras");

const OPPORTUNITY_WRITABLE = ["title", "amount", "expected_close", "description", "extra", "extra_free"];

export const opportunityLineInput = z.object({
  /** A product of core (a good or a service); without one, the description says what it is. */
  productId: id.optional(),
  description: z.string().trim().min(1).max(300).optional(),
  qty: z.number().finite().positive().refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales"),
  unitPrice: money.default(0),
}).strict().refine((line) => line.productId !== undefined || line.description !== undefined, "La línea lleva un producto o una descripción");

export const opportunityInput = z.object({
  title: z.string().trim().min(1).max(160),
  /** The tercero the deal is with; without one, the prospecto (`leadId`) it came from. */
  partyId: id.optional(),
  leadId: id.optional(),
  /** The embudo (default: the company's default one) and the open etapa it starts in (default: the first). */
  pipelineId: id.optional(),
  stageId: id.optional(),
  /** The salesperson who owns it (default: the caller). */
  ownerId: id.optional(),
  /** The value of the deal; without it, the sum of the lines (quantity × price). */
  amount: money.optional(),
  currency: currency.default("COP"),
  expectedClose: date.optional(),
  description: z.string().trim().max(500).optional(),
  /** What the deal is about (products and prices talked about); the quote starts from them. */
  lines: z.array(opportunityLineInput).max(200).default([]),
}).strict();

const createdOutput = z.object({ id: z.string(), number: z.string().nullable(), status: z.string(), pipelineId: z.string(), stageId: z.string() });

interface OpportunityRow {
  id: string;
  number: string | null;
  status: string;
  pipeline_id: string;
  stage_id: string;
  owner_id: string | null;
  party_id: string | null;
  lead_id: string | null;
  outcome: Outcome;
  probability: string;
  order_id: string | null;
}

/** The oportunidad locked for the step, or `not_found` (an oportunidad of someone else is invisible to a salesperson, as if it did not exist). */
async function lockOpportunity(ctx: ProcessContext, opportunityId: string): Promise<OpportunityRow> {
  const [row] = await ctx.tx<OpportunityRow[]>`
    select id, number, status, pipeline_id, stage_id, owner_id, party_id, lead_id, outcome, probability::text, order_id
    from crm.opportunities where id = ${opportunityId} for update`;
  if (!row) throw new ProcessError("not_found", `opportunity ${opportunityId} not found`);
  return row;
}

/**
 * Creates and saves an oportunidad as the caller (shared by crm.opportunity.create and crm.lead.convert): checks the tercero and the
 * embudo, starts it in an open etapa and takes the OP- number on Grabar.
 */
export async function createOpportunity(ctx: ProcessContext, input: z.output<typeof opportunityInput>): Promise<z.output<typeof createdOutput>> {
  const errors: string[] = [];
  if (!input.partyId && !input.leadId) errors.push("La oportunidad es con un tercero o con un prospecto");
  if (input.partyId && !(await visibleParties(ctx, [input.partyId])).has(input.partyId)) errors.push("El tercero no existe o no es visible");
  if (input.leadId) {
    const [lead] = await ctx.tx`select 1 from crm.leads where id = ${input.leadId} and deleted_at is null`;
    if (!lead) errors.push("El prospecto no existe");
  }
  const productIds = [...new Set(input.lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  if (productIds.length > 0) {
    const found = await ctx.tx<{ id: string }[]>`select id from core.v_product_stock where id = any(${productIds}::uuid[])`;
    const known = new Set(found.map((r) => r.id));
    input.lines.forEach((l, i) => {
      if (l.productId && !known.has(l.productId)) errors.push(`Línea ${i + 1}: el producto no existe o no es visible`);
    });
  }
  rejectErrors("crm.opportunity.create", errors);

  let pipeline: { id: string; stages: StageRow[] };
  if (input.pipelineId) {
    const [found] = await ctx.tx`select 1 from crm.pipelines where id = ${input.pipelineId} and deleted_at is null and is_active`;
    if (!found) refuse("invalid_pipeline", ["El embudo no existe o no está activo"]);
    pipeline = { id: input.pipelineId, stages: await stagesOf(ctx, input.pipelineId) };
  } else {
    pipeline = await defaultPipeline(ctx);
  }
  const stage = input.stageId ? pipeline.stages.find((s) => s.id === input.stageId) : pipeline.stages.find((s) => s.kind === "open");
  if (!stage) refuse("invalid_stage", [input.stageId ? "La etapa no es del embudo" : "El embudo no tiene etapas abiertas"]);
  if (stage.kind !== "open") refuse("invalid_stage", ["Una oportunidad nueva empieza en una etapa abierta"]);

  const [header] = await ctx.tx<{ id: string }[]>`
    insert into crm.opportunities ${ctx.tx({
      company_id: ctx.companyId,
      title: input.title,
      party_id: input.partyId ?? null,
      lead_id: input.leadId ?? null,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      owner_id: input.ownerId ?? ctx.userId,
      amount: input.amount ?? input.lines.reduce((sum, l) => sum + Math.round(l.qty * l.unitPrice * 100) / 100, 0),
      currency: input.currency,
      expected_close: input.expectedClose ?? null,
      description: input.description ?? null,
      probability: num(stage.probability),
      outcome: "open",
      // An oportunidad neither waits for approval nor posts itself (ownFlags).
      requires_approval: false,
      posts: false,
    })}
    returning id`;
  if (input.lines.length > 0) {
    await ctx.tx`
      insert into crm.opportunity_lines ${ctx.tx(input.lines.map((l, i) => ({
        company_id: ctx.companyId,
        opportunity_id: header!.id,
        line_no: i + 1,
        product_id: l.productId ?? null,
        description: l.description ?? null,
        qty: l.qty,
        unit_price: l.unitPrice,
      })))}`;
  }
  const saved = await runLifecycle(ctx, ctx.registry.entity(opportunityEntity.id), header!.id, "save");
  return { id: header!.id, number: saved.number ?? null, status: saved.status, pipelineId: pipeline.id, stageId: stage.id };
}

export const opportunityCreate = defineProcess({
  id: "crm.opportunity.create",
  module: "crm",
  kind: "create",
  feature: FEATURE,
  description: "Crea una oportunidad de venta en la primera etapa abierta del embudo (o la etapa que se indique) y le asigna su número",
  input: opportunityInput,
  output: createdOutput,
  handler: (ctx, input) => createOpportunity(ctx, input),
});

export const opportunityStageMove = defineProcess({
  id: "crm.opportunity.stage_move",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  emits: [OPPORTUNITY_STAGE_MOVED, OPPORTUNITY_WON, OPPORTUNITY_LOST],
  description:
    "Mueve una oportunidad a otra etapa de su embudo; una etapa ganada o perdida la cierra (la perdida pide el motivo) y una cerrada ya no se mueve",
  input: z.object({ id, stageId: id, lostReason: z.string().trim().min(1).max(500).optional() }).strict(),
  output: z.object({ id: z.string(), stageId: z.string(), outcome: z.enum(["open", "won", "lost"]), changed: z.boolean() }),
  handler: async (ctx, { id: opportunityId, stageId, lostReason }) => {
    const opportunity = await lockOpportunity(ctx, opportunityId);
    if (opportunity.status === "voided") refuse("invalid_opportunity_state", [`La oportunidad ${opportunity.number ?? opportunity.id} está anulada`]);
    const [target] = await ctx.tx<{ id: string; pipeline_id: string; name: string; probability: string; kind: Outcome }[]>`
      select id, pipeline_id, name, probability::text, kind from crm.stages where id = ${stageId}`;
    if (!target || target.pipeline_id !== opportunity.pipeline_id) refuse("invalid_stage", ["La etapa no es del embudo de la oportunidad"]);
    // The same etapa again is a replay: nothing changes, nothing is written.
    if (target.id === opportunity.stage_id) return { id: opportunityId, stageId, outcome: opportunity.outcome, changed: false };
    if (opportunity.outcome !== "open") {
      refuse("opportunity_closed", [`La oportunidad ${opportunity.number ?? opportunity.id} está ${opportunity.outcome === "won" ? "ganada" : "perdida"}: ya no se mueve`]);
    }
    if (target.kind === "lost" && !lostReason) refuse("lost_reason_required", ["Indica el motivo por el que se perdió la oportunidad"]);
    const closing = target.kind !== "open";
    await ctx.tx`
      update crm.opportunities set
        stage_id = ${target.id}, probability = ${num(target.probability)}, outcome = ${target.kind},
        closed_at = ${closing ? new Date() : null}, lost_reason = ${target.kind === "lost" ? lostReason! : null}
      where id = ${opportunityId}`;
    const moved = { opportunityId, number: opportunity.number, pipelineId: opportunity.pipeline_id, fromStageId: opportunity.stage_id, toStageId: target.id, outcome: target.kind };
    await ctx.emit(OPPORTUNITY_STAGE_MOVED, moved);
    if (target.kind === "won") await ctx.emit(OPPORTUNITY_WON, { ...moved, orderId: null });
    if (target.kind === "lost") await ctx.emit(OPPORTUNITY_LOST, { ...moved, reason: lostReason });
    return { id: opportunityId, stageId: target.id, outcome: target.kind, changed: true };
  },
});

export const opportunityReassign = defineProcess({
  id: "crm.opportunity.reassign",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  description: "Asigna una oportunidad a otro vendedor; quien puede reasignar ve todas las oportunidades y actividades de la empresa",
  input: z.object({ id, ownerId: id }).strict(),
  output: idOutput,
  handler: async (ctx, { id: opportunityId, ownerId }) => {
    const opportunity = await lockOpportunity(ctx, opportunityId);
    const [member] = await ctx.tx<{ ok: boolean }[]>`select crm.is_company_member(${ownerId}) as ok`;
    if (!member?.ok) refuse("invalid_owner", ["El vendedor no pertenece a la empresa"]);
    if (opportunity.owner_id !== ownerId) {
      await ctx.tx`update crm.opportunities set owner_id = ${ownerId} where id = ${opportunityId}`;
      // The open activities of the deal follow it.
      await ctx.tx`update crm.activities set owner_id = ${ownerId} where opportunity_id = ${opportunityId} and done_at is null`;
    }
    return { id: opportunityId };
  },
});

export const opportunityMarkWon = defineProcess({
  id: "crm.opportunity.mark_won",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  origins: ["event"],
  emits: [OPPORTUNITY_WON],
  recordAccess: { entity: "crm.opportunity", idField: "opportunityId", right: "modify" },
  description: "Cierra una oportunidad como ganada porque su pedido se confirmó (solo la ejecuta el consumidor de sales.order.confirmed)",
  input: z.object({ opportunityId: id, orderId: id }).strict(),
  output: z.object({ id: z.string(), changed: z.boolean(), reason: z.string().optional() }),
  handler: async (ctx, { opportunityId, orderId }) => {
    const opportunity = await lockOpportunity(ctx, opportunityId);
    // A redelivery, a second order of the same deal and a voided deal change nothing.
    if (opportunity.status === "voided") return { id: opportunityId, changed: false, reason: "voided" };
    if (opportunity.outcome === "won") return { id: opportunityId, changed: false, reason: opportunity.order_id === orderId ? "already_won" : "won_by_another_order" };
    const stages = await stagesOf(ctx, opportunity.pipeline_id);
    const won = stages.find((s) => s.kind === "won");
    await ctx.tx`
      update crm.opportunities set
        outcome = 'won', closed_at = ${new Date()}, probability = 100, lost_reason = null, order_id = ${orderId},
        stage_id = ${won?.id ?? opportunity.stage_id}
      where id = ${opportunityId}`;
    await ctx.emit(OPPORTUNITY_WON, { opportunityId, number: opportunity.number, pipelineId: opportunity.pipeline_id, fromStageId: opportunity.stage_id, toStageId: won?.id ?? opportunity.stage_id, outcome: "won", orderId });
    return { id: opportunityId, changed: true };
  },
});

export const opportunityConsult = defineProcess({
  id: "crm.opportunity.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una oportunidad con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: opportunityId }) => {
    const [row] = await ctx.tx`select * from crm.v_opportunities where id = ${opportunityId}`;
    if (!row) throw new ProcessError("not_found", `opportunity ${opportunityId} not found`);
    return { ...row, id: opportunityId };
  },
});

/**
 * The hooks of an oportunidad: Grabar changes only its commercial data and only while it is open; the number is drawn on save from the
 * company counter (prefix OP-). Its etapa, owner and outcome move with their own processes, never with Grabar.
 */
export const opportunityHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { previous, data }) {
    if (mode !== "save") return;
    assertWritable("crm.opportunity.save", data, OPPORTUNITY_WRITABLE);
    if (previous.status !== "draft" && previous.outcome !== "open" && data && Object.keys(defined(data)).length > 0) {
      refuse("opportunity_closed", ["Una oportunidad cerrada no cambia"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select crm.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

/** The payload fields the consumer reads of sales.order.confirmed (Task 13 emits it with the order's `opportunityId`). */
const orderConfirmed = z.looseObject({ orderId: id, opportunityId: id.optional() });

/** Consumer of sales.order.confirmed: the oportunidad the order came from is won (system user, origin event). */
export const onOrderConfirmed: EventConsumer = async (ctx, payload) => {
  const parsed = orderConfirmed.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `sales.order.confirmed payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if (!parsed.data.opportunityId) return;
  await ctx.runProcess("crm.opportunity.mark_won", { opportunityId: parsed.data.opportunityId, orderId: parsed.data.orderId });
};

export const opportunityLineConsult = defineProcess({
  id: "crm.opportunity_line.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de oportunidad con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from crm.v_opportunity_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `opportunity line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

export const OPPORTUNITY_PROCESSES = [opportunityCreate, opportunityStageMove, opportunityReassign, opportunityMarkWon, opportunityConsult, opportunityLineConsult];
