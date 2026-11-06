import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the crm module (design §8, plan 2B Task 11). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`); enum values read
// `crm.values.*`. Field names are the column names; the masked views `crm.v_<table>` of migration 0079 are generated from these definitions
// (entities.test.ts fails when they drift). Prospectos, embudos, oportunidades, actividades and cotizaciones have record pages (`recordPage`, plan 2B
// Task 14b). Prospectos (leads) and embudos (pipelines, with their etapas as lines) are maestros; an
// oportunidad is a documento that numbers on save and neither posts nor waits for approval; an actividad is sistema: only the crm
// processes write it (the user's own «registrar actividad» and the consumer of invoicing.invoice.paid).

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "crm",
    schema: "crm",
    table,
    label: `entity.${id}`,
    entityType,
    displayField,
    defaultSort: { field: displayField, dir: "asc" },
    fields: fields(fieldsOf(id)),
    ...extra,
  };
}

/** Columns every company table of the module carries after its own (rule 7). */
const trailer = (f: F): FieldDef[] => [
  f("extra", "json", { sortable: false }),
  f("extra_free", "json", { sortable: false }),
  f("created_at", "datetime"),
  f("updated_at", "datetime"),
];

/** A maestro's lifecycle state (entity types spec §5.1). */
export const MAESTRO_STATES = ["draft", "saved", "pending", "rejected", "approved"];
/** A documento's lifecycle state (spec §5.1). */
export const DOCUMENT_STATES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];

/** Where a prospecto came from. */
export const LEAD_SOURCES = ["web", "referral", "event", "call", "social", "other"] as const;
/** Where a prospecto is: converted ones have a tercero and an oportunidad; discarded ones are history. */
export const LEAD_STAGES = ["new", "contacted", "qualified", "converted", "discarded"] as const;
/** What an etapa of an embudo means: open ones move the deal on, `won` and `lost` close it. */
export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
/** How an oportunidad stands (derived from its etapa's kind). */
export const OUTCOMES = ["open", "won", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** What an actividad is. `payment` is logged by the consumer of invoicing.invoice.paid. */
export const ACTIVITY_KINDS = ["call", "meeting", "email", "note", "task", "payment"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const maestroLifecycle = (f: F): FieldDef[] => [
  f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
];

const ref = (entityId: string, display: string): Pick<FieldDef, "ref"> => ({ ref: { entity: entityId, display } });
const party = ref("core.party", "legal_name");
const pipelineRef = ref("crm.pipeline", "name");
const stageRef = ref("crm.stage", "name");
const leadRef = ref("crm.lead", "name");
const opportunityRef = ref("crm.opportunity", "number");

// Prospecto: someone who may become a customer. Convert makes the tercero (through core's create process, so DIAN validation applies) and
// the oportunidad. The document columns are optional until then.
export const leadEntity: EntityDef = entity("crm.lead", "maestro", "leads", "name", (f) => [
  f("seq", "number", { required: true }),
  f("name", "text", { required: true, searchable: true }),
  f("contact_name", "text", { searchable: true }),
  f("email", "text", { searchable: true }),
  f("phone_cc", "text"),
  f("phone", "text", { searchable: true }),
  f("person_type", "text"),
  f("document_type", "text"),
  f("document_number", "text", { searchable: true }),
  f("source", "enum", { required: true, enumValues: [...LEAD_SOURCES], valuesKey: "crm.values.lead_source" }),
  f("stage", "enum", { required: true, enumValues: [...LEAD_STAGES], valuesKey: "crm.values.lead_stage" }),
  f("owner_id", "uuid"),
  f("notes", "text"),
  f("converted_party_id", "ref", party),
  f("converted_opportunity_id", "ref", opportunityRef),
  f("converted_at", "datetime"),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { recordPage: true, importKey: ["name", "email"], cloneReset: ["seq", "email", "stage", "converted_party_id", "converted_opportunity_id", "converted_at"] });

// Embudo: the ordered etapas a deal goes through. One embudo per company is the default one (new oportunidades start in its first etapa).
export const pipelineEntity: EntityDef = entity("crm.pipeline", "maestro", "pipelines", "name", (f) => [
  f("seq", "number", { required: true }),
  f("code", "text", { required: true, searchable: true }),
  f("name", "text", { required: true, searchable: true }),
  f("description", "text", { searchable: true }),
  f("is_default", "boolean", { required: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], {
  typed: { lines: { entity: "crm.stage", parentField: "pipeline_id" } },
  recordPage: true,
  importKey: ["code"],
  cloneReset: ["seq", "code", "is_default"],
});

// Etapa of an embudo (line): its order, its win probability and whether it closes the deal.
export const stageEntity: EntityDef = entity("crm.stage", "lines", "stages", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("pipeline_id", "ref", { required: true, ...pipelineRef }),
  f("line_no", "number", { required: true }),
  f("name", "text", { required: true, searchable: true }),
  f("probability", "number", { required: true }),
  f("kind", "enum", { required: true, enumValues: [...STAGE_KINDS], valuesKey: "crm.values.stage_kind" }),
  ...trailer(f),
]);

// Oportunidad: a deal with a prospect or customer, in one etapa of one embudo. A documento numbered OP- on save that never posts and never
// waits for approval; moving it through the embudo (crm.opportunity.stage_move) is audited with the etapa before and after. A salesperson
// sees only their own (owner_id); whoever may run crm.opportunity.reassign sees all (migration 0079).
export const opportunityEntity: EntityDef = entity("crm.opportunity", "documento", "opportunities", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("title", "text", { required: true, searchable: true }),
  f("party_id", "ref", party),
  f("lead_id", "ref", leadRef),
  f("pipeline_id", "ref", { required: true, ...pipelineRef }),
  f("stage_id", "ref", { required: true, ...stageRef }),
  f("owner_id", "uuid"),
  f("amount", "money", { required: true }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("probability", "number", { required: true }),
  f("expected_close", "date"),
  f("outcome", "enum", { required: true, enumValues: [...OUTCOMES], valuesKey: "crm.values.outcome" }),
  f("closed_at", "datetime"),
  f("lost_reason", "text"),
  // The order that won it (sales.order.confirmed carries it back as `opportunityId`).
  f("order_id", "uuid"),
  f("description", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "crm.opportunity_line", parentField: "opportunity_id" },
    ownFlags: { requiresApproval: "crm.opportunity.own_flags.requires_approval", posts: "crm.opportunity.own_flags.posts" },
  },
  processIds: { create: "crm.opportunity.create" },
  recordPage: true,
  cloneReset: ["seq", "number", "outcome", "closed_at", "lost_reason", "order_id"],
  defaultSort: { field: "seq", dir: "desc" },
});

// Línea de oportunidad: what the deal is about (a product, or a free description), the quantity and the price talked about. Written with the
// oportunidad; the quote (Task 12) starts from them.
export const opportunityLineEntity: EntityDef = entity("crm.opportunity_line", "lines", "opportunity_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("opportunity_id", "ref", { required: true, ...opportunityRef }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", ref("core.product", "description")),
  f("description", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("unit_price", "money", { required: true }),
  ...trailer(f),
]);

// Actividad: a call, a meeting, a note, a task or a payment logged against an oportunidad, a prospecto or a tercero. `source_*` is the
// idempotency key of the ones an event logs (one per invoice).
export const activityEntity: EntityDef = entity("crm.activity", "sistema", "activities", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("kind", "enum", { required: true, enumValues: [...ACTIVITY_KINDS], valuesKey: "crm.values.activity_kind" }),
  f("subject", "text", { required: true, searchable: true }),
  f("notes", "text"),
  f("opportunity_id", "ref", opportunityRef),
  f("lead_id", "ref", leadRef),
  f("party_id", "ref", party),
  f("owner_id", "uuid"),
  f("due_at", "datetime"),
  f("done_at", "datetime"),
  f("source_entity", "text"),
  f("source_id", "uuid"),
  ...trailer(f),
], { recordPage: true, defaultSort: { field: "seq", dir: "desc" } });

/**
 * Where a cotización stands commercially (beside its lifecycle status): open while it is being written, sent to the customer, accepted by
 * them (its lines are then locked and an order can start from it, Task 13), or expired (past its validity, or closed by hand).
 */
export const QUOTE_STAGES = ["open", "sent", "accepted", "expired"] as const;
export type QuoteStage = (typeof QUOTE_STAGES)[number];

const quoteRef = ref("crm.quote", "number");
const priceListRef = ref("core.price_list", "name");

// Cotización (plan 2B Task 12, design §8: quotes are crm's): what the company offers a customer, line by line, priced from the customer's
// price list (sales' resolveLinePrice) and taxed by the country pack (computeTaxes). A documento numbered COT- on save that never posts; it
// waits for approval (Pendiente de Aprobación) when a line's discount is above the company's threshold (crm.settings), so its approval flag
// is its own (ownFlags). Every line's product and the customer must be invoice_ready (rule 10). Sending, accepting and expiring it are
// processes of their own; an accepted cotización's lines never change. A salesperson sees only their own (owner_id, migration 0082).
export const quoteEntity: EntityDef = entity("crm.quote", "documento", "quotes", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("party_id", "ref", { required: true, ...party }),
  f("opportunity_id", "ref", opportunityRef),
  f("owner_id", "uuid"),
  f("issue_date", "date", { required: true }),
  f("valid_until", "date", { required: true }),
  f("stage", "enum", { required: true, enumValues: [...QUOTE_STAGES], valuesKey: "crm.values.quote_stage" }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("subtotal", "money", { required: true }),
  f("discount_total", "money", { required: true }),
  f("tax_total", "money", { required: true }),
  f("total", "money", { required: true }),
  // The total in the company currency (rule 8): total × exchange rate.
  f("total_company", "money", { required: true }),
  f("max_discount_pct", "number", { required: true }),
  f("sent_at", "datetime"),
  f("accepted_at", "datetime"),
  f("expired_at", "datetime"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "crm.quote_line", parentField: "quote_id" },
    ownFlags: { requiresApproval: "crm.quote.own_flags.requires_approval", posts: "crm.quote.own_flags.posts" },
  },
  processIds: { create: "crm.quote.create" },
  recordPage: true,
  // A copy is a new offer: it starts today with the company's validity (Task 14b fix 1).
  cloneReset: ["seq", "number", "stage", "issue_date", "valid_until", "sent_at", "accepted_at", "expired_at"],
  defaultSort: { field: "seq", dir: "desc" },
});

// Línea de cotización: a product, its quantity, the unit price (from a price list, or given), the discount and the taxes computed by the
// country pack. Written by crm.quote.create / update only, never once the cotización is accepted (migration 0082).
export const quoteLineEntity: EntityDef = entity("crm.quote_line", "lines", "quote_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("quote_id", "ref", { required: true, ...quoteRef }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("description", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("unit_price", "money", { required: true }),
  f("price_list_id", "ref", priceListRef),
  f("discount_pct", "number", { required: true }),
  f("discount", "money", { required: true }),
  f("base", "money", { required: true }),
  f("iva_rate", "text"),
  f("iva", "money", { required: true }),
  f("inc_rate", "text"),
  f("inc", "money", { required: true }),
  f("other_taxes", "money", { required: true }),
  f("total", "money", { required: true }),
  ...trailer(f),
]);

// Parámetros de CRM: one row per company. A cotización with a line discount above `quote_approval_discount_pct` waits for approval (none:
// no cotización does); `quote_validity_days` is how long a new one is valid by default.
export const crmSettingsEntity: EntityDef = entity("crm.settings", "parametro", "settings", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("quote_approval_discount_pct", "number"),
  f("quote_validity_days", "number", { required: true }),
  ...trailer(f),
]);

export const CRM_ENTITIES: EntityDef[] = [leadEntity, pipelineEntity, stageEntity, opportunityEntity, opportunityLineEntity, activityEntity, quoteEntity, quoteLineEntity, crmSettingsEntity];
