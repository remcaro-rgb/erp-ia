import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the core module (design §5.8a, §5.8b, §5.15, §5.18). Labels are i18n keys
// (`entity.<id>`, `field.<id>.<column>`), filled by the catalogues of Task 11. Fiscal code columns
// (document type, tax scheme, IVA rate…) are plain text: their values and labels belong to the
// country pack, not to the module (`codes` names the pack's table; `valuesKey` the catalogue's labels of an enum). `text[]` columns are typed `json` until the registry has a list type.
// The masked views `core.v_<table>` in migration 0006 are generated from these definitions.

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}

function entity(id: string, entityType: EntityType, table: string, displayField: string, fields: (f: ReturnType<typeof fieldsOf>) => FieldDef[]): EntityDef {
  return {
    id,
    module: "core",
    schema: "core",
    table,
    label: `entity.${id}`,
    entityType,
    displayField,
    defaultSort: { field: displayField, dir: "asc" },
    fields: fields(fieldsOf(id)),
  };
}

/** Columns every company table of the module carries after its own (rule 7). */
const trailer = (f: ReturnType<typeof fieldsOf>): FieldDef[] => [
  f("extra", "json", { sortable: false }),
  f("extra_free", "json", { sortable: false }),
  f("created_at", "datetime"),
  f("updated_at", "datetime"),
];

/** The states of a maestro (entity types spec §5.1): no Contabilizado, no Anulado (D6). */
export const MAESTRO_STATES = ["draft", "saved", "pending", "rejected", "approved"];

/**
 * The lifecycle columns of a maestro (kernel.typed_columns, migration 0042), published by its masked view: the state, written only by
 * the lifecycle, and the Requiere aprobación flag copied from the company's settings when the record is created. They follow the
 * trailer because the views of 0006 are replaced in place (`create or replace view` only appends columns). Activo (`is_active`) is
 * listed by each entity, where its view already has it.
 */
const lifecycle = (f: ReturnType<typeof fieldsOf>): FieldDef[] => [
  f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
];

// The import refuses a file row that repeats an earlier one on the record's unique key (design §9).
export const party: EntityDef = {
  ...entity("core.party", "maestro", "parties", "legal_name", (f) => [
    f("seq", "number", { required: true }),
    f("kind", "enum", { required: true, enumValues: ["customer", "supplier", "employee"], valuesKey: "grid.values.party_kind", list: true }),
    f("person_type", "text", { required: true, valuesKey: "grid.values.person_type" }),
    f("document_type", "text", { required: true, codes: "documentTypes" }),
    f("document_number", "text", { required: true, searchable: true }),
    f("check_digit", "text"),
    f("legal_name", "text", { required: true, searchable: true }),
    f("first_surname", "text"),
    f("second_surname", "text"),
    f("first_name", "text"),
    f("other_names", "text"),
    f("trade_name", "text", { searchable: true }),
    f("tax_responsibilities", "json", { codes: "responsibilities", list: true }),
    f("tax_scheme", "text", { codes: "taxSchemes" }),
    f("ciiu", "text"),
    f("country_code", "text", { codes: "countries" }),
    f("department_code", "text", { codes: "departments" }),
    f("municipality_code", "text", { codes: "municipalities" }),
    f("address_line", "text"),
    f("postal_code", "text"),
    f("invoice_email", "text"),
    f("supplier_email", "text"),
    f("phone_cc", "text"),
    f("phone", "text"),
    f("contact_name", "text"),
    f("credit_limit", "money", { sensitivity: "confidential" }),
    f("balance", "money", { sensitivity: "confidential" }),
    f("dian_status", "text"),
    f("dian_missing", "json", { list: true }),
    f("invoice_ready", "boolean"),
    f("is_active", "boolean"),
    ...trailer(f),
    ...lifecycle(f),
  ]),
  importKey: ["document_type", "document_number"],
  typed: {
    lines: { entity: "core.party_contact", parentField: "party_id" },
    // D10: the identification, the name and the tax data send an approved party back to approval (Pendiente de Aprobación).
    approvalFields: [
      "kind", "person_type", "document_type", "document_number", "check_digit", "legal_name", "first_surname", "second_surname", "first_name",
      "other_names", "tax_responsibilities", "tax_scheme",
    ],
  },
  // Opens in its own record frame at /r/<entity>/<id> (rule 21: references to it are links).
  recordPage: true,
  // A clone (rule 37) starts without the identification (the DV goes with the number) and the state the server derives.
  cloneReset: ["document_number", "check_digit", "seq", "dian_status", "invoice_ready"],
};

// A contact has no unique field: its clone keeps every visible value (still created through core.contact.create).
export const partyContact = entity("core.party_contact", "lines", "party_contacts", "name", (f) => [
  f("seq", "number", { required: true }),
  f("party_id", "ref", { required: true, ref: { entity: "core.party", display: "legal_name" } }),
  f("name", "text", { required: true, searchable: true }),
  f("job_title", "text"),
  f("email", "text"),
  f("phone_cc", "text"),
  f("phone", "text"),
  f("ext", "text"),
  f("mobile_cc", "text"),
  f("mobile", "text"),
  ...trailer(f),
]);

// Its processes are named `core.category.*`: the importer creates categories through `core.category.create`. Its `status` was
// active / inactive until 0042; it is the lifecycle state now, and Activo is `is_active` (appended after the trailer like the
// other lifecycle columns, because the view is replaced in place).
export const productCategory: EntityDef = {
  ...entity("core.product_category", "maestro", "product_categories", "name", (f) => [
    f("seq", "number", { required: true }),
    f("name", "text", { required: true, searchable: true }),
    f("iva_rate", "text", { required: true, codes: "ivaRates" }),
    f("inc_rate", "text", { codes: "incRates" }),
    f("other_taxes", "json", { codes: "otherTaxes", list: true }),
    f("default_uom", "text", { codes: "uoms" }),
    f("income_account", "text"),
    f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
    ...trailer(f),
    f("is_active", "boolean"),
    f("requires_approval", "boolean"),
  ]),
  processIds: { create: "core.category.create" },
  // D10: the taxes products copy from it.
  typed: { approvalFields: ["iva_rate", "inc_rate", "other_taxes", "income_account"] },
  // Opens in its own record frame at /r/<entity>/<id> (rule 21: references to it are links).
  recordPage: true,
  importKey: ["name"],
  // The name is the category's unique key.
  cloneReset: ["name"],
};

export const product: EntityDef = {
  ...entity("core.product", "maestro", "products", "description", (f) => [
    f("seq", "number", { required: true }),
    f("sku", "text", { required: true, searchable: true }),
    f("description", "text", { required: true, searchable: true }),
    f("kind", "enum", { required: true, enumValues: ["good", "service"], valuesKey: "grid.values.product_kind" }),
    f("id_scheme", "text", { required: true, codes: "idSchemes" }),
    f("standard_code", "text", { searchable: true }),
    f("brand", "text"),
    f("model", "text"),
    f("category_id", "ref", { ref: { entity: "core.product_category", display: "name" } }),
    f("uom_code", "text", { required: true, codes: "uoms" }),
    f("iva_rate", "text", { required: true, codes: "ivaRates" }),
    f("inc_rate", "text", { codes: "incRates" }),
    f("other_taxes", "json", { codes: "otherTaxes", list: true }),
    f("tax_override", "boolean"),
    f("list_price", "money", { required: true }),
    f("is_free_sample", "boolean"),
    f("reference_price_type", "text", { codes: "priceTypes" }),
    f("reference_price", "money"),
    f("standard_cost", "money", { sensitivity: "confidential" }),
    f("track_stock", "boolean"),
    f("min_stock", "number"),
    f("supplier_id", "ref", { ref: { entity: "core.party", display: "legal_name" } }),
    f("dian_status", "text"),
    f("dian_missing", "json", { list: true }),
    f("invoice_ready", "boolean"),
    f("is_active", "boolean"),
    ...trailer(f),
    ...lifecycle(f),
  ]),
  importKey: ["sku"],
  // D10: what the electronic invoice states about the product.
  typed: { approvalFields: ["sku", "description", "kind", "id_scheme", "standard_code", "uom_code", "iva_rate", "inc_rate", "other_taxes"] },
  // Opens in its own record frame at /r/<entity>/<id> (rule 21: references to it are links).
  recordPage: true,
  cloneReset: ["sku", "seq"],
};

/** Global reference table (no company): the DIAN units of measure seeded from the country pack. */
export const uom = entity("core.uom", "parametro", "uoms", "code", (f) => [f("code", "text", { required: true, searchable: true }), f("name", "text", { searchable: true })]);

// The price list has no `code` column: its unique key is the name (unique (company_id, name)).
export const priceList: EntityDef = {
  ...entity("core.price_list", "maestro", "price_lists", "name", (f) => [
    f("seq", "number", { required: true }),
    f("name", "text", { required: true, searchable: true }),
    f("currency_code", "text", { required: true }),
    ...trailer(f),
    ...lifecycle(f),
    f("is_active", "boolean"),
  ]),
  importKey: ["name"],
  typed: { lines: { entity: "core.price_list_item", parentField: "price_list_id" }, approvalFields: ["name", "currency_code"] },
};

export const priceListItem = entity("core.price_list_item", "lines", "price_list_items", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("price_list_id", "ref", { required: true, ref: { entity: "core.price_list", display: "name" } }),
  f("product_id", "ref", { required: true, ref: { entity: "core.product", display: "description" } }),
  f("price", "money", { required: true }),
  ...trailer(f),
]);

export const documentSequence = entity("core.document_sequence", "parametro", "document_sequences", "document_type", (f) => [
  f("seq", "number", { required: true }),
  f("document_type", "text", { required: true, searchable: true }),
  f("prefix", "text"),
  f("next_number", "number", { required: true }),
  f("padding", "number"),
  f("resolution", "json", { sortable: false }),
  ...trailer(f),
]);

/** Where a rate came from (plan 2B.2 Task 34.1, FX §2): the country's official rate (the TRM) or typed by a user. */
export const RATE_SOURCES = ["trm", "manual"] as const;

// Tasas de cambio (Núcleo › Parámetros, FX §2, migration 0147): one rate per company, currency and day, in company currency per unit
// (pesos per dollar). A TRM row is written by the daily import; a manual one by core.exchange_rate.set, or by override_official over a TRM
// row (official_rate then keeps the published TRM, as it does for a manual day the import skipped). Not sensitive (FX §10).
export const exchangeRate: EntityDef = {
  ...entity("core.exchange_rate", "parametro", "exchange_rates", "rate_date", (f) => [
    f("seq", "number", { required: true }),
    f("currency", "text", { required: true, searchable: true }),
    f("rate_date", "date", { required: true }),
    f("rate", "number", { required: true }),
    f("source", "enum", { required: true, enumValues: [...RATE_SOURCES], valuesKey: "core.exchange_rates.values.source" }),
    f("official_rate", "number"),
    f("note", "text"),
    ...trailer(f),
  ]),
  defaultSort: { field: "rate_date", dir: "desc" },
  processIds: { create: "core.exchange_rate.set" },
};

/** What the import did for a currency and day: wrote (or found) the official rate, or could not read it. */
export const RATE_IMPORT_STATUSES = ["imported", "failed"] as const;

// The import log (migration 0147): one row per company, currency and day the official-rate import asked for, with how many times it ran
// and what it wrote or why it failed. A failed row is the subject of the kernel recommendation core.trm_import_failed (one open per day,
// owner item 121; Task 38 API), closed by a later import that reads that day's rate.
export const exchangeRateImport = entity("core.exchange_rate_import", "sistema", "exchange_rate_imports", "rate_date", (f) => [
  f("seq", "number", { required: true }),
  f("currency", "text", { required: true }),
  f("rate_date", "date", { required: true }),
  f("status", "enum", { required: true, enumValues: [...RATE_IMPORT_STATUSES], valuesKey: "core.exchange_rates.values.import_status" }),
  f("attempts", "number", { required: true }),
  f("written", "number", { required: true }),
  f("error", "text"),
  ...trailer(f),
]);

export const CORE_ENTITIES: EntityDef[] = [party, partyContact, productCategory, product, uom, priceList, priceListItem, documentSequence, exchangeRate, exchangeRateImport];
