import { customData, defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { LEAD_SOURCES, LEAD_STAGES } from "../entities";
import { assertWritable, defined, extra, followLifecycle, id, idInput, idOutput, initialLifecycle, money, refuse, rejectErrors, visibleParties } from "./common";
import { createOpportunity, opportunityInput } from "./opportunity";

// Prospectos (plan 2B Task 11): maestros (entity types spec §2.2) created Grabado (Pendiente de Aprobación when the company requires it).
// crm.lead.convert turns one into a customer: the tercero is created by core's own create process, run nested in this transaction with ctx.runProcess (core.party.create, so the DIAN
// validation of the country pack applies and missing data sets dian_status; the new tercero is NOT invoice_ready until its DIAN data and
// files are complete) and an oportunidad starts in the default embudo. The caller must be allowed to run core.party.create, as if they
// had run it themselves.

const FEATURE = "crm.leads";

const text = (max: number) => z.string().trim().max(max);
const leadFields = {
  name: z.string().trim().min(1).max(160),
  contactName: text(120).optional(),
  email: z.email().max(200).optional(),
  phoneCc: z.string().trim().regex(/^\+?\d{1,3}$/, "Indicativo telefónico no válido").optional(),
  phone: z.string().trim().regex(/^\d{4,15}$/, "El teléfono lleva de 4 a 15 dígitos").optional(),
  personType: z.enum(["1", "2"]).optional(),
  documentType: z.string().trim().min(1).max(4).optional(),
  documentNumber: z.string().trim().min(1).max(20).optional(),
  source: z.enum(LEAD_SOURCES),
  ownerId: id.optional(),
  notes: text(2000).optional(),
  isActive: z.boolean(),
};
/** The stages a person moves a prospecto through; `converted` belongs to crm.lead.convert. */
const MANUAL_STAGES = LEAD_STAGES.filter((s) => s !== "converted") as [string, ...string[]];
const LEAD_WRITABLE = ["name", "contact_name", "email", "phone_cc", "phone", "person_type", "document_type", "document_number", "source", "owner_id", "notes", "is_active", "extra", "extra_free"];

const columns = (input: Partial<z.output<z.ZodObject<typeof leadFields>>> & { stage?: string }) =>
  defined({
    name: input.name,
    contact_name: input.contactName,
    email: input.email,
    phone_cc: input.phoneCc?.replace("+", ""),
    phone: input.phone,
    person_type: input.personType,
    document_type: input.documentType,
    document_number: input.documentNumber,
    source: input.source,
    stage: input.stage,
    owner_id: input.ownerId,
    notes: input.notes,
    is_active: input.isActive,
  });

const validExtra = async (ctx: ProcessContext, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined) => {
  const custom = await customData(ctx, "crm.lead", stored, given);
  rejectErrors(processId, custom.errors);
  return given === undefined ? {} : { extra: ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) };
};

function phoneTogether(processId: string, cc: unknown, phone: unknown): void {
  if ((cc === undefined || cc === null) !== (phone === undefined || phone === null)) rejectErrors(processId, ["El teléfono lleva indicativo y número juntos"]);
}

export const leadCreate = defineProcess({
  id: "crm.lead.create",
  module: "crm",
  kind: "create",
  feature: FEATURE,
  description: "Crea un prospecto (empresa o persona que podría ser cliente) con su contacto y, si ya se conocen, sus datos de documento",
  input: z.object({ ...leadFields, source: leadFields.source.default("other"), isActive: leadFields.isActive.default(true), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { extra: given, ...input }) => {
    phoneTogether("crm.lead.create", input.phoneCc, input.phone);
    const extraJson = await validExtra(ctx, "crm.lead.create", null, given);
    const state = await initialLifecycle(ctx, "crm.lead");
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into crm.leads ${ctx.tx({ company_id: ctx.companyId, stage: "new", ...columns({ ...input, ownerId: input.ownerId ?? ctx.userId }), ...extraJson, ...state })}
      returning id`;
    return { id: row!.id };
  },
});

export const leadUpdate = defineProcess({
  id: "crm.lead.update",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  description: "Actualiza un prospecto: contacto, documento, origen, vendedor, notas y etapa (nuevo, contactado, calificado o descartado); uno convertido no cambia",
  input: z.object(leadFields).partial().extend({ id, stage: z.enum(MANUAL_STAGES).optional(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: leadId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from crm.leads where id = ${leadId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `lead ${leadId} not found`);
    if (current.stage === "converted") refuse("lead_converted", ["El prospecto ya fue convertido en cliente: no cambia"]);
    phoneTogether("crm.lead.update", input.phoneCc ?? current.phone_cc, input.phone ?? current.phone);
    const extraJson = await validExtra(ctx, "crm.lead.update", current.extra as Record<string, unknown> | null, given);
    const set = { ...columns(input), ...extraJson };
    if (Object.keys(set).length > 0) await ctx.tx`update crm.leads set ${ctx.tx(set)} where id = ${leadId}`;
    await followLifecycle(ctx, "crm.lead", leadId, current);
    return { id: leadId };
  },
});

export const leadConvert = defineProcess({
  id: "crm.lead.convert",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  emits: ["core.party.created"],
  description:
    "Convierte un prospecto en cliente: crea el tercero con la validación DIAN de núcleo (queda sin factura electrónica lista hasta completar sus datos y archivos) y una oportunidad en el embudo predeterminado",
  input: z.object({
    id,
    /** Document data the prospecto may still lack; it overrides what the prospecto has. */
    personType: z.enum(["1", "2"]).optional(),
    documentType: z.string().trim().min(1).max(4).optional(),
    documentNumber: z.string().trim().min(1).max(20).optional(),
    firstName: text(60).optional(),
    firstSurname: text(60).optional(),
    secondSurname: text(60).optional(),
    otherNames: text(60).optional(),
    /** Link an existing tercero instead of creating one. */
    partyId: id.optional(),
    /** The oportunidad: its title (default: the prospecto's name), amount, embudo and expected close. */
    opportunityTitle: z.string().trim().min(1).max(160).optional(),
    amount: money.optional(),
    pipelineId: id.optional(),
    expectedClose: opportunityInput.shape.expectedClose,
  }).strict(),
  output: z.object({
    id: z.string(),
    partyId: z.string(),
    opportunityId: z.string(),
    opportunityNumber: z.string().nullable(),
    dianStatus: z.string().nullable(),
    invoiceReady: z.boolean().nullable(),
  }),
  handler: async (ctx, input) => {
    const [lead] = await ctx.tx`select * from crm.leads where id = ${input.id} and deleted_at is null for update`;
    if (!lead) throw new ProcessError("not_found", `lead ${input.id} not found`);
    if (lead.stage === "converted") refuse("lead_converted", ["El prospecto ya fue convertido en cliente"]);
    if (lead.stage === "discarded") refuse("lead_discarded", ["El prospecto está descartado: vuelve a calificarlo antes de convertirlo"]);

    let partyId = input.partyId;
    if (partyId) {
      if (!(await visibleParties(ctx, [partyId])).has(partyId)) refuse("invalid_party", ["El tercero no existe o no es visible"]);
      // The deal is with a customer: a tercero that is only a supplier or an employee is not one.
      const [kinds] = await ctx.tx<{ kind: string[] }[]>`select kind from core.v_parties where id = ${partyId}`;
      if (!kinds?.kind?.includes("customer")) refuse("party_not_customer", ["El tercero no es cliente: márcalo como cliente antes de abrirle una oportunidad"]);
    } else {
      // The tercero is created by core's own process, run nested in this one: the caller needs the right to run core.party.create (the
      // kernel refuses `forbidden` otherwise), and core's validation, audit entry and event apply as if they had run it themselves.
      const personType = input.personType ?? lead.person_type;
      const documentType = input.documentType ?? lead.document_type;
      const documentNumber = input.documentNumber ?? lead.document_number;
      const missing = [
        ...(personType ? [] : ["el tipo de persona"]),
        ...(documentType ? [] : ["el tipo de documento"]),
        ...(documentNumber ? [] : ["el número de documento"]),
      ];
      if (missing.length > 0) rejectErrors("crm.lead.convert", [`Para crear el cliente falta ${missing.join(", ")}`]);
      // A persona natural (tipo 2) is named by its names, not by a razón social.
      if (personType === "2" && !(input.firstName && input.firstSurname)) rejectErrors("crm.lead.convert", ["Para crear a una persona natural indica su primer nombre y su primer apellido"]);
      const partyInput = defined({
        kind: ["customer"],
        personType,
        documentType,
        documentNumber,
        legalName: lead.name,
        firstName: input.firstName,
        firstSurname: input.firstSurname,
        secondSurname: input.secondSurname,
        otherNames: input.otherNames,
        invoiceEmail: lead.email ?? undefined,
        phoneCc: lead.phone_cc ?? undefined,
        phone: lead.phone ?? undefined,
        contactName: lead.contact_name ?? undefined,
      });
      if (!ctx.runProcess) throw new ProcessError("handler_failed", "crm.lead.convert needs a context that can run core.party.create");
      const party = await ctx.runProcess<{ id: string }>("core.party.create", partyInput);
      // A nested run an admin set to «continue» resolves undefined after queuing its failure: the conversion needs the tercero, so it fails
      // and rolls back as with no configuration (plan 2B Task 32, decisions item 68).
      if (!party) throw new ProcessError("handler_failed", "crm.lead.convert needs the tercero core.party.create did not create");
      partyId = party.id;
    }

    const opportunity = await createOpportunity(ctx, {
      title: input.opportunityTitle ?? lead.name,
      partyId,
      leadId: input.id,
      pipelineId: input.pipelineId,
      ownerId: lead.owner_id ?? undefined,
      amount: input.amount,
      currency: "COP",
      expectedClose: input.expectedClose,
      lines: [],
    });
    await ctx.tx`
      update crm.leads set stage = 'converted', converted_party_id = ${partyId}, converted_opportunity_id = ${opportunity.id}, converted_at = ${new Date()}
      where id = ${input.id}`;
    await followLifecycle(ctx, "crm.lead", input.id, lead);
    const party = (await visibleParties(ctx, [partyId])).get(partyId);
    return {
      id: input.id,
      partyId,
      opportunityId: opportunity.id,
      opportunityNumber: opportunity.number,
      dianStatus: party?.dianStatus ?? null,
      invoiceReady: party?.invoiceReady ?? null,
    };
  },
});

export const leadConsult = defineProcess({
  id: "crm.lead.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un prospecto con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: leadId }) => {
    const [row] = await ctx.tx`select * from crm.v_leads where id = ${leadId}`;
    if (!row) throw new ProcessError("not_found", `lead ${leadId} not found`);
    return { ...row, id: leadId, extra: await visibleExtra(ctx, "crm.lead", row.extra) };
  },
});

/** The validate hook of a prospecto (Grabar, Aprobar): the stored record passes the create schema and the custom fields. */
export const leadHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `crm.lead.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, LEAD_WRITABLE);
    const parsed = z.object({ name: leadFields.name, email: leadFields.email, phone: leadFields.phone }).safeParse({
      name: record.name, email: record.email ?? undefined, phone: record.phone ?? undefined,
    });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    phoneTogether(processId, record.phone_cc, record.phone);
    const custom = await customData(ctx, "crm.lead", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

export const LEAD_PROCESSES = [leadCreate, leadUpdate, leadConvert, leadConsult];
