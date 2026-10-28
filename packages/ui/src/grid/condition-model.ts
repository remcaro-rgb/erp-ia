import { NO_VALUE_OPS, OPERATORS } from "@erp/kernel/query";
import { parseMoney } from "../money/format";
import { conditionReady } from "./grid-model";
import type { Condition, FilterOp, GridColumn } from "./types";

// The advanced filter's draft (prototype `ADV[ns].draft`): what the person is typing, before it becomes conditions.
// Values stay as typed (text) and are converted per type when sent, so a half-typed amount never breaks the row.

export interface DraftCondition {
  field: string;
  op: FilterOp;
  /** Text as typed, or the chosen values of `in`. */
  value: string | string[];
  value2: string;
  join: "and" | "or";
}

/** A new condition on the first field the caller may filter by, with its type's first rule (prototype `advDraftAdd`). */
export function newDraft(fields: readonly GridColumn[], join: "and" | "or" = "and"): DraftCondition {
  const field = fields.find((f) => f.mode === "visible" && f.filterable) ?? fields[0];
  return { field: field?.field ?? "", op: field ? OPERATORS[field.kind][0]! : "eq", value: "", value2: "", join };
}

/** Changing the field resets the rule to its type's first and clears the values (prototype `advDraftSet`). */
export function withField(draft: DraftCondition, field: GridColumn): DraftCondition {
  return { ...draft, field: field.field, op: OPERATORS[field.kind][0]!, value: "", value2: "" };
}

export function withOp(draft: DraftCondition, op: FilterOp): DraftCondition {
  const value = op === "in" ? (Array.isArray(draft.value) ? draft.value : draft.value ? [draft.value] : []) : Array.isArray(draft.value) ? (draft.value[0] ?? "") : draft.value;
  return { ...draft, op, value, value2: op === "between" ? draft.value2 : "" };
}

const typed = (field: GridColumn | undefined, text: string): unknown => {
  if (!field) return text;
  if (field.kind === "number") return parseMoney(text) ?? undefined;
  if (field.type === "boolean") return text === "" ? undefined : text === "true";
  return text;
};

/** The draft as conditions to send (typed values), without the incomplete ones. */
export function draftConditions(draft: readonly DraftCondition[], fields: readonly GridColumn[]): Condition[] {
  const byField = new Map(fields.map((f) => [f.field, f]));
  return draft
    .map((d, i): Condition => {
      const field = byField.get(d.field);
      const value = NO_VALUE_OPS.has(d.op) ? undefined : Array.isArray(d.value) ? d.value.map((v) => typed(field, v)) : typed(field, d.value);
      return { field: d.field, op: d.op, ...(value !== undefined ? { value } : {}), ...(d.op === "between" ? { value2: typed(field, d.value2) } : {}), ...(i > 0 ? { join: d.join } : {}) };
    })
    .filter(conditionReady)
    .map((c, i) => (i === 0 ? { ...c, join: undefined } : c));
}

/** Applied conditions back as a draft (opening the popup again). */
export function draftOf(conditions: readonly Condition[]): DraftCondition[] {
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "boolean" ? String(v) : typeof v === "number" ? String(v).replace(".", ",") : String(v));
  return conditions.map((c) => ({
    field: c.field,
    op: c.op,
    value: Array.isArray(c.value) ? c.value.map(text) : text(c.value),
    value2: text(c.value2),
    join: c.join === "or" ? "or" : "and",
  }));
}
