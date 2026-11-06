import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the costing module (design §8, plan 2B Task 8). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`); enum values
// read `costing.values.*`. Field names are the column names; the masked views `costing.v_<table>` of migration 0073 are generated from these
// definitions (entities.test.ts fails when they drift). All three are sistema: only the costing processes write them, from the inventory
// movements (weighted average only, OD-5: FIFO is phase 3 and adds layers of `method = fifo` without rewriting these rows).

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "costing",
    schema: "costing",
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

/** Costing methods. 2B ships weighted average only (OD-5); FIFO joins in phase 3 as a second value. */
export const COST_METHODS = ["average"] as const;
/**
 * The inventory movement kinds a cost event follows (inventory's `MOVEMENT_KINDS`), and `landed_cost`: a landed cost allocated to a
 * receipt's layer (Task 9) moves the layer's value, never its quantity (qty 0), and has no movement line of its own.
 */
export const EVENT_KINDS = ["receipt", "issue", "sale_issue", "sale_return", "adjustment", "transfer_out", "transfer_in", "landed_cost", "reversal"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
/**
 * Where the unit cost of a cost event came from: the movement line's own cost (a receipt, an adjustment), the layer's weighted average (an
 * issue), the product's standard cost (the first cost of an empty layer), the original issue (a sale return), the traslado's out leg (its in
 * leg), a landed cost allocated to a receipt, or nothing (no cost known: valued at 0 and flagged in cost_missing).
 */
export const COST_SOURCES = ["line", "average", "standard", "original_issue", "transfer", "none", "landed_cost", "reversal"] as const;
export type CostSource = (typeof COST_SOURCES)[number];
export const MISSING_STATUSES = ["open", "resolved"] as const;
/** A documento's lifecycle state (entity types spec §5.1). A landed cost is Contabilizado once allocated, Anulado once taken back. */
export const LANDED_COST_STATUSES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
/** How a landed cost is split over the lines of the receipt: by their value, their quantity or their weight. */
export const LANDED_BASES = ["value", "quantity", "weight"] as const;
export type LandedBasis = (typeof LANDED_BASES)[number];
/**
 * The account role the landed cost is credited to (what the user names: the supplier's invoice not yet paid, an advance, cash, a bank
 * or a suspense account). Each has its own default posting rule (costing.landed_cost.allocated, `when` on offset_role) because a rule
 * line names its role literally.
 */
export const OFFSET_ROLES = ["payable", "supplier_advances", "cash", "bank", "suspense"] as const;
export type OffsetRole = (typeof OFFSET_ROLES)[number];

const ref = (entityId: string, display: string): Pick<FieldDef, "ref"> => ({ ref: { entity: entityId, display } });
const product = ref("core.product", "description");
const warehouse = ref("inventory.warehouse", "name");
const movement = ref("inventory.movement", "number");
const landedCost = ref("costing.landed_cost", "number");
const party = ref("core.party", "legal_name");

// Capa de costo: the weighted average of one product in one bodega (qty on hand as costing knows it, its value and the average cost).
export const costLayerEntity: EntityDef = entity("costing.cost_layer", "sistema", "cost_layers", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("warehouse_id", "ref", { required: true, ...warehouse }),
  f("method", "enum", { required: true, enumValues: [...COST_METHODS], valuesKey: "costing.values.method" }),
  f("qty", "number", { required: true }),
  f("value", "money", { required: true, sensitivity: "confidential" }),
  f("avg_cost", "money", { sensitivity: "confidential" }),
  f("currency", "text", { required: true }),
  f("last_movement_id", "ref", movement),
  f("last_movement_seq", "number"),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

// Evento de costo: one per inventory movement line, the valuation of that line (signed qty and amount: + into the layer, − out of it).
export const costEventEntity: EntityDef = entity("costing.cost_event", "sistema", "cost_events", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("movement_id", "ref", { required: true, ...movement }),
  // One per inventory movement line; a landed cost event (kind landed_cost) has no movement line of its own, so its id is generated
  // (the receipt line it answers to is landed_cost_lines.movement_line_id, and source_line_id here is the landed cost line).
  f("movement_line_id", "uuid", { required: true }),
  f("movement_seq", "number", { required: true }),
  f("movement_number", "text", { searchable: true }),
  f("kind", "enum", { required: true, enumValues: [...EVENT_KINDS], valuesKey: "costing.values.event_kind" }),
  f("date", "date", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("category_id", "ref", ref("core.product_category", "name")),
  f("warehouse_id", "ref", { required: true, ...warehouse }),
  f("layer_id", "ref", { required: true, ...ref("costing.cost_layer", "seq") }),
  f("qty", "number", { required: true }),
  f("unit_cost", "money", { required: true, sensitivity: "confidential" }),
  f("amount", "money", { required: true, sensitivity: "confidential" }),
  f("cost_source", "enum", { required: true, enumValues: [...COST_SOURCES], valuesKey: "costing.values.cost_source" }),
  f("cost_missing", "boolean", { required: true }),
  f("qty_after", "number", { required: true }),
  f("value_after", "money", { required: true, sensitivity: "confidential" }),
  f("avg_after", "money", { sensitivity: "confidential" }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("source_entity", "text"),
  f("source_id", "uuid"),
  f("source_line_id", "uuid"),
  f("return_of_line_id", "uuid"),
  f("cogs_posted_at", "datetime"),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

// Producto sin costo: an issue (or an entry) valued at 0 because the product had no cost in its bodega (main §5.8b: never affects
// invoice_ready). One open row per product and bodega counts the occurrences; a later entry with a cost resolves it.
export const costMissingEntity: EntityDef = entity("costing.cost_missing", "sistema", "cost_missing", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("warehouse_id", "ref", { required: true, ...warehouse }),
  f("status", "enum", { required: true, enumValues: [...MISSING_STATUSES], valuesKey: "costing.values.missing_status" }),
  f("occurrences", "number", { required: true }),
  f("qty", "number", { required: true }),
  f("first_movement_id", "ref", { required: true, ...movement }),
  f("last_movement_id", "ref", { required: true, ...movement }),
  f("first_date", "date", { required: true }),
  f("last_date", "date", { required: true }),
  f("resolved_at", "datetime"),
  f("resolved_movement_id", "ref", movement),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

// Costo en destino (landed cost): freight, duties or insurance allocated to the lines of a receipt, which raises the value of their layers.
// A documento that posts (contabiliza true: Dr inventory / Cr the offset role) and numbers on save; costing.landed_cost.allocate creates
// and allocates it in one action, so a landed cost never exists as a Borrador. Its lines say what each receipt line was given.
export const landedCostEntity: EntityDef = entity("costing.landed_cost", "documento", "landed_costs", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("date", "date", { required: true }),
  f("movement_id", "ref", { required: true, ...movement }),
  f("movement_number", "text", { searchable: true }),
  f("basis", "enum", { required: true, enumValues: [...LANDED_BASES], valuesKey: "costing.values.landed_basis" }),
  f("amount", "money", { required: true, sensitivity: "confidential" }),
  f("offset_role", "enum", { required: true, enumValues: [...OFFSET_ROLES], valuesKey: "costing.values.offset_role" }),
  // The supplier whose bill the cost is (the credited account of a payable or an advance asks for the tercero).
  f("party_id", "ref", party),
  f("reference", "text", { searchable: true }),
  f("description", "text", { searchable: true }),
  f("currency", "text"),
  f("applied_at", "datetime"),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: LANDED_COST_STATUSES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "costing.landed_cost_line", parentField: "landed_cost_id" },
    // An allocation reaches the layers and the ledger in the action that creates it: it never waits for approval, and it always posts.
    ownFlags: { requiresApproval: "costing.landed_cost.own_flags.requires_approval", posts: "costing.landed_cost.own_flags.posts" },
  },
  processIds: { create: "costing.landed_cost.allocate" },
  cloneReset: ["seq", "number", "applied_at"],
  defaultSort: { field: "date", dir: "desc" },
  recordPage: true,
});

// Línea de costo en destino: what one receipt line was given. `base` is the line's value, quantity or weight, as the basis says.
export const landedCostLineEntity: EntityDef = entity("costing.landed_cost_line", "lines", "landed_cost_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("landed_cost_id", "ref", { required: true, ...landedCost }),
  f("line_no", "number", { required: true }),
  f("movement_line_id", "uuid", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("warehouse_id", "ref", { required: true, ...warehouse }),
  f("qty", "number", { required: true }),
  f("base", "number", { required: true }),
  f("weight", "number"),
  f("amount", "money", { required: true, sensitivity: "confidential" }),
  f("unit_cost_added", "money", { required: true, sensitivity: "confidential" }),
  ...trailer(f),
]);

// Parámetros de costos: the costing method of the company. 2B accepts `average` only (OD-5); FIFO joins in phase 3 as a second value.
export const costSettingsEntity: EntityDef = entity("costing.settings", "parametro", "settings", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("method", "enum", { required: true, enumValues: [...COST_METHODS], valuesKey: "costing.values.method" }),
  ...trailer(f),
]);

export const COSTING_ENTITIES: EntityDef[] = [costLayerEntity, costEventEntity, costMissingEntity, landedCostEntity, landedCostLineEntity, costSettingsEntity];
