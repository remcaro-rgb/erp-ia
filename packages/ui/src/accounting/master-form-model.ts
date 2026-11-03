// The Datos tab of the masters (accounting design §8): Cuenta, the four analytic dimensions, Fuente, Plantilla de comprobante and Período.
// One form drives them all from a list of field specs, so each master states only its fields. Pure, so the rules are unit-tested.

export type MasterKind = "account" | "dimension" | "journal" | "template" | "period" | "rule";

export type Control = "text" | "select" | "check" | "fixed";

export interface FieldSpec {
  /** The process input's name (and the draft's). */
  key: string;
  /** The consult row's column. */
  column: string;
  control: Control;
  required?: boolean;
  mono?: boolean;
  numeric?: boolean;
  /** Only the create form takes it (the code does not change). */
  createOnly?: boolean;
  /** Only a stored record has it. */
  updateOnly?: boolean;
  /** Fixed codes of a select, named by `grid.values.<valuesKey>.<code>`. */
  codes?: readonly string[];
  valuesKey?: string;
  /** The select's codes are named by `report.statement.<code>` (the financial statements' sections). */
  statement?: boolean;
  /** A fixed field that is a yes/no fact: shown as an on/off chip. */
  boolean?: boolean;
  /** A select whose options the server supplies. */
  optionsFrom?: "parents" | "journals";
  /** What a new record starts with. */
  initial?: string | boolean;
  /** i18n key (under `accounting.record.form`) of the hint under the field. */
  hint?: string;
}

/** The sections of the balance sheet and of the income statement a Cuenta may belong to (the country packs' statement layouts). */
export const STATEMENT_SECTIONS = ["assets_current", "assets_noncurrent", "liabilities_current", "liabilities_noncurrent", "equity", "revenue", "cost_of_sales", "operating_expenses", "other_income", "other_expenses", "income_tax"] as const;

const flag = (key: string, column: string): FieldSpec => ({ key, column, control: "check", initial: false });

export const MASTER_SPECS: Record<MasterKind, readonly FieldSpec[]> = {
  account: [
    { key: "code", column: "code", control: "text", required: true, mono: true, numeric: true, createOnly: true },
    { key: "name", column: "name", control: "text", required: true },
    { key: "nature", column: "nature", control: "select", codes: ["debit", "credit"], valuesKey: "nature", initial: "debit" },
    { key: "statementSection", column: "statement_section", control: "select", codes: STATEMENT_SECTIONS, statement: true, initial: "" },
    flag("requiresParty", "requires_party"),
    { key: "requiresInvoiceReady", column: "requires_invoice_ready", control: "check", initial: false, hint: "requires_invoice_ready_hint" },
    flag("requiresCostCenter", "requires_cost_center"),
    flag("requiresOpenAuxiliary", "requires_open_auxiliary"),
    flag("requiresItem", "requires_item"),
    flag("requiresBusinessUnit", "requires_business_unit"),
    { key: "isActive", column: "is_active", control: "check", initial: true, updateOnly: true },
    { key: "level", column: "level", control: "fixed", valuesKey: "account_level", updateOnly: true },
    { key: "allowsMovement", column: "allows_movement", control: "fixed", boolean: true, updateOnly: true },
  ],
  dimension: [
    { key: "code", column: "code", control: "text", required: true, mono: true, createOnly: true },
    { key: "name", column: "name", control: "text", required: true },
    { key: "parentId", column: "parent_id", control: "select", optionsFrom: "parents", initial: "" },
    { key: "kind", column: "kind", control: "select", codes: ["group", "leaf"], valuesKey: "dimension_kind", initial: "leaf" },
    { key: "isActive", column: "is_active", control: "check", initial: true },
  ],
  journal: [
    { key: "code", column: "code", control: "text", required: true, mono: true, createOnly: true },
    { key: "name", column: "name", control: "text", required: true },
    { key: "kind", column: "kind", control: "select", codes: ["general", "sales", "purchases", "receipts", "payments", "opening", "closing"], valuesKey: "journal_kind", initial: "general" },
    { key: "manualEntries", column: "manual_entries", control: "check", initial: true },
    { key: "isActive", column: "is_active", control: "check", initial: true },
    { key: "nextNumber", column: "next_number", control: "fixed", mono: true, updateOnly: true },
  ],
  template: [
    { key: "name", column: "name", control: "text", required: true },
    { key: "journalId", column: "journal_id", control: "select", optionsFrom: "journals", required: true, initial: "" },
    { key: "description", column: "description", control: "text", initial: "" },
  ],
  rule: [
    { key: "event", column: "event", control: "text", required: true, mono: true },
    { key: "name", column: "name", control: "text", required: true },
    { key: "journalId", column: "journal_id", control: "select", optionsFrom: "journals", required: true, initial: "" },
    { key: "priority", column: "priority", control: "text", numeric: true, initial: "100" },
    { key: "description", column: "description", control: "text", initial: "" },
    { key: "isActive", column: "is_active", control: "check", initial: true },
    { key: "module", column: "module", control: "fixed", mono: true, updateOnly: true },
  ],
  period: [
    { key: "number", column: "number", control: "fixed", mono: true },
    { key: "startsOn", column: "starts_on", control: "fixed", mono: true },
    { key: "endsOn", column: "ends_on", control: "fixed", mono: true },
    { key: "status", column: "status", control: "fixed", valuesKey: "period_status" },
  ],
};

export type MasterDraft = Record<string, string | boolean>;

/** The specs that apply: the create form has no stored-only fields; a stored record shows the create-only ones (the code) without taking them. */
export function activeSpecs(kind: MasterKind, isNew: boolean): FieldSpec[] {
  return MASTER_SPECS[kind].filter((s) => !(isNew && s.updateOnly));
}

/** The form's starting values: the stored record, a copy of one, or the defaults of a new record. */
export function masterDraft(kind: MasterKind, row: Readonly<Record<string, unknown>> | null): MasterDraft {
  const draft: MasterDraft = {};
  for (const spec of MASTER_SPECS[kind]) {
    const value = row?.[spec.column];
    if (spec.control === "check") draft[spec.key] = typeof value === "boolean" ? value : ((spec.initial as boolean | undefined) ?? false);
    else draft[spec.key] = value === null || value === undefined ? ((spec.initial as string | undefined) ?? "") : String(value);
  }
  return draft;
}

/** Whether a required field is empty. */
export function masterMissing(kind: MasterKind, draft: MasterDraft, isNew: boolean): boolean {
  return activeSpecs(kind, isNew).some((s) => s.required && s.control !== "fixed" && !(s.createOnly && !isNew) && String(draft[s.key] ?? "").trim() === "");
}

/** The input of the entity's create (new) or update process. Fixed fields never go; an empty parent or description clears it. */
export function masterInput(kind: MasterKind, draft: MasterDraft, id: string | null): Record<string, unknown> {
  const input: Record<string, unknown> = id ? { id } : {};
  for (const spec of activeSpecs(kind, id === null)) {
    if (spec.control === "fixed" || (spec.createOnly && id !== null)) continue;
    const value = draft[spec.key];
    if (spec.control === "check") input[spec.key] = value === true;
    else if (spec.key === "parentId") input[spec.key] = value === "" ? null : value;
    else if (spec.key === "priority") input[spec.key] = Number(String(value).trim() || "100");
    else if (spec.key === "description") input[spec.key] = String(value).trim() === "" ? null : String(value).trim();
    else if (spec.key === "statementSection") {
      // The process takes a section or none at all; the empty text is none (it inherits the parent's).
      if (String(value).trim() !== "") input[spec.key] = String(value).trim();
    } else input[spec.key] = typeof value === "string" ? value.trim() : value;
  }
  return input;
}
