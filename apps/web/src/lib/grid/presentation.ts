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
  /**
   * The grid's identity column (OD-4): first, pinned while the grid scrolls sideways, never moved. The entity's
   * display field when absent; the audit names its entries by their date.
   */
  title?: string;
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
  // Movimientos (accounting design §5.14): the line's comprobante number names the row; the dimension columns beyond the
  // cost center stay in the chooser until the company uses them (the page's initial state adds them).
  "accounting.ledger_line": {
    title: "number",
    shown: ["number", "date", "journal_code", "account_code", "account_name", "party_name", "cost_center_name", "description", "debit", "credit", "net", "status"],
    exclude: [],
    fields: {
      status: { valuesKey: "accounting.values.entry_status", pills: { draft: "gray", pending: "warn", posted: "ok", reversed: "info", voided: "danger" } },
      origin: { valuesKey: "accounting.values.entry_origin" },
      account_level: { valuesKey: "accounting.values.account_level" },
      account_code: { display: "mono" },
      journal_code: { display: "mono" },
    },
  },
  // Comprobantes (accounting design §4.6, §8): the number names the row; a draft has none yet, so the date leads the columns after it.
  "accounting.entry": {
    title: "number",
    shown: ["number", "date", "journal_id", "description", "total_debit", "status", "origin"],
    exclude: ["extra", "extra_free"],
    fields: {
      number: { display: "mono" },
      status: { valuesKey: "accounting.values.entry_status", pills: { draft: "gray", pending: "warn", posted: "ok", reversed: "info", voided: "danger" } },
      origin: { valuesKey: "accounting.values.entry_origin" },
    },
  },
  // Plan de cuentas (accounting design §8): the code names the row; Seguridad is the access column, restricted ones in amber.
  "accounting.account": {
    shown: ["code", "name", "level", "nature", "parent_id", "access", "allows_movement", "is_active", "period_figure"],
    exclude: ["extra", "extra_free"],
    fields: {
      code: { display: "mono" },
      level: { valuesKey: "accounting.values.account_level" },
      nature: { valuesKey: "accounting.values.nature" },
      access: { valuesKey: "accounting.values.account_access", pills: { open: "gray", restricted: "warn" } },
      allows_movement: ready,
      is_active: active,
    },
  },
  // The four analytic dimensions share one shape (§4.5): código, descripción, padre, tipo, estado.
  ...Object.fromEntries(
    ["accounting.cost_center", "accounting.open_auxiliary", "accounting.item", "accounting.business_unit"].map((id) => [
      id,
      {
        shown: ["code", "name", "parent_id", "kind", "is_active", "period_figure"],
        exclude: ["extra", "extra_free"],
        fields: { code: { display: "mono" }, kind: { valuesKey: "accounting.values.dimension_kind", pills: { group: "info", leaf: "gray" } }, is_active: active },
      } satisfies GridPresentation,
    ]),
  ),
  // Fuentes (§4.3, §10b.18): the consecutivo is the next number the journal will give.
  "accounting.journal": {
    shown: ["code", "name", "kind", "next_number", "manual_entries", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: { code: { display: "mono" }, kind: { valuesKey: "accounting.values.journal_kind" }, manual_entries: ready, is_active: active },
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
  // Auditoría (prototype v5 renderAudit): date, origin as a pill, process, entity, record, action, actor and chain.
  "kernel.audit": {
    title: "occurred_at",
    shown: ["occurred_at", "origin", "process_id", "entity", "row_id", "action", "actor", "chain_id"],
    exclude: [],
    fields: {
      origin: { valuesKey: "grid.values.audit_origin", pills: { ui: "info", agent: "ok", scheduler: "gray", event: "gray", api: "warn", db: "danger" } },
      action: { valuesKey: "grid.values.audit_action", pills: { insert: "ok", update: "info", delete: "danger", consult: "gray", denied: "warn" } },
      // Proceso, Entidad and Registro show names (the audit screen's cells), their ids in mono only where no name exists.
      chain_id: { display: "mono" },
      actor_user_id: { display: "mono" },
      conversation_id: { display: "mono" },
      source_row_id: { display: "mono" },
    },
  },
  "support.ticket": {
    shown: ["seq", "kind", "title", "status", "priority", "created_at"],
    exclude: ["extra", "extra_free", "context"],
    fields: {
      kind: { valuesKey: "grid.values.ticket_kind", pills: { bug: "danger", question: "info", request: "gray" } },
      status: { valuesKey: "grid.values.ticket_status", pills: { open: "warn", answered: "ok", closed: "gray" } },
      priority: { valuesKey: "grid.values.ticket_priority", pills: { low: "gray", normal: "info", high: "danger" } },
    },
  },
};

/** The entity's presentation; an entity without one shows every field but the internal JSON. */
export const presentationOf = (entityId: string): GridPresentation => PRESENTATIONS[entityId] ?? { shown: [], exclude: ["extra", "extra_free"], fields: {} };
