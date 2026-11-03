import type { EntityDef, EntityType, FieldDef, FieldType } from "@erp/kernel";

// Entities of the accounting module (accounting design §4). Labels are i18n keys (`entity.<id>`, `field.<id>.<column>`),
// filled by the catalogues of Task 30. Field names are the column names; the masked views `accounting.v_<table>` in
// migrations 0031 and 0032 are generated from these definitions (views.test.ts fails when they drift). The journal
// master is called Fuente in every UI; the identifiers stay `journal` (design §10b.18).

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}
type F = ReturnType<typeof fieldsOf>;

function entity(id: string, entityType: EntityType | null, table: string, displayField: string, fields: (f: F) => FieldDef[], extra: Partial<EntityDef> = {}): EntityDef {
  return {
    id,
    module: "accounting",
    schema: "accounting",
    table,
    label: `entity.${id}`,
    ...(entityType ? { entityType } : {}),
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

/**
 * The lifecycle columns a maestro publishes (Phase 2A.5 Task 8b, migration 0043), after every other column: `create or replace view`
 * only appends. Activo is the entity's own `is_active`; `deleted_at` and `void_reason` are not fields (the views drop deleted rows).
 */
const maestroLifecycle = (f: F): FieldDef[] => [
  f("status", "enum", { enumValues: MAESTRO_STATES, valuesKey: "grid.values.record_status" }),
  f("requires_approval", "boolean"),
];

/** The figure the masters' Tabla shows for the period its grid param `period_id` names (gaps plan Task 7, migration 0036). */
const periodFigure = (f: F, kind: string): FieldDef =>
  ({ ...f("period_figure", "money", { exportable: true }), rollup: true, viewExpr: `accounting.period_figure('${kind}', "id", nullif(current_setting('erp.param.period_id', true), '')::uuid)` });
const PERIOD_PARAM: Pick<EntityDef, "gridParams"> = { gridParams: [{ name: "period_id", type: "uuid" }] };

const ref = (entityId: string, display: string): Pick<FieldDef, "ref"> => ({ ref: { entity: entityId, display } });
const account = ref("accounting.account", "code");
const party = ref("core.party", "legal_name");

export const ACCOUNT_LEVELS = ["class", "group", "account", "subaccount", "auxiliary"];
/** A comprobante's state: the documento lifecycle (entity types spec §5.1, D2). `reversed` is a mark on a posted entry, not a state. */
export const ENTRY_STATUSES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
/** A maestro's lifecycle state (spec §5.1): Borrador, Grabado, Pendiente de Aprobación, No Aprobado, Aprobado. */
export const MAESTRO_STATES = ["draft", "saved", "pending", "rejected", "approved"];
export const ENTRY_ORIGINS = ["manual", "auto", "import", "template"];
export const JOURNAL_KINDS = ["general", "sales", "purchases", "receipts", "payments", "opening", "closing"];
export const FAILURE_CODES = [
  "unbalanced", "missing_account_mapping", "closed_period", "inactive_account", "missing_party", "missing_cost_center",
  "missing_open_auxiliary", "missing_item", "missing_business_unit", "inactive_dimension", "invalid_template", "no_journal",
];
export const CLOSE_CHECKS = [
  "drafts", "pending_failures", "pending_approvals", "undispatched_events", "control_receivable", "control_payable",
  "control_inventory", "suspense_zero", "rounding_within_tolerance", "contra_nature_balances",
];

// §4.1 Cuenta. `access` is open or restricted (§4.15); the code is digits only and unique per company.
export const accountEntity: EntityDef = entity(
  "accounting.account", "maestro",
  "accounts",
  "code",
  (f) => [
    f("seq", "number", { required: true }),
    f("code", "text", { required: true, searchable: true }),
    f("name", "text", { required: true, searchable: true }),
    f("parent_id", "ref", account),
    f("level", "enum", { required: true, enumValues: ACCOUNT_LEVELS, valuesKey: "accounting.values.account_level" }),
    f("nature", "enum", { required: true, enumValues: ["debit", "credit"], valuesKey: "accounting.values.nature" }),
    f("allows_movement", "boolean"),
    f("requires_party", "boolean"),
    f("requires_invoice_ready", "boolean"),
    f("requires_cost_center", "boolean"),
    f("requires_open_auxiliary", "boolean"),
    f("requires_item", "boolean"),
    f("requires_business_unit", "boolean"),
    f("statement_section", "text"),
    f("is_opening_result", "boolean"),
    f("is_active", "boolean"),
    f("access", "enum", { required: true, enumValues: ["open", "restricted"], valuesKey: "accounting.values.account_access" }),
    ...trailer(f),
    periodFigure(f, "account"),
    ...maestroLifecycle(f),
  ],
  { importKey: ["code"], recordPage: true, cloneReset: ["code", "seq", "period_figure"], ...PERIOD_PARAM },
);

// §4.2 Mapeo de cuentas: one row per (role, dimension).
export const accountRoleMappingEntity: EntityDef = entity("accounting.account_role_mapping", "parametro", "account_role_mappings", "role", (f) => [
  f("seq", "number", { required: true }),
  f("role", "text", { required: true, searchable: true, valuesKey: "grid.values.account_role" }),
  f("dimension", "text", { searchable: true }),
  f("account_id", "ref", { required: true, ...account }),
  ...trailer(f),
]);

// §4.15 Seguridad por cuenta.
export const accountPermissionEntity: EntityDef = entity("accounting.account_permission", "parametro", "account_permissions", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("account_id", "ref", { required: true, ...account }),
  f("subject_kind", "enum", { required: true, enumValues: ["role", "user"], valuesKey: "accounting.values.subject_kind" }),
  f("subject_id", "uuid", { required: true }),
  f("can_view", "boolean"),
  f("can_post", "boolean"),
  f("is_active", "boolean"),
  ...trailer(f),
]);

// §4.3 Fuente.
export const journalEntity: EntityDef = entity(
  "accounting.journal", "maestro",
  "journals",
  "code",
  (f) => [
    f("seq", "number", { required: true }),
    f("code", "text", { required: true, searchable: true }),
    f("name", "text", { required: true, searchable: true }),
    f("kind", "enum", { required: true, enumValues: JOURNAL_KINDS, valuesKey: "accounting.values.journal_kind" }),
    f("next_number", "number"),
    f("manual_entries", "boolean"),
    f("is_active", "boolean"),
    ...trailer(f),
    ...maestroLifecycle(f),
  ],
  { importKey: ["code"], recordPage: true, cloneReset: ["code", "seq", "next_number"] },
);

// §4.4 Año fiscal, Período. Parámetros (D13, D14 "unless the entity is better classed parametro"; Task 8b): the calendar of the
// ledger, opened and closed by its own processes (year.open, period.close / reopen, year.close); their `status` is open / closed,
// not a lifecycle state, and no comprobante waits for their approval.
export const fiscalYearEntity: EntityDef = entity("accounting.fiscal_year", "parametro", "fiscal_years", "year", (f) => [
  f("seq", "number", { required: true }),
  f("year", "number", { required: true }),
  f("starts_on", "date", { required: true }),
  f("ends_on", "date", { required: true }),
  f("status", "enum", { required: true, enumValues: ["open", "closed"], valuesKey: "accounting.values.period_status" }),
  ...trailer(f),
], { importKey: ["year"] });

export const periodEntity: EntityDef = entity(
  "accounting.period", "parametro",
  "periods",
  "starts_on",
  (f) => [
    f("seq", "number", { required: true }),
    f("fiscal_year_id", "ref", { required: true, ...ref("accounting.fiscal_year", "year") }),
    f("number", "number", { required: true }),
    f("starts_on", "date", { required: true, displayFormat: "month" }),
    f("ends_on", "date", { required: true }),
    f("status", "enum", { required: true, enumValues: ["open", "closed"], valuesKey: "accounting.values.period_status" }),
    f("closed_at", "datetime"),
    f("closed_by", "ref", ref("kernel.user", "full_name")),
    f("reopened_count", "number"),
    f("reopened_for", "date"),
    ...trailer(f),
  ],
  { importKey: ["fiscal_year_id", "number"], recordPage: true },
);

// §4.5 Four analytic dimensions with one shape.
function dimension(id: string, table: string): EntityDef {
  return entity(
    id,
    "maestro",
    table,
    "code",
    (f) => [
      f("seq", "number", { required: true }),
      f("code", "text", { required: true, searchable: true }),
      f("name", "text", { required: true, searchable: true }),
      f("parent_id", "ref", ref(id, "name")),
      f("kind", "enum", { required: true, enumValues: ["group", "leaf"], valuesKey: "accounting.values.dimension_kind" }),
      f("is_active", "boolean"),
      ...trailer(f),
      periodFigure(f, id.slice("accounting.".length)),
      ...maestroLifecycle(f),
    ],
    { importKey: ["code"], recordPage: true, cloneReset: ["code", "seq", "period_figure"], ...PERIOD_PARAM },
  );
}
export const costCenterEntity = dimension("accounting.cost_center", "cost_centers");
export const openAuxiliaryEntity = dimension("accounting.open_auxiliary", "open_auxiliaries");
export const itemEntity = dimension("accounting.item", "items");
export const businessUnitEntity = dimension("accounting.business_unit", "business_units");

// §4.11 Configuración contable (one row per company).
export const settingsEntity: EntityDef = entity("accounting.settings", "parametro", "settings", "seq", (f) => [
  f("seq", "number", { required: true }),
  f("ledger_starts_on", "date"),
  f("rounding_tolerance", "money"),
  f("manual_journal_id", "ref", ref("accounting.journal", "code")),
  f("require_attachment_on_manual", "boolean"),
  f("niif_group", "enum", { enumValues: ["1", "2", "3"], valuesKey: "accounting.values.niif_group" }),
  f("require_approval_on_manual", "boolean"),
  f("use_open_auxiliaries", "boolean"),
  f("use_items", "boolean"),
  f("use_business_units", "boolean"),
  ...trailer(f),
]);

// §4.13 Conceptos de exógena.
export const fiscalConceptMappingEntity: EntityDef = entity("accounting.fiscal_concept_mapping", "parametro", "fiscal_concept_mappings", "concept", (f) => [
  f("seq", "number", { required: true }),
  f("format", "text", { required: true, searchable: true }),
  f("concept", "text", { required: true, searchable: true }),
  f("account_id", "ref", { required: true, ...account }),
  f("is_active", "boolean"),
  ...trailer(f),
]);

// §4.6 Comprobante.
export const entryEntity: EntityDef = entity(
  "accounting.entry", "documento",
  "entries",
  "number",
  (f) => [
    f("seq", "number", { required: true }),
    f("journal_id", "ref", { required: true, ...ref("accounting.journal", "code") }),
    f("number", "text", { searchable: true }),
    f("date", "date", { required: true }),
    f("period_id", "ref", ref("accounting.period", "starts_on")),
    f("status", "enum", { required: true, enumValues: ENTRY_STATUSES, valuesKey: "accounting.values.entry_status" }),
    f("origin", "enum", { required: true, enumValues: ENTRY_ORIGINS, valuesKey: "accounting.values.entry_origin" }),
    f("reverse_on", "date"),
    f("submitted_by", "ref", ref("kernel.user", "full_name")),
    f("submitted_at", "datetime"),
    f("description", "text", { searchable: true }),
    f("currency", "text"),
    f("exchange_rate", "number"),
    f("total_debit", "money"),
    f("total_credit", "money"),
    f("source_event_id", "uuid"),
    f("posting_rule_id", "ref", ref("accounting.posting_rule", "name")),
    f("source_entity", "text"),
    f("source_record_id", "uuid"),
    f("chain_id", "uuid"),
    f("business_unit_id", "ref", ref("accounting.business_unit", "name")),
    f("reversal_of_id", "ref", ref("accounting.entry", "number")),
    f("reversed_by_id", "ref", ref("accounting.entry", "number")),
    f("is_opening", "boolean"),
    f("is_closing", "boolean"),
    f("is_auto_reversal", "boolean"),
    f("posted_at", "datetime"),
    f("posted_by", "ref", ref("kernel.user", "full_name")),
    ...trailer(f),
    f("requires_approval", "boolean"),
    f("posts", "boolean"),
    f("void_reason", "text"),
  ],
  {
    typed: {
      numbering: "on_post",
      lines: { entity: "accounting.entry_line", parentField: "entry_id" },
      // Spec §10.2: approval by journal kind (require_approval_on_manual); a comprobante is its own posting.
      ownFlags: { requiresApproval: "accounting.entry.own_flags.requires_approval", posts: "accounting.entry.own_flags.posts" },
    },
    defaultSort: { field: "date", dir: "desc" }, recordPage: true },
);

// §4.7 Movimiento (a comprobante's line).
export const entryLineEntity: EntityDef = entity("accounting.entry_line", "lines", "entry_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("entry_id", "ref", { required: true, ...ref("accounting.entry", "number") }),
  f("line_no", "number", { required: true }),
  f("account_id", "ref", { required: true, ...account }),
  f("party_id", "ref", party),
  f("cost_center_id", "ref", ref("accounting.cost_center", "name")),
  f("open_auxiliary_id", "ref", ref("accounting.open_auxiliary", "name")),
  f("item_id", "ref", ref("accounting.item", "name")),
  f("business_unit_id", "ref", ref("accounting.business_unit", "name")),
  f("description", "text", { searchable: true }),
  f("debit", "money"),
  f("credit", "money"),
  f("debit_doc", "money"),
  f("credit_doc", "money"),
  f("tax_code", "text"),
  f("tax_rate", "number"),
  f("tax_base", "money"),
  f("reference", "text"),
  f("due_date", "date"),
  ...trailer(f),
], {
  // D20 (entity types spec §10, owner 2026-11-03): a line of an account the caller may not view stays in v_entry_lines (0033) with
  // is_restricted true and these values null; the grid shows it as a «••••» row and the comprobante's lines total its true totals.
  rowMask: {
    flag: "is_restricted",
    fields: ["account_id", "party_id", "cost_center_id", "open_auxiliary_id", "item_id", "business_unit_id", "description", "debit", "credit", "debit_doc", "credit_doc", "tax_code", "tax_rate", "tax_base", "reference", "due_date"],
    totals: { parentField: "entry_id", view: "accounting.v_entries", columns: { debit: "total_debit", credit: "total_credit" } },
  },
});

// §4.8 Regla contable.
export const postingRuleEntity: EntityDef = entity("accounting.posting_rule", "parametro", "posting_rules", "name", (f) => [
  f("seq", "number", { required: true }),
  f("event", "text", { required: true, searchable: true }),
  f("name", "text", { required: true, searchable: true }),
  f("description", "text"),
  f("module", "text"),
  f("journal_id", "ref", { required: true, ...ref("accounting.journal", "code") }),
  f("template", "json", { sortable: false }),
  f("priority", "number"),
  f("is_default", "boolean"),
  f("is_modified", "boolean"),
  f("is_active", "boolean"),
  ...trailer(f),
], { recordPage: true });

// §4.9 Pendiente de contabilizar.
export const postingFailureEntity: EntityDef = entity("accounting.posting_failure", "sistema", "posting_failures", "event", (f) => [
  f("seq", "number", { required: true }),
  f("event_id", "uuid", { required: true }),
  f("event", "text", { required: true, searchable: true }),
  f("event_date", "date"),
  f("posting_rule_id", "ref", ref("accounting.posting_rule", "name")),
  f("payload", "json", { sortable: false }),
  f("error_code", "enum", { required: true, enumValues: FAILURE_CODES, valuesKey: "accounting.values.failure_code" }),
  f("error_detail", "text"),
  f("status", "enum", { required: true, enumValues: ["pending", "resolved", "dismissed"], valuesKey: "accounting.values.failure_status" }),
  f("resolved_entry_id", "ref", ref("accounting.entry", "number")),
  f("attempts", "number"),
  f("last_attempt_at", "datetime"),
  ...trailer(f),
]);

// §4.10 Plantilla de comprobante.
export const entryTemplateEntity: EntityDef = entity("accounting.entry_template", "maestro", "entry_templates", "name", (f) => [
  f("seq", "number", { required: true }),
  f("name", "text", { required: true, searchable: true }),
  f("journal_id", "ref", { required: true, ...ref("accounting.journal", "code") }),
  f("description", "text"),
  f("business_unit_id", "ref", ref("accounting.business_unit", "name")),
  ...trailer(f),
  f("is_active", "boolean"),
  ...maestroLifecycle(f),
], { importKey: ["name"], typed: { lines: { entity: "accounting.entry_template_line", parentField: "template_id" } }, recordPage: true });

export const entryTemplateLineEntity: EntityDef = entity("accounting.entry_template_line", "lines", "entry_template_lines", "line_no", (f) => [
  f("seq", "number", { required: true }),
  f("template_id", "ref", { required: true, ...ref("accounting.entry_template", "name") }),
  f("line_no", "number", { required: true }),
  f("account_id", "ref", { required: true, ...account }),
  f("party_id", "ref", party),
  f("cost_center_id", "ref", ref("accounting.cost_center", "name")),
  f("open_auxiliary_id", "ref", ref("accounting.open_auxiliary", "name")),
  f("item_id", "ref", ref("accounting.item", "name")),
  f("business_unit_id", "ref", ref("accounting.business_unit", "name")),
  f("side", "enum", { required: true, enumValues: ["debit", "credit"], valuesKey: "accounting.values.nature" }),
  f("amount", "money"),
  f("description", "text"),
  ...trailer(f),
]);

// §4.14 Verificación de cierre. The column is named `check` as the design says: a reserved word, quoted wherever SQL names it.
export const periodCloseCheckEntity: EntityDef = entity("accounting.period_close_check", "parametro", "period_close_checks", "check", (f) => [
  f("seq", "number", { required: true }),
  f("period_id", "ref", { required: true, ...ref("accounting.period", "starts_on") }),
  f("check", "enum", { required: true, enumValues: CLOSE_CHECKS, valuesKey: "accounting.values.close_check" }),
  f("value", "json", { sortable: false }),
  f("passed", "boolean"),
  f("note", "text"),
  ...trailer(f),
]);

// §4.16 Movimiento (consulta): a read-only entity over the view v_ledger_lines (created by Task 17), no table of its own.
export const ledgerLineEntity: EntityDef = entity(
  "accounting.ledger_line", null,
  "ledger_lines",
  "number",
  (f) => {
    const dims = (name: string, target: string) => [
      f(`${name}_id`, "ref", ref(target, "name")),
      f(`${name}_code`, "text"),
      f(`${name}_name`, "text"),
    ];
    return [
      f("entry_id", "ref", ref("accounting.entry", "number")),
      f("number", "text", { searchable: true }),
      f("date", "date"),
      f("period_id", "ref", ref("accounting.period", "starts_on")),
      f("fiscal_year", "number"),
      f("journal_id", "ref", ref("accounting.journal", "code")),
      f("journal_code", "text"),
      f("status", "enum", { enumValues: ENTRY_STATUSES, valuesKey: "accounting.values.entry_status" }),
      f("origin", "enum", { enumValues: ENTRY_ORIGINS, valuesKey: "accounting.values.entry_origin" }),
      f("created_by", "uuid"),
      f("posted_by", "ref", ref("kernel.user", "full_name")),
      f("posted_at", "datetime"),
      f("source_entity", "text"),
      f("source_record_id", "uuid"),
      f("source_ref", "text"),
      f("posting_rule_id", "ref", ref("accounting.posting_rule", "name")),
      f("entry_description", "text", { searchable: true }),
      f("line_no", "number"),
      f("description", "text", { searchable: true }),
      f("reference", "text"),
      f("account_id", "ref", account),
      f("account_code", "text", { searchable: true }),
      f("account_name", "text", { searchable: true }),
      f("account_class", "text"),
      f("account_group", "text"),
      f("account_level", "enum", { enumValues: ACCOUNT_LEVELS, valuesKey: "accounting.values.account_level" }),
      f("party_id", "ref", party),
      f("party_document", "text", { searchable: true }),
      f("party_name", "text", { searchable: true }),
      ...dims("cost_center", "accounting.cost_center"),
      ...dims("open_auxiliary", "accounting.open_auxiliary"),
      ...dims("item", "accounting.item"),
      ...dims("business_unit", "accounting.business_unit"),
      f("debit", "money"),
      f("credit", "money"),
      f("net", "money"),
      f("signed_net", "money"),
      f("tax_code", "text"),
      f("tax_base", "money"),
      f("due_date", "date"),
      f("reversal_of_id", "ref", ref("accounting.entry", "number")),
      f("reversed_by_id", "ref", ref("accounting.entry", "number")),
      f("is_opening", "boolean"),
      f("is_closing", "boolean"),
      f("reverse_on", "date"),
    ];
  },
  { kind: "query", defaultSort: { field: "date", dir: "asc" } },
);

/** The entities whose tables and masked views migration 0031 creates (masters, security, periods, settings). */
export const MASTER_ENTITIES: EntityDef[] = [
  accountEntity, accountRoleMappingEntity, accountPermissionEntity, journalEntity, fiscalYearEntity, periodEntity,
  costCenterEntity, openAuxiliaryEntity, itemEntity, businessUnitEntity, settingsEntity, fiscalConceptMappingEntity,
];

/** The entities of migration 0032 (the ledger: comprobantes, lines, rules, failures, templates, close checks). */
export const LEDGER_ENTITIES: EntityDef[] = [
  entryEntity, entryLineEntity, postingRuleEntity, postingFailureEntity, entryTemplateEntity, entryTemplateLineEntity, periodCloseCheckEntity,
];

/** The 20 entities of design §4; `ledger_line` is a query entity over `v_ledger_lines` (Task 17). */
export const ACCOUNTING_ENTITIES: EntityDef[] = [...MASTER_ENTITIES, ...LEDGER_ENTITIES, ledgerLineEntity];

/** The accounting entity `id` (throws for an unknown one): what the lifecycle processes are generated from. */
export function entityDef(id: string): EntityDef {
  const found = ACCOUNTING_ENTITIES.find((e) => e.id === id);
  if (!found) throw new Error(`unknown accounting entity ${id}`);
  return found;
}
