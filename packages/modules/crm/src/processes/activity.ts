import { defineProcess, ProcessError, type EventConsumer } from "@erp/kernel";
import { z } from "zod";
import { ACTIVITY_KINDS } from "../entities";
import { id, idInput, refuse, rejectErrors, visibleParties } from "./common";

// Actividades (plan 2B Task 11): a call, a meeting, an e-mail, a note, a task or a payment logged against an oportunidad, a prospecto or a
// tercero. sistema: the only writes are crm.activity.create (a user's own entry, or the consumer of invoicing.invoice.paid). An activity an
// event logs carries its source record (`sourceEntity` + `sourceId`), which is its idempotency key: a redelivered event finds the first one.

const FEATURE = "crm.activities";

export const activityInput = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  subject: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  opportunityId: id.optional(),
  leadId: id.optional(),
  partyId: id.optional(),
  /** The salesperson it belongs to (default: the deal's owner, else the caller). */
  ownerId: id.optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  /** Already done when logged (a call that happened); tasks are logged open. */
  done: z.boolean().default(false),
  /** The record that caused it (`invoicing.invoice` + the invoice id): at most one activity per source record. */
  sourceEntity: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).optional(),
  sourceId: id.optional(),
}).strict().refine((v) => (v.sourceEntity === undefined) === (v.sourceId === undefined), "El origen lleva entidad e id");

const output = z.object({ id: z.string(), created: z.boolean() });

export const activityCreate = defineProcess({
  id: "crm.activity.create",
  module: "crm",
  kind: "create",
  feature: FEATURE,
  description: "Registra una actividad (llamada, reunión, correo, nota, tarea o pago) de una oportunidad, un prospecto o un tercero",
  input: activityInput,
  output,
  handler: async (ctx, input) => {
    const errors: string[] = [];
    if (!input.opportunityId && !input.leadId && !input.partyId) errors.push("La actividad es de una oportunidad, un prospecto o un tercero");
    rejectErrors("crm.activity.create", errors);
    if (input.sourceEntity && input.sourceId) {
      const [existing] = await ctx.tx<{ id: string }[]>`
        select id from crm.activities where source_entity = ${input.sourceEntity} and source_id = ${input.sourceId}`;
      if (existing) return { id: existing.id, created: false };
    }
    let ownerId = input.ownerId ?? null;
    let partyId = input.partyId ?? null;
    if (input.opportunityId) {
      const [opportunity] = await ctx.tx<{ owner_id: string | null; party_id: string | null }[]>`
        select owner_id, party_id from crm.opportunities where id = ${input.opportunityId}`;
      if (!opportunity) throw new ProcessError("not_found", `opportunity ${input.opportunityId} not found`);
      ownerId ??= opportunity.owner_id;
      partyId ??= opportunity.party_id;
    }
    if (input.leadId) {
      const [lead] = await ctx.tx`select 1 from crm.leads where id = ${input.leadId} and deleted_at is null`;
      if (!lead) refuse("invalid_lead", ["El prospecto no existe"]);
    }
    if (partyId && !(await visibleParties(ctx, [partyId])).has(partyId)) refuse("invalid_party", ["El tercero no existe o no es visible"]);
    // A person's own entry belongs to them; one an event logs belongs to the deal's owner, and to nobody when the deal has none.
    if (ownerId === null && ctx.origin !== "event") ownerId = ctx.userId;
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into crm.activities ${ctx.tx({
        company_id: ctx.companyId,
        kind: input.kind,
        subject: input.subject,
        notes: input.notes ?? null,
        opportunity_id: input.opportunityId ?? null,
        lead_id: input.leadId ?? null,
        party_id: partyId,
        owner_id: ownerId,
        due_at: input.dueAt ?? null,
        done_at: input.done ? new Date() : null,
        source_entity: input.sourceEntity ?? null,
        source_id: input.sourceId ?? null,
      })}
      returning id`;
    return { id: row!.id, created: true };
  },
});

export const activityConsult = defineProcess({
  id: "crm.activity.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una actividad con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: activityId }) => {
    const [row] = await ctx.tx`select * from crm.v_activities where id = ${activityId}`;
    if (!row) throw new ProcessError("not_found", `activity ${activityId} not found`);
    return { ...row, id: activityId };
  },
});

/** The payload fields the consumer reads of invoicing.invoice.paid (see the contract in opportunity.ts). */
const invoicePaid = z.looseObject({
  invoiceId: id,
  number: z.string().optional(),
  opportunityId: id.optional(),
  partyId: id.optional(),
  amount: z.number().optional(),
});

/** Consumer of invoicing.invoice.paid: a payment activity on the deal (or on the tercero) the invoice came from, once per invoice. */
export const onInvoicePaid: EventConsumer = async (ctx, payload) => {
  const parsed = invoicePaid.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `invoicing.invoice.paid payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { invoiceId, number, opportunityId, partyId, amount } = parsed.data;
  // An invoice that came from no deal and names no tercero has nothing to log against.
  if (!opportunityId && !partyId) return;
  await ctx.runProcess("crm.activity.create", {
    kind: "payment",
    subject: number ? `Factura ${number} pagada` : "Factura pagada",
    ...(amount !== undefined ? { notes: `Valor pagado: ${amount.toLocaleString("es-CO", { maximumFractionDigits: 2 })}` } : {}),
    ...(opportunityId ? { opportunityId } : {}),
    ...(partyId ? { partyId } : {}),
    done: true,
    sourceEntity: "invoicing.invoice",
    sourceId: invoiceId,
  });
};

export const ACTIVITY_PROCESSES = [activityCreate, activityConsult];
