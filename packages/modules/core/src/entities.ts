import type { EntityDef, FieldDef, FieldType } from "@erp/kernel";

// Entities of the core module (design §5.8a, §5.8b, §5.15, §5.18). Labels are i18n keys
// (`entity.<id>`, `field.<id>.<column>`), filled by the catalogues of Task 11. Fiscal code columns
// (document type, tax scheme, IVA rate…) are plain text: their values and labels belong to the
// country pack, not to the module (`codes` names the pack's table; `valuesKey` the catalogue's labels of an enum). `text[]` columns are typed `json` until the registry has a list type.
// The masked views `core.v_<table>` in migration 0006 are generated from these definitions.

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}

function entity(id: string, table: string, displayField: string, fields: (f: ReturnType<typeof fieldsOf>) => FieldDef[]): EntityDef {
  return {
    id,
    module: "core",
    schema: "core",
    table,
    label: `entity.${id}`,
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

// The import refuses a file row that repeats an earlier one on the record's unique key (design §9).
export const party: EntityDef = {
  ...entity("core.party", "parties", "legal_name", (f) => [
    f("seq", "number", { required: true }),
    f("kind", "enum", { required: true, enumValues: ["customer", "supplier", "employee"], valuesKey: "grid.values.party_kind" }),
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
    f("tax_responsibilities", "json", { codes: "responsibilities" }),
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
    f("dian_missing", "json"),
    f("invoice_ready", "boolean"),
    f("is_active", "boolean"),
    ...trailer(f),
  ]),
  importKey: ["document_type", "document_number"],
  // A clone (rule 37) starts without the identification (the DV goes with the number) and the state the server derives.
  cloneReset: ["document_number", "check_digit", "seq", "dian_status", "invoice_ready"],
};

// A contact has no unique field: its clone keeps every visible value (still created through core.contact.create).
export const partyContact = entity("core.party_contact", "party_contacts", "name", (f) => [
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

// Its processes are named `core.category.*`: the importer creates categories through `core.category.create`.
export const productCategory: EntityDef = {
  ...entity("core.product_category", "product_categories", "name", (f) => [
    f("seq", "number", { required: true }),
    f("name", "text", { required: true, searchable: true }),
    f("iva_rate", "text", { required: true, codes: "ivaRates" }),
    f("inc_rate", "text", { codes: "incRates" }),
    f("other_taxes", "json", { codes: "otherTaxes" }),
    f("default_uom", "text", { codes: "uoms" }),
    f("income_account", "text"),
    f("status", "enum", { required: true, enumValues: ["active", "inactive"], valuesKey: "grid.values.category_status" }),
    ...trailer(f),
  ]),
  processIds: { create: "core.category.create" },
  importKey: ["name"],
  // The name is the category's unique key.
  cloneReset: ["name"],
};

export const product: EntityDef = {
  ...entity("core.product", "products", "description", (f) => [
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
    f("other_taxes", "json", { codes: "otherTaxes" }),
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
    f("dian_missing", "json"),
    f("invoice_ready", "boolean"),
    f("is_active", "boolean"),
    ...trailer(f),
  ]),
  importKey: ["sku"],
  cloneReset: ["sku", "seq"],
};

/** Global reference table (no company): the DIAN units of measure seeded from the country pack. */
export const uom = entity("core.uom", "uoms", "code", (f) => [f("code", "text", { required: true, searchable: true }), f("name", "text", { searchable: true })]);

export const priceList = entity("core.price_list", "price_lists", "name", (f) => [
  f("seq", "number", { required: true }),
  f("name", "text", { required: true, searchable: true }),
  f("currency_code", "text", { required: true }),
  ...trailer(f),
]);

export const priceListItem = entity("core.price_list_item", "price_list_items", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("price_list_id", "ref", { required: true, ref: { entity: "core.price_list", display: "name" } }),
  f("product_id", "ref", { required: true, ref: { entity: "core.product", display: "description" } }),
  f("price", "money", { required: true }),
  ...trailer(f),
]);

export const documentSequence = entity("core.document_sequence", "document_sequences", "document_type", (f) => [
  f("seq", "number", { required: true }),
  f("document_type", "text", { required: true, searchable: true }),
  f("prefix", "text"),
  f("next_number", "number", { required: true }),
  f("padding", "number"),
  f("resolution", "json", { sortable: false }),
  ...trailer(f),
]);

export const CORE_ENTITIES: EntityDef[] = [party, partyContact, productCategory, product, uom, priceList, priceListItem, documentSequence];
