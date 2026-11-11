import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the inventory module (design §8, plan 2B Task 6). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`); enum values
// read `inventory.values.*`. Field names are the column names; the masked views `inventory.v_<table>` of migration 0066 are generated from
// these definitions (entities.test.ts fails when they drift). Bodegas and ubicaciones are maestros; a movimiento is a documento that
// numbers on save and neither posts (contabiliza false: costing values it and accounting posts from its events) nor needs approval; its
// lines, the stock levels and the reservations are written only by the inventory processes. Lots and serials (2B.2 Task 28, OD-8, PG §3.1):
// a lot and a serial are maestros of one product (code / number unique per product, item 145); the tracking of a product (none, lot,
// serial, FEFO, expiry) is the parametro inventory.product_tracking, inventory's own because core.products is core's (rule 3); the line
// and stock tables name them through `lot_id` / `serial_id`.

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "inventory",
    schema: "inventory",
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
/** A documento's lifecycle state (spec §5.1). A movement is Grabado once it is in the stock, Anulado once reversed. */
export const MOVEMENT_STATUSES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];

/**
 * The kinds of movement. `receipt`, `issue`, `sale_issue` (a delivery, Task 14) and `sale_return` are posted with inventory.movement.post;
 * `adjustment` (step-up) and the two legs of a transfer have their own processes (Task 7); `relocation` (Task 29.3, migration 0173) is
 * inventory.relocation.post: stock moved between two ubicaciones of one bodega (− from, + to), no quantity of the bodega and no cost
 * changes. Receipts and returns add (qty > 0), the rest take (qty < 0); an adjustment and a relocation carry either sign.
 */
export const MOVEMENT_KINDS = ["receipt", "issue", "sale_issue", "sale_return", "adjustment", "transfer_out", "transfer_in", "relocation"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
/** The kinds inventory.movement.post accepts. */
export const POSTABLE_KINDS = ["receipt", "issue", "sale_issue", "sale_return"] as const satisfies readonly MovementKind[];
/** The sign of the quantities of each kind: +1 adds stock, -1 takes it, 0 either. */
export const KIND_SIGN: Record<MovementKind, 1 | -1 | 0> = {
  receipt: 1, issue: -1, sale_issue: -1, sale_return: 1, adjustment: 0, transfer_out: -1, transfer_in: 1, relocation: 0,
};
/** The prefix of the movement number per kind (company sequence, D9): Entrada, Salida, Salida por venta, Devolución, Ajuste, Traslado, Reubicación. */
export const KIND_PREFIX: Record<MovementKind, string> = {
  receipt: "EN-", issue: "SA-", sale_issue: "SV-", sale_return: "DV-", adjustment: "AJ-", transfer_out: "TS-", transfer_in: "TE-", relocation: "RU-",
};

/** A ubicación is where stock sits (`storage`) or the stock on its way between two bodegas (`transit`, Task 7). */
export const LOCATION_KINDS = ["storage", "transit"];
/** Where a transfer is: requested (saved, nothing moved), in transit (shipped: out of the source, in the transit location), received. */
export const TRANSFER_STAGES = ["requested", "in_transit", "received"];
/** Where a count is: open (being counted), applied (its differences posted as one adjustment). */
export const COUNT_STAGES = ["open", "applied"];
export const RESERVATION_STATUSES = ["active", "released"];
/** How a product's stock is tracked (PG §3.1): not at all (the default), by lot, or one unit per serial number. */
export const TRACKING_KINDS = ["none", "lot", "serial"] as const;
export type TrackingKind = (typeof TRACKING_KINDS)[number];
/** A lot is sold (active) or held back (blocked: FEFO skips it, 28.3). Apart from the maestro lifecycle `status` (typed_columns owns it). */
export const LOT_STATUSES = ["active", "blocked"] as const;
/**
 * Where a serial is (kept by the processes only, read only on the form): in stock (`available`), gone with an issue (`issued`), written
 * off by an adjustment (`scrapped`). Null: registered by hand and never received (`available` only by a process, 28.2).
 */
export const SERIAL_STATUSES = ["available", "issued", "scrapped"] as const;

const maestroLifecycle = (f: F): FieldDef[] => [
  f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
];

const ref = (entityId: string, display: string): Pick<FieldDef, "ref"> => ({ ref: { entity: entityId, display } });
const product = ref("core.product", "description");
const warehouseRef = ref("inventory.warehouse", "name");
const locationRef = ref("inventory.location", "code");
const lotRef = ref("inventory.lot", "code");
const serialRef = ref("inventory.serial", "serial_no");

// Bodega.
export const warehouseEntity: EntityDef = entity("inventory.warehouse", "maestro", "warehouses", "name", (f) => [
  f("seq", "number", { required: true }),
  f("code", "text", { required: true, searchable: true }),
  f("name", "text", { required: true, searchable: true }),
  f("address_line", "text", { searchable: true }),
  // OD-3: an issue that leaves stock below zero is refused unless the bodega allows backorders.
  f("allow_backorders", "boolean", { required: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { importKey: ["code"], cloneReset: ["seq", "code"], recordPage: true });

// Ubicación (of one bodega).
export const locationEntity: EntityDef = entity("inventory.location", "maestro", "locations", "code", (f) => [
  f("seq", "number", { required: true }),
  f("warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("code", "text", { required: true, searchable: true }),
  f("name", "text", { required: true, searchable: true }),
  f("kind", "enum", { required: true, enumValues: LOCATION_KINDS, valuesKey: "inventory.values.location_kind" }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { importKey: ["warehouse_id", "code"], cloneReset: ["seq", "code"], recordPage: true });

// Movimiento de inventario.
export const movementEntity: EntityDef = entity("inventory.movement", "documento", "movements", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("kind", "enum", { required: true, enumValues: [...MOVEMENT_KINDS], valuesKey: "inventory.values.movement_kind" }),
  f("date", "date", { required: true }),
  f("warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("reference", "text", { searchable: true }),
  f("description", "text", { searchable: true }),
  f("currency", "text"),
  f("exchange_rate", "number"),
  // What caused it (a delivery, a return…) and when it reached the stock.
  f("source_entity", "text"),
  f("source_id", "uuid"),
  f("applied_at", "datetime"),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: MOVEMENT_STATUSES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
  // The customer a sale issue or return answers to (Task 28.1, PG §3.6: the recall report names it without reading sales; rule 3). A uuid,
  // not a maestro ref (Task 28.4, item 206): it is a fact copied from the shipped event, so the maestro usability gate must not refuse the
  // issue of an entrega whose customer was deactivated after the pedido was confirmed. The recall report links it to the party.
  f("party_id", "uuid"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "inventory.movement_line", parentField: "movement_id" },
    // A movement is in the stock the moment it is saved: it never waits for approval and never posts itself (contabiliza false).
    ownFlags: { requiresApproval: "inventory.movement.own_flags.requires_approval", posts: "inventory.movement.own_flags.posts" },
  },
  // Nuevo, the importer and Duplicar create a movement by registering it in the stock.
  processIds: { create: "inventory.movement.post" },
  cloneReset: ["seq", "number", "source_entity", "source_id", "applied_at"],
  defaultSort: { field: "date", dir: "desc" },
  recordPage: true,
});

// Línea de movimiento: qty is signed (+ in, − out), in the product's unit.
export const movementLineEntity: EntityDef = entity("inventory.movement_line", "lines", "movement_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("movement_id", "ref", { required: true, ...ref("inventory.movement", "number") }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("location_id", "ref", locationRef),
  f("lot_id", "ref", lotRef),
  f("serial_id", "ref", serialRef),
  f("qty", "number", { required: true }),
  f("uom", "text", { required: true }),
  // Company currency; costing (Task 8) values the issues, a receipt may bring its cost.
  f("unit_cost", "money"),
  f("source_entity", "text"),
  f("source_line_id", "uuid"),
  ...trailer(f),
]);

// Existencias: on hand per product, bodega and ubicación (a null ubicación is the bodega's own stock).
export const stockLevelEntity: EntityDef = entity("inventory.stock_level", "sistema", "stock_levels", "product_id", (f) => [
  f("seq", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("location_id", "ref", locationRef),
  f("lot_id", "ref", lotRef),
  f("serial_id", "ref", serialRef),
  f("on_hand", "number", { required: true }),
  ...trailer(f),
]);

// Reserva: stock promised to a source line (an order line, Task 13) until it is delivered or released.
export const reservationEntity: EntityDef = entity("inventory.reservation", "sistema", "reservations", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("source_entity", "text", { required: true }),
  f("source_line_id", "uuid", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("location_id", "ref", locationRef),
  f("qty", "number", { required: true }),
  f("released_qty", "number", { required: true }),
  f("status", "enum", { required: true, enumValues: RESERVATION_STATUSES, valuesKey: "inventory.values.reservation_status" }),
  f("released_at", "datetime"),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

// Traslado entre bodegas (Task 7): requested, shipped (ship takes it out of the source into the transit location), received (receive
// takes it out of the transit location into the destination). Neither approval nor posting: the stock moves with the process.
export const transferEntity: EntityDef = entity("inventory.transfer", "documento", "transfers", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("date", "date", { required: true }),
  f("from_warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("to_warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("reference", "text", { searchable: true }),
  f("description", "text", { searchable: true }),
  f("stage", "enum", { required: true, enumValues: TRANSFER_STAGES, valuesKey: "inventory.values.transfer_stage" }),
  f("shipped_at", "datetime"),
  f("received_at", "datetime"),
  // The transit ubicación the stock sat in between ship and receive.
  f("transit_location_id", "ref", locationRef),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: MOVEMENT_STATUSES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "inventory.transfer_line", parentField: "transfer_id" },
    ownFlags: { requiresApproval: "inventory.transfer.own_flags.requires_approval", posts: "inventory.transfer.own_flags.posts" },
  },
  processIds: { create: "inventory.transfer.create" },
  cloneReset: ["seq", "number", "stage", "shipped_at", "received_at", "transit_location_id"],
  defaultSort: { field: "date", dir: "desc" },
  recordPage: true,
});

export const transferLineEntity: EntityDef = entity("inventory.transfer_line", "lines", "transfer_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("transfer_id", "ref", { required: true, ...ref("inventory.transfer", "number") }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("from_location_id", "ref", locationRef),
  f("to_location_id", "ref", locationRef),
  f("qty", "number", { required: true }),
  f("uom", "text", { required: true }),
  ...trailer(f),
  // Task 28.2: the lot or serial the line moves (a serial line moves one unit); appended so the masked view is re-created in place.
  f("lot_id", "ref", lotRef),
  f("serial_id", "ref", serialRef),
]);

// Conteo físico (Task 7): lines name the product (and ubicación) to count; recording stores what was counted next to what the system
// held at that moment; applying posts the differences as ONE adjustment.
export const countEntity: EntityDef = entity("inventory.count", "documento", "counts", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("date", "date", { required: true }),
  f("warehouse_id", "ref", { required: true, ...warehouseRef }),
  f("description", "text", { searchable: true }),
  f("stage", "enum", { required: true, enumValues: COUNT_STAGES, valuesKey: "inventory.values.count_stage" }),
  f("applied_at", "datetime"),
  f("adjustment_id", "ref", ref("inventory.movement", "number")),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: MOVEMENT_STATUSES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "inventory.count_line", parentField: "count_id" },
    ownFlags: { requiresApproval: "inventory.count.own_flags.requires_approval", posts: "inventory.count.own_flags.posts" },
  },
  processIds: { create: "inventory.count.create" },
  cloneReset: ["seq", "number", "stage", "applied_at", "adjustment_id"],
  defaultSort: { field: "date", dir: "desc" },
  recordPage: true,
});

export const countLineEntity: EntityDef = entity("inventory.count_line", "lines", "count_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("count_id", "ref", { required: true, ...ref("inventory.count", "number") }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("location_id", "ref", locationRef),
  f("system_qty", "number"),
  f("counted_qty", "number"),
  f("difference", "number"),
  f("recorded_at", "datetime"),
  ...trailer(f),
  // Task 28.2: a lot-tracked product is counted per lot, a serial-tracked one per serial (the bucket the line counts).
  f("lot_id", "ref", lotRef),
  f("serial_id", "ref", serialRef),
]);

// Lote (Task 28.1, PG §3.1): of one product, its code free text unique per product whatever its case (item 145); expiry and production
// dates order FEFO (28.3). `lot_status` blocks it for sale; the maestro lifecycle (`status`, Activo) is the kernel's as for any maestro.
export const lotEntity: EntityDef = entity("inventory.lot", "maestro", "lots", "code", (f) => [
  f("seq", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("code", "text", { required: true, searchable: true }),
  f("expires_on", "date"),
  f("produced_on", "date"),
  f("lot_status", "enum", { required: true, enumValues: [...LOT_STATUSES], valuesKey: "inventory.values.lot_status" }),
  f("note", "text", { searchable: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { importKey: ["product_id", "code"], cloneReset: ["seq", "code"], defaultSort: { field: "expires_on", dir: "asc" }, recordPage: true });

// Serial (Task 28.1): one unit of a product, its number unique per product, optionally inside a lot of the same product. Its
// `serial_status` is kept by the movements (28.2), read only on the form.
export const serialEntity: EntityDef = entity("inventory.serial", "maestro", "serials", "serial_no", (f) => [
  f("seq", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("serial_no", "text", { required: true, searchable: true }),
  f("lot_id", "ref", lotRef),
  f("serial_status", "enum", { enumValues: [...SERIAL_STATUSES], valuesKey: "inventory.values.serial_status" }),
  f("note", "text", { searchable: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { importKey: ["product_id", "serial_no"], cloneReset: ["seq", "serial_no", "serial_status"], recordPage: true });

// Seguimiento por producto (Task 28.1, Parámetros): one row per product; a product without a row is untracked (none, FEFO on, expiry not
// required, expired lots blocked). Set by inventory.product_tracking.set (step-up), refused while the product has stock (item 146).
export const productTrackingEntity: EntityDef = entity("inventory.product_tracking", "parametro", "product_tracking", "product_id", (f) => [
  f("seq", "number", { required: true }),
  f("product_id", "ref", { required: true, ...product }),
  f("tracking", "enum", { required: true, enumValues: [...TRACKING_KINDS], valuesKey: "inventory.values.tracking" }),
  f("fefo", "boolean", { required: true }),
  f("expiry_required", "boolean", { required: true }),
  f("block_expired", "boolean", { required: true }),
  ...trailer(f),
  // Task 28.5: the row opens in its record page (/r/inventory.product_tracking/<id>), saved through inventory.product_tracking.set.
], { recordPage: true });

// Asignación de una reserva (Task 28.1, empty until 29.1): where, from which lot and which serial a reservation will be picked. Written
// only by inventory.reservation.allocate (29.1); a reservation may be split over several lots.
export const reservationAllocationEntity: EntityDef = entity("inventory.reservation_allocation", "sistema", "reservation_allocations", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("reservation_id", "ref", { required: true, ...ref("inventory.reservation", "seq") }),
  f("location_id", "ref", locationRef),
  f("lot_id", "ref", lotRef),
  f("serial_id", "ref", serialRef),
  f("qty", "number", { required: true }),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

export const INVENTORY_ENTITIES: EntityDef[] = [
  warehouseEntity, locationEntity, movementEntity, movementLineEntity, stockLevelEntity, reservationEntity,
  transferEntity, transferLineEntity, countEntity, countLineEntity,
  lotEntity, serialEntity, productTrackingEntity, reservationAllocationEntity,
];
