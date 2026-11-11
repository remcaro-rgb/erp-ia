import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the warehouse module (plan 2B.2 Task 29.1, PG §4.2; migration 0170). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`).
// Field names are the column names; the masked views `warehouse.v_<table>` of migration 0170 are generated from these definitions
// (entities.test.ts fails when they drift). Bins are inventory locations (PG §4.1, item 151): a pick line names inventory's ubicación, lot and
// serial by id, read through inventory's published views (no foreign key across schemas, rule 3). The pedido and its lines are sales'
// records, named by id and read through sales.v_pick_order_lines (migration 0170).

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "warehouse",
    schema: "warehouse",
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

const ref = (entityId: string, display: string): Pick<FieldDef, "ref"> => ({ ref: { entity: entityId, display } });

/** The lifecycle states of a documento (entity types spec §5). */
export const DOCUMENT_STATES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];

/**
 * Where an alistamiento stands beside its lifecycle status (PG §4.2: borrador → en proceso → confirmado / anulado): `open` (Por alistar,
 * proposed from the stock), `in_progress` (En proceso: a picker took it, or inventory found a line short and sent it back), `confirmed`
 * (what was taken is final and inventory allocates it). Anulado is the lifecycle's `voided`.
 */
export const PICK_STAGES = ["open", "in_progress", "confirmed"] as const;
export type PickStage = (typeof PICK_STAGES)[number];
/** Inventory's answer to a confirmed alistamiento (inventory.reservation.allocated): all allocated, or short (nothing allocated). */
export const ALLOCATION_STATUSES = ["allocated", "short"] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

// Parámetros de bodega: one row per company (none: the defaults). `auto_pick_on_confirm`: a confirmed pedido makes its alistamiento by
// itself (else only «Crear alistamiento» does); `delivery_from_pick`: a confirmed and allocated alistamiento asks sales for a Borrador entrega
// (the flag travels on warehouse.pick.confirmed; sales acts on inventory's answer, Task 29.2).
export const warehouseSettingsEntity: EntityDef = entity("warehouse.settings", "parametro", "settings", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("auto_pick_on_confirm", "boolean", { required: true }),
  f("delivery_from_pick", "boolean", { required: true }),
  ...trailer(f),
]);

// Alistamiento (pick list, PG §4.2): what to take from which shelf for a confirmed pedido. A documento numbered ALI- on save that never posts
// and never waits for approval (ownFlags). Created from sales.order.confirmed (auto_pick_on_confirm) or from the pedido; confirming it
// emits warehouse.pick.confirmed and inventory allocates the pedido lines' reservations (no stock moves at pick, RG-7).
export const pickEntity: EntityDef = entity("warehouse.pick", "documento", "picks", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("order_id", "ref", { required: true, ...ref("sales.order", "number") }),
  f("order_number", "text", { searchable: true }),
  f("warehouse_id", "ref", { required: true, ...ref("inventory.warehouse", "name") }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("stage", "enum", { required: true, enumValues: [...PICK_STAGES], valuesKey: "warehouse.values.pick_stage" }),
  f("picker_user_id", "uuid"),
  f("started_at", "datetime"),
  f("confirmed_at", "datetime"),
  // Inventory's answer (inventory.reservation.allocated, recorded by warehouse.pick.record_allocation): its status, when, and the short lines in words.
  f("allocation_status", "enum", { enumValues: [...ALLOCATION_STATUSES], valuesKey: "warehouse.values.allocation_status" }),
  f("allocated_at", "datetime"),
  f("allocation_note", "text"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "warehouse.pick_line", parentField: "pick_id" },
    ownFlags: { requiresApproval: "warehouse.pick.own_flags.requires_approval", posts: "warehouse.pick.own_flags.posts" },
  },
  processIds: { create: "warehouse.pick.create" },
  // The record frame, the grid and the «Alistamientos» tab of the pedido are Task 29.4's.
  cloneReset: ["seq", "number", "stage", "picker_user_id", "started_at", "confirmed_at", "allocation_status", "allocated_at", "allocation_note"],
  defaultSort: { field: "seq", dir: "desc" },
});

// Línea de alistamiento: one pedido line from one bucket (ubicación, lot, serial). A pedido line split over two lots is two lines. What the
// stock proposed (qty_requested, location, lot) and what the picker took (qty_picked, the location, lot and serial confirmed); short_qty is
// what inventory could not allocate of it (a short answer).
export const pickLineEntity: EntityDef = entity("warehouse.pick_line", "lines", "pick_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("pick_id", "ref", { required: true, ...ref("warehouse.pick", "number") }),
  f("line_no", "number", { required: true }),
  f("order_line_id", "ref", { required: true, ...ref("sales.order_line", "line_no") }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("qty_requested", "number", { required: true }),
  f("location_id", "ref", ref("inventory.location", "name")),
  f("lot_id", "ref", ref("inventory.lot", "code")),
  f("serial_id", "ref", ref("inventory.serial", "serial_no")),
  f("qty_picked", "number"),
  f("short_qty", "number"),
  ...trailer(f),
]);

/** Where an empaque stands beside its lifecycle status (PG §4.3 step 6): `open` (its packages are edited), `closed` (packed). Anulado is `voided`. */
export const PACK_STAGES = ["open", "closed"] as const;
export type PackStage = (typeof PACK_STAGES)[number];

// Empaque (packing, PG §4.2 and §4.3 step 6, Task 29.3, item 154): the packages a confirmed alistamiento leaves in. A documento numbered
// EMP- on save that never posts and never waits for approval; it gates nothing (an entrega ships whatever its empaque's state). The
// alistamiento's number, pedido, bodega and customer are copied at creation (what the «Lista de empaque» prints).
export const packEntity: EntityDef = entity("warehouse.pack", "documento", "packs", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("pick_id", "ref", { required: true, ...ref("warehouse.pick", "number") }),
  f("pick_number", "text", { searchable: true }),
  f("order_id", "ref", { required: true, ...ref("sales.order", "number") }),
  f("order_number", "text", { searchable: true }),
  f("warehouse_id", "ref", { required: true, ...ref("inventory.warehouse", "name") }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("stage", "enum", { required: true, enumValues: [...PACK_STAGES], valuesKey: "warehouse.values.pack_stage" }),
  f("packages_count", "number", { required: true }),
  // Kilograms, typed by hand per package (the sum of the packages that have one; none when no package has).
  f("total_weight_kg", "number"),
  f("closed_at", "datetime"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "warehouse.pack_package", parentField: "pack_id" },
    ownFlags: { requiresApproval: "warehouse.pack.own_flags.requires_approval", posts: "warehouse.pack.own_flags.posts" },
  },
  processIds: { create: "warehouse.pack.create" },
  // The record frame and the grid are Task 29.4's.
  cloneReset: ["seq", "number", "stage", "closed_at", "packages_count", "total_weight_kg"],
  defaultSort: { field: "seq", dir: "desc" },
});

// Paquete: one box of an empaque. `items` is what it holds, [{ pickLineId, qty }] (lines of the alistamiento); `contents` is the same in
// words, written by the process (product, lot or serial, quantity), so the «Lista de empaque» prints it as the picker reads it.
export const packPackageEntity: EntityDef = entity("warehouse.pack_package", "lines", "pack_packages", "package_no", (f) => [
  f("seq", "number", { required: true }),
  f("pack_id", "ref", { required: true, ...ref("warehouse.pack", "number") }),
  f("package_no", "number", { required: true }),
  f("weight_kg", "number"),
  f("dimensions", "text"),
  f("items", "json", { sortable: false }),
  f("contents", "text", { searchable: true, sortable: false }),
  ...trailer(f),
]);

// Regla de ubicación (put-away rule, PG §4.2 and §4.3 step 8, item 155): in a bodega, the goods of a category (none: any goods) go to a
// ubicación; the lowest priority wins. warehouse.putaway.suggest reads them; the user confirms (inventory.relocation.post moves the stock).
export const putawayRuleEntity: EntityDef = entity("warehouse.putaway_rule", "parametro", "putaway_rules", "priority", (f) => [
  f("seq", "number", { required: true }),
  f("warehouse_id", "ref", { required: true, ...ref("inventory.warehouse", "name") }),
  f("category_id", "ref", ref("core.product_category", "name")),
  f("location_id", "ref", { required: true, ...ref("inventory.location", "name") }),
  f("priority", "number", { required: true }),
  ...trailer(f),
]);

export const WAREHOUSE_ENTITIES: EntityDef[] = [warehouseSettingsEntity, pickEntity, pickLineEntity, packEntity, packPackageEntity, putawayRuleEntity];
