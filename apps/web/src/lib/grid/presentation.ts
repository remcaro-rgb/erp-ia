import type { PillTone } from "@erp/ui";

// How each entity's grid presents its fields (prototype `ENTITIES`): the columns shown at first and their order,
// value labels (i18n keys or a code table the page supplies), pills and monospaced codes. Every other field of the
// registry stays available in the column chooser and the advanced filter.

export interface FieldPresentation {
  /** i18n key prefix of the values' labels (`grid.values.party_kind` → `.customer`). */
  valuesKey?: string;
  /** Named code table the page passes (`documentTypes`, `municipalities`, `categories`…). */
  table?: string;
  pills?: Record<string, PillTone>;
  display?: "mono" | "dian";
}

export interface GridPresentation {
  /** Fields shown at first, in order. */
  shown: string[];
  /** Fields never offered (internal JSON). */
  exclude: string[];
  fields: Record<string, FieldPresentation>;
}

const ready: FieldPresentation = { valuesKey: "grid.values.ready", pills: { true: "ok", false: "danger" } };
const active: FieldPresentation = { valuesKey: "grid.values.active", pills: { true: "ok", false: "gray" } };
const dian: FieldPresentation = { display: "dian" };

const PRESENTATIONS: Record<string, GridPresentation> = {
  "core.party": {
    shown: ["seq", "document_type", "document_number", "legal_name", "trade_name", "kind", "municipality_code", "invoice_email", "phone", "credit_limit", "balance", "dian_status", "invoice_ready", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: {
      document_type: { table: "documentTypes" },
      document_number: { display: "mono" },
      check_digit: { display: "mono" },
      kind: { valuesKey: "grid.values.party_kind" },
      person_type: { valuesKey: "grid.values.person_type" },
      tax_scheme: { table: "taxSchemes" },
      country_code: { table: "countries" },
      department_code: { table: "departments" },
      municipality_code: { table: "municipalities" },
      phone: { display: "mono" },
      ciiu: { display: "mono" },
      dian_status: dian,
      invoice_ready: ready,
      is_active: active,
    },
  },
  "core.product": {
    shown: ["seq", "sku", "description", "kind", "category_id", "standard_code", "uom_code", "iva_rate", "list_price", "standard_cost", "dian_status", "invoice_ready", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: {
      sku: { display: "mono" },
      standard_code: { display: "mono" },
      uom_code: { display: "mono" },
      kind: { valuesKey: "grid.values.product_kind" },
      category_id: { table: "categories" },
      id_scheme: { table: "idSchemes" },
      iva_rate: { table: "ivaRates" },
      inc_rate: { table: "incRates" },
      dian_status: dian,
      invoice_ready: ready,
      is_active: active,
    },
  },
  "core.product_category": {
    shown: ["seq", "name", "iva_rate", "inc_rate", "other_taxes", "default_uom", "income_account", "status"],
    exclude: ["extra", "extra_free"],
    fields: {
      iva_rate: { table: "ivaRates" },
      inc_rate: { table: "incRates" },
      default_uom: { display: "mono" },
      income_account: { display: "mono" },
      status: { valuesKey: "grid.values.category_status", pills: { active: "ok", inactive: "gray" } },
    },
  },
};

/** The entity's presentation; an entity without one shows every field but the internal JSON. */
export const presentationOf = (entityId: string): GridPresentation => PRESENTATIONS[entityId] ?? { shown: [], exclude: ["extra", "extra_free"], fields: {} };
