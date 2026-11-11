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
  /** See `GridColumn.marked`; the label is the value `value` under `valuesKey`. */
  marked?: { field: string; whenValue: string; value: string; tone: PillTone };
  display?: "mono" | "dian";
  /** i18n key of the text a reference reads as when the viewer cannot read its record (no name, no id, no link). */
  unavailableKey?: string;
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
/** A pedido reference of a delivery or return: a pedido the viewer cannot read (another salesperson's, Task 39) reads as plain text. */
const orderUnavailable: FieldPresentation = { unavailableKey: "sales.view.order_unavailable" };
const dian: FieldPresentation = { display: "dian" };
const recordStatus: FieldPresentation = { valuesKey: "grid.values.record_status", pills: { draft: "gray", saved: "info", pending: "warn", rejected: "danger", approved: "ok" } };
const documentStatus: FieldPresentation = { valuesKey: "grid.values.record_status", pills: { draft: "gray", saved: "ok", pending: "warn", rejected: "danger", approved: "ok", posted: "ok", voided: "danger" } };

/** An invoice's commercial stage and where it stands with the DIAN (plan 2B Task 20). */
const invoiceStage: FieldPresentation = { valuesKey: "invoicing.values.stage", pills: { draft: "gray", issued: "info", paid: "ok", voided: "danger" } };
const dianStatus: FieldPresentation = { valuesKey: "invoicing.values.dian_status", pills: { draft: "gray", submitted: "warn", accepted: "ok", rejected: "danger" } };

const PRESENTATIONS: Record<string, GridPresentation> = {
  "core.party": {
    // The state chip sits next to Listo para facturar (rule 10, Task 15): a Pendiente de Aprobación party reads as not usable.
    shown: ["seq", "document_type", "document_number", "legal_name", "trade_name", "kind", "municipality_code", "invoice_email", "phone", "credit_limit", "balance", "dian_status", "status", "invoice_ready", "is_active"],
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
      status: { valuesKey: "grid.values.record_status", pills: { draft: "gray", saved: "info", pending: "warn", rejected: "danger", approved: "ok" } },
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
      status: { valuesKey: "accounting.values.entry_status", pills: { draft: "gray", saved: "info", pending: "warn", rejected: "danger", approved: "ok", posted: "ok", voided: "danger" } },
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
      status: {
        valuesKey: "accounting.values.entry_status",
        pills: { draft: "gray", saved: "info", pending: "warn", rejected: "danger", approved: "ok", posted: "ok", voided: "danger" },
        // A posted comprobante with a reversal (reversed_by_id) reads «Revertido», in red (owner 2026-11-03).
        marked: { field: "reversed_by_id", whenValue: "posted", value: "reversed", tone: "danger" },
      },
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
    shown: ["seq", "name", "iva_rate", "inc_rate", "other_taxes", "default_uom", "income_account", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: {
      iva_rate: { table: "ivaRates" },
      inc_rate: { table: "incRates" },
      default_uom: { display: "mono" },
      income_account: { display: "mono" },
      // Activa (0042: the old active / inactive status became is_active; status is the lifecycle state). «Categoría» is feminine.
      is_active: { ...active, valuesKey: "grid.values.active_feminine" },
    },
  },
  // Tasas de cambio (plan 2B.2 Task 34.2, FX §5): the day, the currency, the rate and where it came from in words (TRM / Manual).
  "core.exchange_rate": {
    title: "rate_date",
    shown: ["rate_date", "currency", "rate", "source", "official_rate", "note"],
    exclude: [],
    fields: {
      currency: { display: "mono" },
      source: { valuesKey: "core.exchange_rates.values.source", pills: { trm: "info", manual: "gray" } },
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
  // Inventory and costing (plan 2B Task 10): the maestros, the documentos and Existencias. Enum values read the module's catalogue.
  "inventory.warehouse": {
    shown: ["seq", "code", "name", "address_line", "allow_backorders", "status", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: { code: { display: "mono" }, status: recordStatus, is_active: { ...active, valuesKey: "grid.values.active_feminine" } },
  },
  "inventory.location": {
    shown: ["seq", "warehouse_id", "code", "name", "kind", "status", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: { code: { display: "mono" }, kind: { valuesKey: "inventory.values.location_kind", pills: { storage: "gray", transit: "warn" } }, status: recordStatus, is_active: { ...active, valuesKey: "grid.values.active_feminine" } },
  },
  "inventory.movement": {
    title: "number",
    shown: ["number", "kind", "date", "warehouse_id", "reference", "description", "status", "applied_at"],
    exclude: ["extra", "extra_free", "requires_approval", "posts", "source_id"],
    fields: { number: { display: "mono" }, kind: { valuesKey: "inventory.values.movement_kind", pills: { receipt: "ok", issue: "warn", sale_issue: "warn", sale_return: "info", adjustment: "danger", transfer_out: "gray", transfer_in: "gray" } }, status: documentStatus },
  },
  "inventory.movement_line": {
    title: "line_no",
    // Lots and serials (Task 28.1): the lot's code and the serial number, links to their maestros (rule 21); empty on untracked lines.
    shown: ["line_no", "product_id", "location_id", "lot_id", "serial_id", "qty", "uom", "unit_cost"],
    exclude: ["extra", "extra_free", "source_entity", "source_line_id", "movement_id"],
    fields: { uom: { display: "mono" } },
  },
  "inventory.transfer": {
    title: "number",
    shown: ["number", "date", "from_warehouse_id", "to_warehouse_id", "stage", "reference", "status", "shipped_at", "received_at"],
    exclude: ["extra", "extra_free", "requires_approval", "posts"],
    fields: { number: { display: "mono" }, stage: { valuesKey: "inventory.values.transfer_stage", pills: { requested: "info", in_transit: "warn", received: "ok" } }, status: documentStatus },
  },
  "inventory.transfer_line": {
    title: "line_no",
    // Lots and serials (Task 28.2): the lot or serial the line carries through transit; the record frame drops both when no line is tracked.
    shown: ["line_no", "product_id", "from_location_id", "to_location_id", "lot_id", "serial_id", "qty", "uom"],
    exclude: ["extra", "extra_free", "transfer_id"],
    fields: { uom: { display: "mono" } },
  },
  "inventory.count": {
    title: "number",
    shown: ["number", "date", "warehouse_id", "stage", "description", "adjustment_id", "status", "applied_at"],
    exclude: ["extra", "extra_free", "requires_approval", "posts"],
    fields: { number: { display: "mono" }, stage: { valuesKey: "inventory.values.count_stage", pills: { open: "info", applied: "ok" } }, status: documentStatus },
  },
  "inventory.stock_level": {
    title: "product_id",
    shown: ["product_id", "warehouse_id", "location_id", "lot_id", "serial_id", "on_hand", "updated_at"],
    exclude: ["extra", "extra_free", "created_at"],
    fields: {},
  },
  // Lotes, Seriales and Seguimiento por producto (plan 2B.2 Task 28.1).
  "inventory.lot": {
    title: "code",
    shown: ["seq", "product_id", "code", "expires_on", "produced_on", "lot_status", "note", "status", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: { code: { display: "mono" }, lot_status: { valuesKey: "inventory.values.lot_status", pills: { active: "ok", blocked: "danger" } }, status: recordStatus, is_active: active },
  },
  "inventory.serial": {
    title: "serial_no",
    shown: ["seq", "product_id", "serial_no", "lot_id", "serial_status", "note", "status", "is_active"],
    exclude: ["extra", "extra_free"],
    fields: { serial_no: { display: "mono" }, serial_status: { valuesKey: "inventory.values.serial_status", pills: { available: "ok", issued: "gray", scrapped: "danger" } }, status: recordStatus, is_active: active },
  },
  "inventory.product_tracking": {
    title: "product_id",
    shown: ["product_id", "tracking", "fefo", "expiry_required", "block_expired", "updated_at"],
    exclude: ["extra", "extra_free", "seq", "created_at"],
    fields: { tracking: { valuesKey: "inventory.values.tracking", pills: { none: "gray", lot: "info", serial: "warn" } } },
  },
  "costing.cost_layer": {
    title: "product_id",
    shown: ["product_id", "warehouse_id", "qty", "avg_cost", "value", "method", "last_movement_id", "updated_at"],
    exclude: ["extra", "extra_free", "last_movement_seq", "created_at"],
    fields: { method: { valuesKey: "costing.values.method" }, currency: { display: "mono" } },
  },
  "costing.cost_missing": {
    title: "product_id",
    shown: ["product_id", "warehouse_id", "status", "occurrences", "qty", "first_date", "last_date", "last_movement_id", "resolved_at"],
    exclude: ["extra", "extra_free", "created_at"],
    fields: { status: { valuesKey: "costing.values.missing_status", pills: { open: "warn", resolved: "ok" } } },
  },
  "costing.landed_cost": {
    title: "number",
    shown: ["number", "date", "movement_id", "basis", "amount", "offset_role", "party_id", "reference", "status"],
    exclude: ["extra", "extra_free", "requires_approval", "posts", "movement_number"],
    fields: { number: { display: "mono" }, basis: { valuesKey: "costing.values.landed_basis" }, offset_role: { valuesKey: "costing.values.offset_role" }, status: documentStatus },
  },
  // CRM and Ventas (plan 2B Task 14b, prototype 2B): the commercial stage beside the lifecycle status; ids of other modules' records
  // (bodega, owner, cotización of a pedido) stay out of the columns, the record's page names them.
  "crm.lead": {
    title: "name",
    shown: ["seq", "name", "contact_name", "email", "phone", "source", "stage", "status", "is_active"],
    exclude: ["extra", "extra_free", "owner_id", "requires_approval", "posts"],
    fields: {
      source: { valuesKey: "crm.values.lead_source" },
      stage: { valuesKey: "crm.values.lead_stage", pills: { new: "info", contacted: "warn", qualified: "ok", converted: "ok", discarded: "gray" } },
      status: recordStatus,
      is_active: active,
    },
  },
  "crm.pipeline": {
    title: "name",
    shown: ["code", "name", "description", "is_default", "status", "is_active"],
    exclude: ["extra", "extra_free", "requires_approval", "posts"],
    fields: { code: { display: "mono" }, status: recordStatus, is_active: active },
  },
  "crm.stage": {
    title: "line_no",
    shown: ["line_no", "name", "probability", "kind"],
    exclude: ["extra", "extra_free", "pipeline_id"],
    fields: { kind: { valuesKey: "crm.values.stage_kind", pills: { open: "info", won: "ok", lost: "danger" } } },
  },
  "crm.opportunity": {
    title: "number",
    shown: ["number", "title", "party_id", "lead_id", "stage_id", "amount", "probability", "expected_close", "outcome", "status"],
    exclude: ["extra", "extra_free", "owner_id", "order_id", "requires_approval", "posts", "exchange_rate"],
    fields: { number: { display: "mono" }, outcome: { valuesKey: "crm.values.outcome", pills: { open: "info", won: "ok", lost: "danger" } }, status: documentStatus },
  },
  "crm.opportunity_line": {
    title: "line_no",
    shown: ["line_no", "product_id", "description", "qty", "unit_price"],
    exclude: ["extra", "extra_free", "opportunity_id"],
    fields: {},
  },
  "crm.activity": {
    title: "subject",
    shown: ["seq", "kind", "subject", "opportunity_id", "lead_id", "party_id", "due_at", "done_at"],
    exclude: ["extra", "extra_free", "owner_id", "source_entity", "source_id"],
    fields: { kind: { valuesKey: "crm.values.activity_kind" } },
  },
  "crm.quote": {
    title: "number",
    shown: ["number", "party_id", "issue_date", "valid_until", "stage", "total", "status"],
    exclude: ["extra", "extra_free", "owner_id", "requires_approval", "posts", "exchange_rate"],
    fields: { number: { display: "mono" }, stage: { valuesKey: "crm.values.quote_stage", pills: { open: "info", sent: "warn", accepted: "ok", expired: "gray" } }, currency: { display: "mono" }, status: documentStatus },
  },
  "crm.quote_line": {
    title: "line_no",
    shown: ["line_no", "product_id", "description", "qty", "unit_price", "discount_pct", "base", "iva", "total"],
    exclude: ["extra", "extra_free", "quote_id"],
    fields: {},
  },
  "sales.order": {
    title: "number",
    shown: ["number", "party_id", "owner_id", "issue_date", "delivery_date", "stage", "total", "status"],
    exclude: ["extra", "extra_free", "quote_id", "opportunity_id", "warehouse_id", "requires_approval", "posts", "exchange_rate"],
    fields: {
      number: { display: "mono" },
      // The salesperson (Task 39): a column the user filters by name (the grid's table of members).
      owner_id: { table: "members" },
      stage: { valuesKey: "sales.values.order_stage", pills: { open: "info", confirmed: "ok", partially_delivered: "warn", delivered: "ok", cancelled: "gray" } },
      currency: { display: "mono" },
      status: documentStatus,
    },
  },
  "sales.order_line": {
    title: "line_no",
    shown: ["line_no", "product_id", "description", "qty", "unit_price", "discount_pct", "base", "iva", "total"],
    exclude: ["extra", "extra_free", "order_id", "quote_line_id"],
    fields: {},
  },
  "sales.delivery": {
    title: "number",
    shown: ["number", "order_id", "party_id", "warehouse_id", "date", "stage", "shipped_at", "status"],
    exclude: ["extra", "extra_free", "cost_center_id", "requires_approval", "posts"],
    fields: {
      number: { display: "mono" },
      order_id: orderUnavailable,
      // The pedido's salesperson (Task 39): named by the members table.
      order_owner_id: { table: "members" },
      stage: { valuesKey: "sales.values.delivery_stage", pills: { open: "info", shipped: "ok" } },
      status: documentStatus,
    },
  },
  "sales.delivery_line": {
    title: "line_no",
    // Lots and serials (Task 28.3): «Lote / Vence / Serie», what inventory issued of each lot and serial (FEFO or the one named); the record
    // frame drops it when no line of the entrega is tracked.
    shown: ["line_no", "product_id", "description", "qty", "invoiced_qty", "lots"],
    // order_line_id: a line of the pedido, possibly another salesperson's (Task 39, final review m1); the entrega's pedido is its header's.
    exclude: ["extra", "extra_free", "delivery_id", "movement_id", "order_line_id"],
    fields: {},
  },
  "sales.return": {
    title: "number",
    shown: ["number", "delivery_id", "party_id", "warehouse_id", "date", "reason", "stage", "received_at", "status"],
    exclude: ["extra", "extra_free", "cost_center_id", "requires_approval", "posts"],
    fields: { number: { display: "mono" }, order_id: orderUnavailable, stage: { valuesKey: "sales.values.return_stage", pills: { open: "info", received: "ok" } }, status: documentStatus },
  },
  "sales.return_line": {
    title: "line_no",
    // Lots and serials (Task 28.3): the lot or the serials the line takes back; the record frame drops them when no line names one.
    shown: ["line_no", "product_id", "description", "qty", "lot_id", "serial_ids"],
    exclude: ["extra", "extra_free", "return_id"],
    fields: {},
  },
  "sales.customer_terms": {
    title: "party_id",
    shown: ["party_id", "price_list_id", "discount_pct", "credit_limit", "notes"],
    exclude: ["extra", "extra_free", "seq"],
    fields: {},
  },
  // Facturación (plan 2B Task 20, prototype 2B «Facturas»: Número · Cliente · Fecha · Total · Estado · DIAN). The Estado is the invoice's
  // stage (Borrador, Emitida, Pagada, Anulada): an annulled invoice keeps its posted status (its note posted the reversal), so the grid and
  // its filters read the stage; the lifecycle status stays in the column chooser.
  "invoicing.invoice": {
    title: "number",
    // Prototype 2B «Facturas»: ID · Número · Cliente · Fecha · Total · Estado · DIAN (Vence kept after the date: what is owed when).
    shown: ["seq", "number", "party_id", "issue_date", "due_date", "total", "stage", "dian_status"],
    exclude: ["extra", "extra_free", "resolution", "requires_approval", "posts", "cost_center_id", "annulment_note_id"],
    fields: { number: { display: "mono" }, cufe: { display: "mono" }, currency: { display: "mono" }, stage: invoiceStage, dian_status: dianStatus, origin: { valuesKey: "invoicing.values.origin" }, payment_form: { valuesKey: "invoicing.values.payment_form" }, status: documentStatus },
  },
  // Pagos (plan 2B Task 24b, prototype 2B «Recibos de caja»: ID · Número · Cliente · Fecha · Total · Estado).
  "payments.method": {
    shown: ["seq", "code", "name", "kind", "means_code", "status", "is_active"],
    exclude: ["extra", "extra_free", "requires_approval"],
    fields: { code: { display: "mono" }, means_code: { display: "mono" }, kind: { valuesKey: "payments.values.method_kind" }, status: recordStatus, is_active: active },
  },
  "payments.cash_box": {
    shown: ["seq", "code", "name", "description", "status", "is_active"],
    exclude: ["extra", "extra_free", "requires_approval"],
    fields: { code: { display: "mono" }, status: recordStatus, is_active: { ...active, valuesKey: "grid.values.active_feminine" } },
  },
  "payments.receipt": {
    title: "number",
    shown: ["seq", "number", "party_id", "date", "amount", "status"],
    exclude: ["extra", "extra_free", "requires_approval", "posts", "exchange_rate"],
    fields: { number: { display: "mono" }, reference: { display: "mono" }, method_code: { display: "mono" }, currency: { display: "mono" }, status: documentStatus },
  },
  "payments.receipt_allocation": {
    title: "line_no",
    shown: ["line_no", "invoice_number", "amount", "withholding_total", "cash_amount"],
    exclude: ["extra", "extra_free", "receipt_id", "invoice_id", "withholdings"],
    fields: { invoice_number: { display: "mono" } },
  },
  "invoicing.invoice_line": {
    title: "line_no",
    shown: ["line_no", "product_id", "description", "qty", "unit_price", "discount_pct", "base", "iva_rate", "iva", "inc", "total"],
    exclude: ["extra", "extra_free", "invoice_id", "order_line_id", "delivery_line_id", "category_id", "order_id", "delivery_id"],
    fields: {},
  },
  "invoicing.invoice_tax": {
    title: "code",
    shown: ["family", "code", "rate", "base", "amount", "ledger_code"],
    exclude: ["extra", "extra_free", "invoice_id"],
    fields: { code: { display: "mono" }, ledger_code: { display: "mono" } },
  },
  "invoicing.note": {
    title: "number",
    shown: ["seq", "number", "kind", "invoice_id", "party_id", "issue_date", "reason", "total", "stage", "dian_status", "annulment"],
    exclude: ["extra", "extra_free", "resolution", "requires_approval", "posts", "cost_center_id"],
    fields: {
      number: { display: "mono" },
      cude: { display: "mono" },
      kind: { valuesKey: "invoicing.values.note_kind", pills: { credit: "info", debit: "warn" } },
      stage: { valuesKey: "invoicing.values.note_stage", pills: { draft: "gray", issued: "ok" } },
      dian_status: dianStatus,
      annulment: { valuesKey: "invoicing.values.annulment", pills: { true: "danger", false: "gray" } },
      status: documentStatus,
    },
  },
  "invoicing.note_line": {
    title: "line_no",
    shown: ["line_no", "product_id", "description", "qty", "unit_price", "base", "iva_rate", "iva", "inc", "total"],
    exclude: ["extra", "extra_free", "note_id", "invoice_line_id", "category_id"],
    fields: {},
  },
  "invoicing.note_tax": {
    title: "code",
    shown: ["family", "code", "rate", "base", "amount", "ledger_code"],
    exclude: ["extra", "extra_free", "note_id"],
    fields: { code: { display: "mono" }, ledger_code: { display: "mono" } },
  },
  // Por facturar (Task 20 fix round 1): the pedido, the entrega, the customer, the product and the quantities; the ids only link.
  "invoicing.pending_line": {
    title: "order_number",
    shown: ["order_number", "delivery_number", "delivery_date", "party_id", "product_id", "delivered_qty", "invoiced_qty", "pending_qty"],
    exclude: ["order_id", "delivery_id"],
    fields: { order_number: { display: "mono" }, delivery_number: { display: "mono" } },
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
