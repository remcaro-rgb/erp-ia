import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the payments module (design §8, §8.1 step 7; plan 2B Task 21). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`);
// enum values read `payments.values.*`. Field names are the column names; the masked views `payments.v_<table>` of migration 0109 are
// generated from these definitions (entities.test.ts fails when they drift).
//
//  - payments.method (maestro): a medio de pago (efectivo, transferencia, tarjeta, cheque, otro). Its `kind` is the dimension the ledger
//    resolves the cash or bank account by (`payment_method:<kind>`, accounting design §5.4: Dr cash / bank per method; controller ruling of
//    fix round 1: never the free-text code), which the Colombia pack maps for every kind it receives (cash, check, transfer, card).
//  - payments.cash_box (maestro): a caja where cash is received (the arqueo and the POS of later phases name it).
//  - payments.receipt (documento, contabiliza): a recibo de caja of a customer. It never exists as a Borrador: payments.payment.receive
//    writes it with its allocations, numbers it (RC-n, on save) and posts it in ONE transaction (D8, inline and strict). Anular
//    (payments.payment.void, step-up) reverses its entry; the receipt is never deleted.
//  - payments.receipt_allocation (lines): what the receipt applies to one issued invoice of the customer: `amount` settles the invoice's
//    receivable (cash + the withholdings the customer practised on it), `withholdings` the certificates' lines (kind, code, rate, base,
//    amount), `cash_amount` what of the money received went to it. The invoice is invoicing's (its id and number are named, never
//    referenced across schemas, rule 3).
//  - payments.advance_application (documento, contabiliza; plan 2B.2 Task 36): one act of the user over one customer that applies the advance
//    of one or more of its receipts to one or more of its invoices (Dr customer_advances / Cr receivable). It is written already applied by
//    payments.advance.apply, numbered AP-n on save and posted inline and strict; payments.advance.undo (step-up) voids it, never deletes it.
//  - payments.advance_application_line (lines): (advance receipt, invoice, amount); many to many falls out of the lines.

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "payments",
    schema: "payments",
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

/** A maestro's lifecycle state (entity types spec §5.1). */
export const MAESTRO_STATES = ["draft", "saved", "pending", "rejected", "approved"];
/** A documento's lifecycle state (spec §5.1). A receipt is Contabilizado once received, Anulado once reversed. */
export const DOCUMENT_STATES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
/** The kind of a medio de pago. */
export const METHOD_KINDS = ["cash", "transfer", "card", "check", "other"] as const;
export type MethodKind = (typeof METHOD_KINDS)[number];
/** The withholdings a customer practises when it pays (accounting design §5.4, the 2A fixture `payment-received`): retefuente, reteIVA, reteICA. */
export const WITHHOLDING_KINDS = ["income", "vat", "ica"] as const;
export type WithholdingKind = (typeof WITHHOLDING_KINDS)[number];

const maestroLifecycle = (f: F): FieldDef[] => [
  f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
];

export const methodEntity: EntityDef = entity("payments.method", "maestro", "methods", "name", (f) => [
  f("seq", "number", { required: true }),
  f("code", "text", { required: true, searchable: true }),
  f("name", "text", { required: true, searchable: true }),
  f("kind", "enum", { required: true, enumValues: [...METHOD_KINDS], valuesKey: "payments.values.method_kind" }),
  /** The DIAN payment means code (table 13.3.4.2) the method stands for, validated by the country pack. */
  f("means_code", "text"),
  /** The currency of the money the method receives (plan 2B.2 Task 34.5, FX §6): a receipt goes only through a method of its currency. */
  f("currency", "text", { required: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { importKey: ["code"], cloneReset: ["seq", "code"], recordPage: true });

export const cashBoxEntity: EntityDef = entity("payments.cash_box", "maestro", "cash_boxes", "name", (f) => [
  f("seq", "number", { required: true }),
  f("code", "text", { required: true, searchable: true }),
  f("name", "text", { required: true, searchable: true }),
  f("description", "text", { searchable: true }),
  f("is_active", "boolean"),
  ...trailer(f),
  ...maestroLifecycle(f),
], { importKey: ["code"], cloneReset: ["seq", "code"], recordPage: true });

export const receiptEntity: EntityDef = entity("payments.receipt", "documento", "receipts", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("date", "date", { required: true }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("method_id", "ref", { required: true, ...ref("payments.method", "name") }),
  /** The method's code when the receipt was posted: the dimension its cash or bank line was resolved by. */
  f("method_code", "text", { required: true }),
  f("cash_box_id", "ref", ref("payments.cash_box", "name")),
  f("reference", "text", { searchable: true }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  /** The money received (Dr cash / bank). */
  f("amount", "money", { required: true }),
  /** What the receipt settles of the customer's invoices: the sum of its allocations (cash + withholdings), Cr receivable. */
  f("applied", "money", { required: true }),
  /** The withholdings the customer practised on the invoices (Dr withholdings suffered). */
  f("withholding_total", "money", { required: true }),
  /** The money received not applied to any invoice: a customer advance (Cr customer_advances). */
  f("advance", "money", { required: true }),
  f("notes", "text", { searchable: true }),
  f("applied_at", "datetime"),
  f("voided_at", "datetime"),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "payments.receipt_allocation", parentField: "receipt_id" },
    ownFlags: { requiresApproval: "payments.receipt.own_flags.requires_approval", posts: "payments.receipt.own_flags.posts" },
  },
  processIds: { create: "payments.payment.receive" },
  // A copy (Duplicar) keeps the customer, the method and the caja only: the money, the reference and the state are the new receipt's, which
  // is written by «Registrar pago» with its own allocations (the create process re-checks everything).
  cloneReset: ["seq", "number", "date", "amount", "applied", "withholding_total", "advance", "reference", "notes", "method_code", "applied_at", "voided_at", "void_reason"],
  defaultSort: { field: "seq", dir: "desc" },
  // Its page /r/payments.receipt/<id> (Task 24b): references to a receipt link there (rule 21).
  recordPage: true,
});

export const allocationEntity: EntityDef = entity("payments.receipt_allocation", "lines", "receipt_allocations", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("receipt_id", "ref", { required: true, ...ref("payments.receipt", "number") }),
  f("line_no", "number", { required: true }),
  f("invoice_id", "uuid", { required: true }),
  f("invoice_number", "text", { searchable: true }),
  /** What the allocation settles of the invoice (cash + withholdings), in the invoice's currency. */
  f("amount", "money", { required: true }),
  /** The same in the receipt's currency (FX §6): equal to `amount` unless pesos settle a foreign-currency invoice. */
  f("amount_receipt", "money", { required: true }),
  /** The same in the company's currency at the invoice's rate: what the allocation takes off the receivable (FX §4, §5). */
  f("amount_company", "money", { required: true }),
  /** The money of the receipt it took, in the receipt's currency. */
  f("cash_amount", "money", { required: true }),
  f("withholding_total", "money", { required: true }),
  f("withholdings", "json", { sortable: false }),
  ...trailer(f),
]);

export const applicationEntity: EntityDef = entity("payments.advance_application", "documento", "advance_applications", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("date", "date", { required: true }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("currency", "text", { required: true }),
  /** What the application moves from the customer's advances to its invoices: the sum of its lines (Dr customer_advances / Cr receivable). */
  f("total", "money", { required: true }),
  f("applied_at", "datetime"),
  f("voided_at", "datetime"),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "payments.advance_application_line", parentField: "application_id" },
    ownFlags: { requiresApproval: "payments.advance_application.own_flags.requires_approval", posts: "payments.advance_application.own_flags.posts" },
  },
  processIds: { create: "payments.advance.apply" },
  // An application is written by «Aplicar a facturas» with its own lines: a copy has no meaning, nothing but the customer is kept.
  cloneReset: ["seq", "number", "date", "total", "applied_at", "voided_at", "void_reason"],
  defaultSort: { field: "seq", dir: "desc" },
  recordPage: true,
});

export const applicationLineEntity: EntityDef = entity("payments.advance_application_line", "lines", "advance_application_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("application_id", "ref", { required: true, ...ref("payments.advance_application", "number") }),
  f("line_no", "number", { required: true }),
  f("receipt_id", "ref", { required: true, ...ref("payments.receipt", "number") }),
  f("receipt_number", "text", { searchable: true }),
  f("invoice_id", "uuid", { required: true }),
  f("invoice_number", "text", { searchable: true }),
  /** What the line draws from the receipt's advance and settles of the invoice. */
  f("amount", "money", { required: true }),
  /** The same in the company's currency (FX §11; equal to `amount` until advances take a foreign currency, plan 2B.2 Task 34.6). */
  f("amount_company", "money", { required: true }),
  ...trailer(f),
]);

export const PAYMENTS_ENTITIES: EntityDef[] = [methodEntity, cashBoxEntity, receiptEntity, allocationEntity, applicationEntity, applicationLineEntity];
