import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the invoicing module (design §8, §8.1; plan 2B Task 16). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`); enum
// values read `invoicing.values.*`. Field names are the column names; the masked views `invoicing.v_<table>` of migration 0092 are generated
// from these definitions (entities.test.ts fails when they drift).
//
//  - invoicing.settings (parametro, one row per company): how invoices are created (OD-2: manual, on_delivery, on_order_confirmation), the
//    DIAN environment the CUFE names (habilitación until the company goes live, Task 19), the default cost center of the revenue line (the
//    demo chart's 4135 asks for one) and the days of credit of a sale on credit.
//  - invoicing.invoice (documento, contabiliza): a sale invoice. Borrador while it is written (never numbered: Eliminar removes it,
//    entity types D1); «Emitir» (invoicing.invoice.issue, the Grabar of the invoice) checks it, numbers it by the DIAN resolution (D9, on
//    save), computes its CUFE and posts it in the same transaction (D8: receivable / revenue / IVA, the `invoice-issued` rule). `stage` is
//    the commercial state (draft → issued → paid, Task 23; voided once the DIAN accepts its annulment credit note, OD-7, Task 18) and
//    `dian_status` the DIAN's (draft → submitted → accepted | rejected, Task 17).
//  - invoicing.invoice_line (lines): one product sold, its price, discount and the taxes the country pack computed; the pedido line and
//    the entrega line it bills when it comes from a sale (sales' ids, named, never referenced across schemas, rule 3).
//  - invoicing.invoice_tax (sistema): the invoice's taxes per tax and rate (the engine's `taxes`), with the ledger's code.
//  - invoicing.invoice_recommendation (sistema): an automatic invoice (OD-2) that could not be issued (customer or product not ready, a
//    refusal of the issue): the draft stays and this row tells why, until it is issued (the module's own table, like costing.cost_missing:
//    kernel.recommendations is agent-shaped).

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "invoicing",
    schema: "invoicing",
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
 * A company-currency amount stored beside its document amount (Task 34.4, FX §4, rule 8; owner item 120): written by «Emitir» (never by
 * a form, so read-only), at the twin's sensitivity and shown only where the twin is: a role that masks the document amount reads its
 * peso equivalent masked too (FX §10, rule 14).
 */
const companyTwin = (entityId: string, column: string, twin: string): Pick<FieldDef, "viewExpr"> => ({
  viewExpr: `case when (select kernel.field_visible('${entityId}', '${twin}')) then "${column}" else null end`,
});

/** How invoices are created (OD-2, main design §22.25). */
export const INVOICE_CREATION = ["manual", "on_delivery", "on_order_confirmation"] as const;
export type InvoiceCreation = (typeof INVOICE_CREATION)[number];
/** The DIAN environment the CUFE and the submission name. */
export const DIAN_ENVIRONMENTS = ["habilitacion", "produccion"] as const;
/** Where an invoice stands commercially, beside its lifecycle status. */
export const INVOICE_STAGES = ["draft", "issued", "paid", "voided"] as const;
export type InvoiceStage = (typeof INVOICE_STAGES)[number];
/** Where it stands with the DIAN (Task 17 moves it past draft). */
export const DIAN_STATUSES = ["draft", "submitted", "accepted", "rejected"] as const;
/** How the invoice came to be: written by hand, from pedidos (invoicing.invoice.from_orders) or by one of the automatic modes. */
export const INVOICE_ORIGINS = ["manual", "from_orders", "on_delivery", "on_order_confirmation"] as const;
export const RECOMMENDATION_STATUSES = ["open", "resolved"] as const;
export const TAX_FAMILIES = ["IVA", "INC", "OTHER"] as const;

/** The lifecycle states of a documento (entity types spec §5). */
export const DOCUMENT_STATES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];

export const settingsEntity: EntityDef = entity("invoicing.settings", "parametro", "settings", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("invoice_creation", "enum", { required: true, enumValues: [...INVOICE_CREATION], valuesKey: "invoicing.values.invoice_creation" }),
  f("dian_environment", "enum", { required: true, enumValues: [...DIAN_ENVIRONMENTS], valuesKey: "invoicing.values.dian_environment" }),
  f("default_cost_center_id", "uuid"),
  f("credit_days", "number", { required: true }),
  // The DIAN submission (Task 17): the software registered with the DIAN (its PIN is a secret, never a column: rule 12), the habilitación
  // test set and the company's fiscal profile the document names as issuer. Task 19's Parámetros page edits them.
  f("software_id", "text"),
  f("software_provider_tax_id", "text"),
  f("test_set_id", "text"),
  f("issuer_tax_responsibilities", "json", { codes: "responsibilities", list: true, sortable: false }),
  f("issuer_tax_scheme", "text", { required: true }),
  f("issuer_department_code", "text"),
  f("issuer_municipality_code", "text"),
  // Task 19: the switch to producción needs the DIAN defaults confirmed (Task 18's CreditNoteTypeCode 91, CustomizationID 10 for exports, no
  // InvoiceControl on notes); the signing certificate and the software PIN live in the secret store (rule 12): the settings keep only what
  // the certificate says of itself (subject, NIT, issuer, serial, validity) and when each was uploaded, never their content.
  f("dian_defaults_confirmed", "boolean", { required: true }),
  // Task 35 (R35-7): the version of the DIAN checklist the confirmation was made at (null when not confirmed). The confirmation counts only
  // while it equals the pack's current version and every item is ticked.
  f("dian_checklist_version", "number"),
  f("certificate_subject", "text"),
  f("certificate_tax_id", "text"),
  f("certificate_issuer", "text"),
  f("certificate_serial", "text"),
  f("certificate_valid_from", "datetime"),
  f("certificate_valid_to", "datetime"),
  f("certificate_uploaded_at", "datetime"),
  f("software_pin_set_at", "datetime"),
  // Task 19 fix round 1: the SHA-256 of the .p12 kept in the secret store, so the consult tells metadata that no longer matches the stored
  // certificate (the secret is written first, on its own connection; a run that failed after it leaves the old metadata).
  f("certificate_fingerprint", "text"),
  ...trailer(f),
  // Task 28.4 (RG-5, owner item 150 pending the accountant): the lots and serials of each line go into the electronic invoice's XML
  // (cac:ItemInstance) only while this is on; default off. Step-up, like the other DIAN settings (invoicing.settings.update).
  f("dian_item_instance", "boolean", { required: true }),
]);

export const invoiceEntity: EntityDef = entity("invoicing.invoice", "documento", "invoices", "number", (f) => [
  f("seq", "number", { required: true }),
  f("number", "text", { searchable: true }),
  f("prefix", "text"),
  f("consecutive", "number"),
  f("cufe", "text", { searchable: true }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("issue_date", "date", { required: true }),
  f("issue_time", "text"),
  f("due_date", "date"),
  /** The date of what the invoice bills (the entrega's or the pedido's, or the Borrador's own date): «Emitir» dates the invoice today (ruling, fix round 1). */
  f("service_date", "date"),
  /** The day the Borrador's prices were set (creation, a change of its lines, or «Recalcular precios»); «Emitir» leaves it and warns when it is not the issue date (owner item 17). */
  f("price_date", "date"),
  f("payment_form", "enum", { required: true, enumValues: ["1", "2"], valuesKey: "invoicing.values.payment_form" }),
  f("payment_means", "text", { required: true }),
  f("stage", "enum", { required: true, enumValues: [...INVOICE_STAGES], valuesKey: "invoicing.values.stage" }),
  f("dian_status", "enum", { required: true, enumValues: [...DIAN_STATUSES], valuesKey: "invoicing.values.dian_status" }),
  f("origin", "enum", { required: true, enumValues: [...INVOICE_ORIGINS], valuesKey: "invoicing.values.origin" }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("subtotal", "money", { required: true }),
  f("discount_total", "money", { required: true }),
  f("tax_total", "money", { required: true }),
  f("total", "money", { required: true }),
  f("total_company", "money", { required: true }),
  f("paid_amount", "money", { required: true }),
  f("credited_amount", "money", { required: true }),
  /** What the debit notes of the invoice added (Task 18): the customer owes it on top of the total. */
  f("debited_amount", "money", { required: true }),
  f("resolution", "json", { sortable: false }),
  f("cost_center_id", "uuid"),
  f("issued_at", "datetime"),
  f("annulment_note_id", "uuid"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "invoicing.invoice_line", parentField: "invoice_id" },
    ownFlags: { requiresApproval: "invoicing.invoice.own_flags.requires_approval", posts: "invoicing.invoice.own_flags.posts" },
  },
  processIds: { create: "invoicing.invoice.create" },
  // Task 20: the invoice opens at /r/invoicing.invoice/<id> (Datos · Líneas e impuestos · Contabilidad · DIAN).
  recordPage: true,
  // A copy is a new Borrador: today's date, no number, no CUFE, nothing issued, paid or sent (the pages come with Task 20).
  cloneReset: ["seq", "number", "prefix", "consecutive", "cufe", "issue_date", "issue_time", "due_date", "service_date", "price_date", "stage", "dian_status", "origin", "resolution", "issued_at", "annulment_note_id", "paid_amount", "credited_amount", "debited_amount"],
  defaultSort: { field: "seq", dir: "desc" },
});

/**
 * The text of invoice_lines.lots (jsonb `[{ lotCode, expiresOn, serialNo, qty }]`) the masked view shows, in the order the lots left: a
 * serial that sits in a lot reads `code · number · expiry · qty` (migration 0169), never one of them only.
 */
const INVOICE_LINE_LOTS_EXPR =
  "(select string_agg(concat_ws(' · ', x.e->>'lotCode', x.e->>'serialNo', x.e->>'expiresOn', x.e->>'qty'), '; ' order by x.n) from jsonb_array_elements(invoice_lines.lots) with ordinality as x(e, n))";

export const invoiceLineEntity: EntityDef = entity("invoicing.invoice_line", "lines", "invoice_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("invoice_id", "ref", { required: true, ...ref("invoicing.invoice", "number") }),
  f("line_no", "number", { required: true }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("description", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("unit_price", "money", { required: true }),
  f("discount_pct", "number", { required: true }),
  f("discount", "money", { required: true }),
  f("base", "money", { required: true }),
  f("iva_rate", "text"),
  f("iva", "money", { required: true }),
  f("inc_rate", "text"),
  f("inc", "money", { required: true }),
  f("other_taxes", "money", { required: true }),
  f("total", "money", { required: true }),
  f("subtotal_company", "money", companyTwin("invoicing.invoice_line", "subtotal_company", "base")),
  f("free_sample", "boolean", { required: true }),
  f("category_id", "uuid"),
  f("order_id", "uuid"),
  f("order_line_id", "uuid"),
  f("delivery_id", "uuid"),
  f("delivery_line_id", "uuid"),
  ...trailer(f),
  // «Lote / Vence / Serie» (Task 28.4, RG-5): the lots and serials the line bills, copied from the entrega line it was written from
  // (invoice_lines.lots, frozen at «Emitir»), read as `code · expiry · qty` (a serial: `number · qty`; both: `code · number · expiry · qty`).
  f("lots", "text", { sortable: false, filterable: false, viewExpr: INVOICE_LINE_LOTS_EXPR }),
]);

export const invoiceTaxEntity: EntityDef = entity("invoicing.invoice_tax", "sistema", "invoice_taxes", "code", (f) => [
  f("seq", "number", { required: true }),
  f("invoice_id", "ref", { required: true, ...ref("invoicing.invoice", "number") }),
  // IVA, INC, OTHER: the tax engine's family names, shown as they are (no catalogue values).
  f("family", "enum", { required: true, enumValues: [...TAX_FAMILIES] }),
  f("code", "text", { required: true }),
  f("ledger_code", "text", { required: true }),
  f("rate", "number"),
  f("base", "money", { required: true }),
  f("amount", "money", { required: true }),
  f("amount_company", "money", companyTwin("invoicing.invoice_tax", "amount_company", "amount")),
  ...trailer(f),
]);

export const recommendationEntity: EntityDef = entity("invoicing.invoice_recommendation", "sistema", "invoice_recommendations", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("invoice_id", "ref", { required: true, ...ref("invoicing.invoice", "number") }),
  f("status", "enum", { required: true, enumValues: [...RECOMMENDATION_STATUSES], valuesKey: "invoicing.values.recommendation_status" }),
  f("code", "text", { required: true }),
  f("message", "text", { required: true, searchable: true }),
  f("details", "json", { sortable: false }),
  f("resolved_at", "datetime"),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

/** Where the DIAN submission of an issued invoice stands (Task 17). */
export const SUBMISSION_STATUSES = ["queued", "not_configured", "processing", "submitted", "accepted", "rejected", "failed"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

// invoicing.einvoice_submission (sistema, one per issued invoice): its DIAN submission (plan 2B Task 17). The e-invoice workflow builds the
// UBL document from the frozen invoice, signs it with the company's certificate, sends it through the EInvoiceTransport seam, polls the
// verdict by trackId, keeps the signed XML and the ApplicationResponse in the file store and records here the trackId, the attempts, the
// DIAN's errors of a rejection (the invoice page lists them) and the files. `round` counts the sendings after a rejection («Reintentar
// envío» of a corrected document: same number, same CUFE).
export const submissionEntity: EntityDef = entity("invoicing.einvoice_submission", "sistema", "einvoice_submissions", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("invoice_id", "ref", { required: true, ...ref("invoicing.invoice", "number") }),
  /** The note sent (Task 18); null: the invoice itself. invoice_id is then the invoice the note corrects (its read right is the note's). */
  f("note_id", "ref", ref("invoicing.note", "number")),
  f("status", "enum", { required: true, enumValues: [...SUBMISSION_STATUSES], valuesKey: "invoicing.values.submission_status" }),
  f("round", "number", { required: true }),
  f("attempts", "number", { required: true }),
  f("polls", "number", { required: true }),
  f("track_id", "text", { searchable: true }),
  f("run_id", "text"),
  f("cufe", "text"),
  f("errors", "json", { sortable: false }),
  f("last_error", "text"),
  f("xml_path", "text"),
  f("response_path", "text"),
  f("pdf_path", "text"),
  f("submitted_at", "datetime"),
  f("decided_at", "datetime"),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "desc" } });

// invoicing.dian_check (sistema, plan 2B Task 35): one row per item of the pack's DIAN checklist ever ticked in the company: who verified it and
// when. An untick keeps the row (ticked false, nobody, no time): the row audit holds every change. Only invoicing.dian_checklist.tick writes it.
export const dianCheckEntity: EntityDef = entity("invoicing.dian_check", "sistema", "dian_checks", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("item_key", "text", { required: true, searchable: true }),
  f("ticked", "boolean", { required: true }),
  f("ticked_by", "uuid"),
  f("ticked_at", "datetime"),
  ...trailer(f),
], { defaultSort: { field: "seq", dir: "asc" } });

/** Credit or debit (DIAN tables 13.1.5.2 / 13.1.5.3). */
export const NOTE_KINDS = ["credit", "debit"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** Where a note stands: Borrador while it is written, Emitida once numbered and posted (a DIAN note is never voided: OD-7). */
export const NOTE_STAGES = ["draft", "issued"] as const;

// invoicing.note (documento, contabiliza; plan 2B Task 18, OD-7): a credit or debit note of an issued invoice the DIAN accepted. Its
// concept comes from the pack's tables (13.2.4 credit, 13.2.5 debit); it names only an invoice, never another note (Oficio DIAN 129 of
// 2023). «Emitir» (invoicing.note.issue, the Grabar of a Borrador) checks it under the invoice's lock (a credit never exceeds what is left of
// the invoice), dates it on the company's today, numbers it by its own sequence (credit_note / debit_note) and posts it in its own month
// (inline and strict: the note-issued rule; a credit's amounts are negative, so its entry reverses the invoice's sides). It is then sent to
// the DIAN by the e-invoice workflow (its CUDE is computed there: it needs the software PIN). `annulment`: the full credit note of an
// Anular of the invoice (concept 2, CustomizationID 20); when the DIAN accepts it, the invoice is voided.
export const noteEntity: EntityDef = entity("invoicing.note", "documento", "notes", "number", (f) => [
  f("seq", "number", { required: true }),
  f("kind", "enum", { required: true, enumValues: [...NOTE_KINDS], valuesKey: "invoicing.values.note_kind" }),
  f("number", "text", { searchable: true }),
  f("prefix", "text"),
  f("consecutive", "number"),
  f("cude", "text", { searchable: true }),
  f("invoice_id", "ref", { required: true, ...ref("invoicing.invoice", "number") }),
  f("party_id", "ref", { required: true, ...ref("core.party", "legal_name") }),
  f("concept", "text", { required: true }),
  f("annulment", "boolean", { required: true }),
  f("reason", "text", { required: true, searchable: true }),
  f("issue_date", "date", { required: true }),
  f("issue_time", "text"),
  f("due_date", "date"),
  f("stage", "enum", { required: true, enumValues: [...NOTE_STAGES], valuesKey: "invoicing.values.note_stage" }),
  f("dian_status", "enum", { required: true, enumValues: [...DIAN_STATUSES], valuesKey: "invoicing.values.dian_status" }),
  f("currency", "text", { required: true }),
  f("exchange_rate", "number", { required: true }),
  f("subtotal", "money", { required: true }),
  f("tax_total", "money", { required: true }),
  f("total", "money", { required: true }),
  f("total_company", "money", { required: true }),
  f("resolution", "json", { sortable: false }),
  f("cost_center_id", "uuid"),
  f("issued_at", "datetime"),
  f("notes", "text", { searchable: true }),
  ...trailer(f),
  f("status", "enum", { required: true, enumValues: DOCUMENT_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
  f("posts", "boolean"),
  f("void_reason", "text"),
], {
  typed: {
    numbering: "on_save",
    lines: { entity: "invoicing.note_line", parentField: "note_id" },
    ownFlags: { requiresApproval: "invoicing.note.own_flags.requires_approval", posts: "invoicing.note.own_flags.posts" },
  },
  processIds: { create: "invoicing.note.create" },
  // Task 20: the note opens at /r/invoicing.note/<id>; it is written only from its invoice («Crear nota crédito / débito»), so it has no
  // create form and no Duplicar (a copy would name the same invoice lines again: a new note starts from the invoice).
  recordPage: true,
  defaultSort: { field: "seq", dir: "desc" },
});

// invoicing.note_line (lines): what the note corrects of one line of the invoice (the invoice line it names, its product, quantity and
// net unit price), taxed at the invoice line's rates on the invoice's date; the annulment copies every invoice line as it was issued.
export const noteLineEntity: EntityDef = entity("invoicing.note_line", "lines", "note_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("note_id", "ref", { required: true, ...ref("invoicing.note", "number") }),
  f("line_no", "number", { required: true }),
  f("invoice_line_id", "uuid", { required: true }),
  f("product_id", "ref", { required: true, ...ref("core.product", "description") }),
  f("description", "text", { searchable: true }),
  f("qty", "number", { required: true }),
  f("unit_price", "money", { required: true }),
  f("discount", "money", { required: true }),
  f("base", "money", { required: true }),
  f("iva_rate", "text"),
  f("iva", "money", { required: true }),
  f("inc_rate", "text"),
  f("inc", "money", { required: true }),
  f("other_taxes", "money", { required: true }),
  f("total", "money", { required: true }),
  f("subtotal_company", "money", companyTwin("invoicing.note_line", "subtotal_company", "base")),
  f("free_sample", "boolean", { required: true }),
  f("category_id", "uuid"),
  ...trailer(f),
]);

// invoicing.note_tax (sistema): the note's taxes per tax and rate, with the ledger's code (as the invoice's).
export const noteTaxEntity: EntityDef = entity("invoicing.note_tax", "sistema", "note_taxes", "code", (f) => [
  f("seq", "number", { required: true }),
  f("note_id", "ref", { required: true, ...ref("invoicing.note", "number") }),
  f("family", "enum", { required: true, enumValues: [...TAX_FAMILIES] }),
  f("code", "text", { required: true }),
  f("ledger_code", "text", { required: true }),
  f("rate", "number"),
  f("base", "money", { required: true }),
  f("amount", "money", { required: true }),
  f("amount_company", "money", companyTwin("invoicing.note_tax", "amount_company", "amount")),
  ...trailer(f),
]);

// «Por facturar» (Reportes, OD-2 manual; plan 2B Task 20 fix round 1, rule 20): a read-only query entity over invoicing.pending_lines
// (migration 0107), one row per shipped entrega line not yet on an invoice (invoicing.v_pending_to_invoice of 0093), so the page is the
// universal grid (filters, sort, pages, exports) with a selection column. The pedido and the entrega are sales' ids named by their numbers
// (rule 3: no reference across schemas); the customer and the product are core references. No price: the view's are unmasked (the invoice
// prices its lines), so the entity never carries one.
export const pendingLineEntity: EntityDef = {
  id: "invoicing.pending_line",
  module: "invoicing",
  schema: "invoicing",
  table: "pending_lines",
  label: "entity.invoicing.pending_line",
  kind: "query",
  displayField: "order_number",
  defaultSort: { field: "delivery_date", dir: "asc" },
  fields: (() => {
    const f = fieldsOf("invoicing.pending_line");
    return [
      f("order_id", "uuid"),
      f("order_number", "text", { searchable: true }),
      f("delivery_id", "uuid"),
      f("delivery_number", "text", { searchable: true }),
      f("delivery_date", "date"),
      f("party_id", "ref", ref("core.party", "legal_name")),
      f("product_id", "ref", ref("core.product", "description")),
      f("description", "text", { searchable: true }),
      f("delivered_qty", "number"),
      f("invoiced_qty", "number"),
      f("pending_qty", "number"),
    ];
  })(),
};

export const INVOICING_ENTITIES: EntityDef[] = [
  settingsEntity, invoiceEntity, invoiceLineEntity, invoiceTaxEntity, recommendationEntity, submissionEntity, noteEntity, noteLineEntity, noteTaxEntity,
  pendingLineEntity, dianCheckEntity,
];
