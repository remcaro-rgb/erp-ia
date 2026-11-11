import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the sales module (design §8, plan 2B Task 12). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`). Field names are
// the column names; the masked views `sales.v_<table>` of migration 0082 are generated from these definitions (entities.test.ts fails when
// they drift). Both are parametros: what the price of a sale line comes from. The price lists themselves are core's (core.price_list and its
// items, design §8 table); sales only says which list a customer buys from (customer_terms) and which one applies to everybody else
// (settings). Pedidos (Task 13): sales.order, a documento with its lines; entregas and devoluciones (Task 14): sales.delivery and
// sales.return, documentos with their lines (migration 0085).

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "sales",
    schema: "sales",
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
/**
 * «Lote / Vence / Serie» of an entrega line (Task 28.3): what inventory issued, one entry per lot or serial in the order it left, as
 * `code · expiry · qty` (a serial: `number · qty`; a serial that sits in a lot: `code · number · expiry · qty`, migration 0169). Codes, dates
 * and figures only: the column's label carries the words (rule 24).
 */
const DELIVERY_LINE_LOTS_EXPR =
  "(select string_agg(concat_ws(' · ', x.lot_code, x.serial_no, x.expires_on::text, trim_scale(x.qty)::text), '; ' order by x.seq) from sales.delivery_line_lots x where x.delivery_line_id = delivery_lines.id)";
const priceList = ref("core.price_list", "name");

/** When a commission is earned (plan 2B.2 Task 30.1, owner item 162): on the customer's payment (default) or on the invoice's issue. */
export const COMMISSION_BASES = ["on_collection", "on_invoice"] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];
/** Who a commission plan pays (PG §5.1, item 156): an employee (salesperson on payroll) or an external agent (a supplier). */
export const PAYEE_KINDS = ["employee", "agent"] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

// Parámetros de ventas: one row per company. The default price list prices a line whose customer has no list of their own (or whose list
// does not carry the product).
// `order_approval_discount_pct` (Task 13): a pedido with a line discount above it waits for approval (none: no pedido does by discount).
// It comes after the trailer: the column was added by migration 0084 and the view appends it.
export const salesSettingsEntity: EntityDef = entity("sales.settings", "parametro", "settings", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("default_price_list_id", "ref", priceList),
  ...trailer(f),
  f("order_approval_discount_pct", "number"),
  // Plan 2B.2 Task 30.1 (owner item 162, migration 0156, appended to the view): when a commission is earned, when the customer pays
  // (on_collection, the default) or when the invoice is issued (on_invoice). Read at each invoice: changing it affects later invoices only.
  f("commission_basis", "enum", { required: true, enumValues: [...COMMISSION_BASES], valuesKey: "sales.values.commission_basis" }),
]);

// Condiciones comerciales de un cliente: the price list the customer buys from and their standing discount (percent off every line), and
// (Task 13, migration 0084, after the trailer) their credit limit in the company currency: a pedido that would take the customer's open
// pedidos above it waits for approval (none: no limit).
export const customerTermsEntity: EntityDef = entity("sales.customer_terms", "parametro", "customer_terms", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("price_list_id", "ref", priceList),
  f("discount_pct", "number", { required: true }),
  f("notes", "text"),
  ...trailer(f),
  f("credit_limit", "money"),
]);

/** The lifecycle states of a documento (entity types spec §5). */
export const DOCUMENT_STATES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];

/**
 * Where a pedido stands commercially (beside its lifecycle status): open while it is being written (and approved, when it needs it),
 * confirmed once the customer's order is firm (stock reserved through inventory's consumer, design §8.1 steps 1–2), cancelled (the
 * pedido is voided and its reservations released). Deliveries (Task 14) take it further: partially_delivered once some of it shipped,
 * delivered once every line shipped in full (a voided delivery takes it back); a pedido with a delivery is never cancelled.
 */
export const ORDER_STAGES = ["open", "confirmed", "partially_delivered", "delivered", "cancelled"] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

// Pedido de venta (plan 2B Task 13, design §8, §8.1 steps 1–2): what a customer ordered, line by line, priced like a cotización (the
// customer's price list, the default list, the list price; or the accepted cotización's own prices when it comes from one) and taxed by the
// country pack. A documento numbered PED- on save that never posts (invoicing posts, Task 16); it waits for approval (Pendiente de
// Aprobación) when it would take the customer above their credit limit or a line's discount is above the company's threshold, so its
// approval flag is its own (ownFlags). Every line's product and the customer must be invoice_ready (rule 10). The cotización is a `ref`
// to crm.quote by its number (plan 2B Task 53.2, item 67): an entity field declaration the kernel reads, so the frame and the grid show the
// quote's number as a link through crm's masked view when crm is loaded and the viewer reads quotes; without crm the kernel skips it and
// the raw id stays (no dependency, no foreign key across schemas, rule 3). The oportunidad and the bodega stay raw ids.
export const orderEntity: EntityDef = entity("sales.order", "documento", "orders", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("quote_id", "ref", ref("crm.quote", "number")),
  f("opportunity_id", "uuid"),
  // The salesperson (Task 39, migration 0139): only they and whoever may run sales.order.reassign read the pedido (owner_scope). Filterable
  // in the grid; it changes only through sales.order.reassign.
  f("owner_id", "uuid", { filterable: true }),
  f("warehouse_id", "uuid"),
  f("issue_date", "date", { required: true }),
  f("delivery_date", "date"),
  f("stage", "enum", { required: true, enumValues: [...ORDER_STAGES], valuesKey: "sales.values.order_stage" }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("subtotal", "money", { required: true }),
  f("discount_total", "money", { required: true }),
  f("tax_total", "money", { required: true }),
  f("total", "money", { required: true }),
  // The total in the company currency (rule 8): total × exchange rate. What the credit limit is compared with.
  f("total_company", "money", { required: true }),
  f("max_discount_pct", "number", { required: true }),
  f("credit_exceeded", "boolean", { required: true }),
  f("discount_exceeded", "boolean", { required: true }),
  f("confirmed_at", "datetime"),
  f("cancelled_at", "datetime"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "sales.order_line", parentField: "order_id" },
    ownFlags: { requiresApproval: "sales.order.own_flags.requires_approval", posts: "sales.order.own_flags.posts" },
  },
  processIds: { create: "sales.order.create" },
  recordPage: true,
  // A copy is a new pedido: it starts today, with no promised date yet (Task 14b fix 1).
  cloneReset: ["seq", "number", "stage", "quote_id", "opportunity_id", "issue_date", "delivery_date", "confirmed_at", "cancelled_at", "credit_exceeded", "discount_exceeded"],
  defaultSort: { field: "seq", dir: "desc" },
});

// Línea de pedido: a product, its quantity, the unit price (from a price list, the accepted cotización, or given), the discount and the taxes
// computed by the country pack. Written by sales.order.create / update / from_quote only, never once the pedido is confirmed (migration 0084).
// `quote_line_id` is the cotización line it was copied from.
export const orderLineEntity: EntityDef = entity("sales.order_line", "lines", "order_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("order_id", "ref", { required: true, ...ref("sales.order", "number") }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("description", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("unit_price", "money", { required: true }),
  f("price_list_id", "ref", priceList),
  f("discount_pct", "number", { required: true }),
  f("discount", "money", { required: true }),
  f("base", "money", { required: true }),
  f("iva_rate", "text"),
  f("iva", "money", { required: true }),
  f("inc_rate", "text"),
  f("inc", "money", { required: true }),
  f("other_taxes", "money", { required: true }),
  f("total", "money", { required: true }),
  f("quote_line_id", "uuid"),
  ...trailer(f),
]);

/** Where an entrega stands beside its lifecycle status: open (written, Grabado) or shipped (the goods left; stock and cost follow by event). */
export const DELIVERY_STAGES = ["open", "shipped"] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];
/** What became of the re-reservation a voided entrega asked for (Task 43): `reserved`, `insufficient` (stock did not cover it), `not_permitted` (the user may not reserve), `none` (not asked, or nothing to reserve). */
export const RE_RESERVE_RESULTS = ["reserved", "insufficient", "not_permitted", "none"] as const;
export type ReReserveResult = (typeof RE_RESERVE_RESULTS)[number];
/** Where a devolución stands: open (written) or received (the goods are back; stock re-enters at the original issue cost). */
export const RETURN_STAGES = ["open", "received"] as const;

const deliveryFlags = (id: string) => ({ requiresApproval: `${id}.own_flags.requires_approval`, posts: `${id}.own_flags.posts` });

// Entrega de un pedido (plan 2B Task 14, design §8.1 steps 3–4): what leaves the bodega for a confirmed pedido, line by line
// (each line names the pedido line it delivers; several partial entregas per pedido, never more than was ordered). A documento numbered
// ENT- on save that never posts itself: sales.delivery.ship emits sales.delivery.shipped, inventory's consumer issues the stock (sale_issue)
// and costing values it and emits the cost of sales the ledger posts. The bodega and the cost center are other modules' records, named by
// id (rule 3). `invoiced_qty` on each line is what invoicing has billed of it (Task 16 maintains it); an entrega with anything invoiced is
// not voided. `stock_posted_at` / `movement_id` say when inventory issued it (sales consumes inventory.movement.posted).
export const deliveryEntity: EntityDef = entity("sales.delivery", "documento", "deliveries", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("order_id", "ref", { required: true, ...ref("sales.order", "number") }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  // Inventory's bodega, named through its published view (no foreign key across schemas, rule 3: the label is a read of
  // inventory.v_warehouses, left empty when the company has no inventory).
  f("warehouse_id", "ref", { required: true, ...ref("inventory.warehouse", "name") }),
  f("date", "date", { required: true }),
  f("stage", "enum", { required: true, enumValues: [...DELIVERY_STAGES], valuesKey: "sales.values.delivery_stage" }),
  f("shipped_at", "datetime"),
  // Why inventory could not issue the last despacho (the entrega went back to open, Task 14 review): code and detail, and when.
  f("stock_refusal", "text"),
  f("stock_refused_at", "datetime"),
  // The void's re-reservation (Task 43): whether the user asked, what became of it, and the note in words («Reserva al anular»); written by
  // sales.delivery.void and by sales.delivery.record_re_reservation (inventory's answer by event), read-only everywhere else.
  f("re_reserve_requested", "boolean"),
  f("re_reserve_result", "enum", { enumValues: [...RE_RESERVE_RESULTS], valuesKey: "sales.values.delivery_re_reserve" }),
  f("re_reserve_note", "text"),
  f("cost_center_id", "uuid"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
  // The pedido's salesperson (Task 39, R39-8, migration 0139, appended to the view): read-only, computed through sales.v_order_owners as the
  // caller, so it is empty when the caller cannot read the pedido (or its owner is masked for them). Deliveries are not isolated by it.
  f("order_owner_id", "uuid", { viewExpr: "(select oo.owner_id from sales.v_order_owners oo where oo.order_id = deliveries.order_id)" }),
], {
  typed: { numbering: "on_save", lines: { entity: "sales.delivery_line", parentField: "delivery_id" }, ownFlags: deliveryFlags("sales.delivery") },
  processIds: { create: "sales.delivery.create" },
  recordPage: true,
  cloneReset: ["seq", "number", "stage", "shipped_at", "stock_refusal", "stock_refused_at", "re_reserve_requested", "re_reserve_result", "re_reserve_note", "order_owner_id"],
  defaultSort: { field: "seq", dir: "desc" },
});

export const deliveryLineEntity: EntityDef = entity("sales.delivery_line", "lines", "delivery_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("delivery_id", "ref", { required: true, ...ref("sales.delivery", "number") }),
  f("line_no", "number", { required: true }),
  f("order_line_id", "ref", { required: true, ...ref("sales.order_line", "line_no") }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("description", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("invoiced_qty", "number", { required: true }),
  f("movement_id", "uuid"),
  f("stock_posted_at", "datetime"),
  ...trailer(f),
  // Lots and serials (Task 28.3, migration 0165, appended to the view): what the user asked for (a lot, or one serial per unit; else FEFO
  // chooses at ship) and, read-only, what inventory issued («Lote / Vence / Serie»: sales.delivery_line_lots, one entry per lot or serial).
  f("lot_id", "ref", ref("inventory.lot", "code")),
  f("serial_ids", "text", { list: true, sortable: false, filterable: false }),
  f("lots", "text", { sortable: false, filterable: false, viewExpr: DELIVERY_LINE_LOTS_EXPR }),
]);

// What inventory issued of each lot and serial for an entrega line (plan 2B.2 Task 28.3, PG §3.3; migration 0165): written once per
// inventory.sale_issue.allocated event by sales.delivery.record_lots, read-only everywhere. Its masked view sales.v_delivery_line_lots is
// published (invoicing copies it onto the invoice line, Task 28.4).
export const deliveryLineLotEntity: EntityDef = entity("sales.delivery_line_lot", "sistema", "delivery_line_lots", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("delivery_line_id", "ref", { required: true, ...ref("sales.delivery_line", "line_no") }),
  f("lot_id", "ref", ref("inventory.lot", "code")),
  f("lot_code", "text", { searchable: true }),
  f("expires_on", "date"),
  f("serial_id", "uuid"),
  f("serial_no", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("event_id", "uuid", { required: true }),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "asc" } });

// Devolución de una entrega (plan 2B Task 14): goods the customer sends back, line by line against the entrega lines (never more than
// was delivered, counting the other devoluciones). Numbered DEV- on save; sales.return.receive emits sales.return.received and inventory's
// consumer re-enters the stock (sale_return) at the cost the original sale issue took (costing, Task 8), which also takes that cost back
// out of the cost of sales (costing.cogs.returned).
export const returnEntity: EntityDef = entity("sales.return", "documento", "returns", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("delivery_id", "ref", { required: true, ...ref("sales.delivery", "number") }),
  f("order_id", "ref", { required: true, ...ref("sales.order", "number") }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("warehouse_id", "ref", { required: true, ...ref("inventory.warehouse", "name") }),
  f("date", "date", { required: true }),
  f("stage", "enum", { required: true, enumValues: [...RETURN_STAGES], valuesKey: "sales.values.return_stage" }),
  f("received_at", "datetime"),
  f("reason", "text", { required: true, searchable: true }),
  // Why inventory could not take back the stock of the last Anular (the devolución went back to received, Task 14 review).
  f("stock_refusal", "text"),
  f("stock_refused_at", "datetime"),
  f("cost_center_id", "uuid"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: { numbering: "on_save", lines: { entity: "sales.return_line", parentField: "return_id" }, ownFlags: deliveryFlags("sales.return") },
  processIds: { create: "sales.return.create" },
  recordPage: true,
  cloneReset: ["seq", "number", "stage", "received_at", "stock_refusal", "stock_refused_at"],
  defaultSort: { field: "seq", dir: "desc" },
});

export const returnLineEntity: EntityDef = entity("sales.return_line", "lines", "return_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("return_id", "ref", { required: true, ...ref("sales.return", "number") }),
  f("line_no", "number", { required: true }),
  f("delivery_line_id", "ref", { required: true, ...ref("sales.delivery_line", "line_no") }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("qty", "number", { required: true }),
  ...trailer(f),
  // The lot or the serials coming back (Task 28.3, migration 0165, appended to the view): defaulted from what the entrega issued.
  f("lot_id", "ref", ref("inventory.lot", "code")),
  f("serial_ids", "text", { list: true, sortable: false, filterable: false }),
]);

// Commissions (plan 2B.2 Task 30.1, Part G design PG §5.1, §5.2, §5.5; owner items 156–158, 162, 163; RG-11, RG-12, RG-14; migration 0156).
// Rates and amounts are confidential (masked for every role but the admin until the admin shows them, item 163); a salesperson reads only
// the plans that list their user and what those plans earned (record rule of 0156), whoever may run sales.commission.consult_all every one.

/** The lifecycle states of a maestro (entity types spec §5). */
const MAESTRO_STATES = ["draft", "saved", "pending", "rejected", "approved"];
const confidential = { sensitivity: "confidential" } as const;

// Plan de comisión (maestro): who is paid (a core party: an employee, or a supplier for an external agent, invoice_ready, rule 10), the
// users whose pedidos it covers (sales.commission_plan_users, one active plan per user at a date), the default rate and a rate per product
// category (sales.commission_plan_lines), its validity and the days the provision is due after its date (CxP aging). Activo is is_active.
export const commissionPlanEntity: EntityDef = entity("sales.commission_plan", "maestro", "commission_plans", "name", (f) => [
  f("seq", "number", { required: true }),
  f("name", "text", { required: true, searchable: true }),
  f("payee_party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("payee_kind", "enum", { required: true, enumValues: [...PAYEE_KINDS], valuesKey: "sales.values.payee_kind" }),
  f("default_rate_pct", "number", { required: true, ...confidential }),
  f("payment_days", "number", { required: true }),
  f("valid_from", "date", { required: true }),
  f("valid_to", "date"),
  f("notes", "text", { searchable: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
], { importKey: ["name"], cloneReset: ["seq", "name"], processIds: { create: "sales.commission_plan.create" }, recordPage: true });

/** Whether a base still earns: open until it is fully accrued or closed by an annulment (Task 30.3). */
export const COMMISSION_BASE_STATES = ["open", "closed"] as const;

// Base de comisión (sistema): one per invoice line billed from a pedido whose owner had an active plan at the invoice date. Written only by
// sales.commission.compute from invoicing.invoice.issued: the payee and the rate frozen at the issue, the base (the line's subtotal before
// taxes, after discounts) in pesos and in the invoice's currency, the commission on each, what was accrued and reversed of it.
export const commissionBaseEntity: EntityDef = entity("sales.commission_base", "sistema", "commission_bases", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("invoice_id", "uuid", { required: true }),
  f("invoice_number", "text", { searchable: true }),
  f("invoice_line_id", "uuid", { required: true }),
  f("invoice_date", "date", { required: true }),
  f("order_id", "ref", { required: true, ...ref("sales.order", "number") }),
  f("order_line_id", "ref", { required: true, ...ref("sales.order_line", "line_no") }),
  f("product_id", "ref", ref("core.product", "description")),
  f("category_id", "ref", ref("core.product_category", "name")),
  f("cost_center_id", "uuid"),
  f("user_id", "uuid", { required: true, filterable: true }),
  f("plan_id", "ref", { required: true, ...ref("sales.commission_plan", "name") }),
  f("payee_party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("payee_kind", "enum", { required: true, enumValues: [...PAYEE_KINDS], valuesKey: "sales.values.payee_kind" }),
  f("basis", "enum", { required: true, enumValues: [...COMMISSION_BASES], valuesKey: "sales.values.commission_basis" }),
  f("rate_pct", "number", { required: true, ...confidential }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("base", "money", { required: true, ...confidential }),
  f("base_doc", "money", { required: true, ...confidential }),
  f("commission", "money", { required: true, ...confidential }),
  f("commission_doc", "money", { required: true, ...confidential }),
  f("accrued", "money", { required: true, ...confidential }),
  f("reversed", "money", { required: true, ...confidential }),
  f("status", "enum", { required: true, enumValues: [...COMMISSION_BASE_STATES], valuesKey: "sales.values.commission_base_status" }),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

/**
 * Where a commission stands beside its lifecycle status (`stage`; the kernel's `status` column is the documento's lifecycle, so the plan's
 * «status posted|reversed|paid» is this column): posted (the provision is in the ledger), reversed (Task 30.3), paid (phase 3 disbursements).
 */
export const COMMISSION_STAGES = ["posted", "reversed", "paid"] as const;
/** What a commission documento comes from (Task 30.2, 30.3). */
export const COMMISSION_SOURCES = ["invoice", "receipt", "advance", "note", "annulment", "void"] as const;

// Comisión (documento, contabiliza, numbered COM- on save): the provision owed to one payee for one source document (the invoice under
// on_invoice, the receipt or advance application under on_collection; a note or a void reverses), posted inline (Task 30.2, design §5.4: Dr
// commission_expense / Cr commissions_payable with the payee as party). Its lines name the bases it accrues. Written only by the
// sales.commission processes of Tasks 30.2 and 30.3; no create from the screen.
export const commissionEntity: EntityDef = entity("sales.commission", "documento", "commissions", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("date", "date", { required: true }),
  f("due_date", "date"),
  f("payee_party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("payee_kind", "enum", { required: true, enumValues: [...PAYEE_KINDS], valuesKey: "sales.values.payee_kind" }),
  f("plan_id", "ref", { required: true, ...ref("sales.commission_plan", "name") }),
  f("source_kind", "enum", { required: true, enumValues: [...COMMISSION_SOURCES], valuesKey: "sales.values.commission_source" }),
  f("source_id", "uuid", { required: true }),
  f("currency", "text", { required: true }),
  f("amount", "money", { required: true, ...confidential }),
  f("stage", "enum", { required: true, enumValues: [...COMMISSION_STAGES], valuesKey: "sales.values.commission_stage" }),
  f("reverses_id", "ref", ref("sales.commission", "number")),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: { numbering: "on_save", lines: { entity: "sales.commission_line", parentField: "commission_id" }, ownFlags: deliveryFlags("sales.commission") },
  // Task 30.4: the plan and the commission open in the record frame (apps/web/src/lib/records/entities.ts); a commission is never created there.
  recordPage: true,
  cloneReset: ["seq", "number", "stage", "reverses_id"],
  defaultSort: { field: "seq", dir: "desc" },
});

export const commissionLineEntity: EntityDef = entity("sales.commission_line", "lines", "commission_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("commission_id", "ref", { required: true, ...ref("sales.commission", "number") }),
  f("line_no", "number", { required: true }),
  f("base_id", "uuid", { required: true }),
  f("cost_center_id", "uuid"),
  f("amount", "money", { required: true, ...confidential }),
  ...trailer(f),
]);

export const SALES_ENTITIES: EntityDef[] = [
  salesSettingsEntity, customerTermsEntity, orderEntity, orderLineEntity, deliveryEntity, deliveryLineEntity, returnEntity, returnLineEntity,
  commissionPlanEntity, commissionBaseEntity, commissionEntity, commissionLineEntity, deliveryLineLotEntity,
];
