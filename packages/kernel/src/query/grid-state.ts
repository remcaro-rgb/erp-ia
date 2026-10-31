import { z } from "zod";
import type { CustomFieldType } from "../custom-fields/types";
import type { FieldType } from "../registry/fields";

// What a grid asks the server for (design §9): filters, sort, page and the rest of a view. Dependency-free
// (zod only) so the browser builds the same state and offers the same operators as the server accepts.

export const FILTER_OPS = ["eq", "neq", "contains", "ncontains", "starts", "ends", "gt", "gte", "lt", "lte", "between", "in", "nin", "is_null", "not_null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const GridFilter = z.object({
  /** A registry field, or `extra.<key>` for an admin-defined field (design §5.14). */
  field: z.string().min(1).max(80),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
  /** Upper bound of `between`. */
  value2: z.unknown().optional(),
  /** How this condition joins the previous one; AND binds tighter than OR. Ignored on the first condition. */
  join: z.enum(["and", "or"]).optional(),
});
export type GridFilter = z.infer<typeof GridFilter>;

export const GridSort = z.object({ field: z.string().min(1).max(80), dir: z.enum(["asc", "desc"]) });
export type GridSort = z.infer<typeof GridSort>;

export const AGGREGATE_FNS = ["sum", "avg", "min", "max", "count"] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export const GridState = z.object({
  filters: z.array(GridFilter).max(50),
  sort: z.array(GridSort).max(5),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(500),
  /** Columns to return (always with `id`); every field of the entity when absent. */
  columns: z.array(z.string().min(1).max(80)).max(200).optional(),
  /**
   * Rows come ordered by these fields first so groups are contiguous (up to three levels); a single field may be written
   * as a string. Always an array once parsed.
   */
  groupBy: z
    .union([z.string().min(1).max(80), z.array(z.string().min(1).max(80)).max(3)])
    .transform((value) => (typeof value === "string" ? [value] : value))
    .optional(),
  aggregates: z.array(z.object({ field: z.string().min(1).max(80), fn: z.enum(AGGREGATE_FNS) })).max(20).optional(),
  /** Free text matched against the entity's searchable fields (the lookup's autocomplete). */
  search: z.string().max(200).optional(),
  /** Values of the parameters the entity declares (`EntityDef.gridParams`), at most five; the query sets them as `erp.param.<name>`. */
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/).max(40), z.string().max(200)).refine((p) => Object.keys(p).length <= 5, "at most 5 params").optional(),
});
export type GridState = z.infer<typeof GridState>;
/** What callers write: optional parts may be left out. */
export type GridStateInput = z.input<typeof GridState>;

/** The family of operators a field takes; registry and custom-field types both map onto one. */
export type FilterKind = "text" | "number" | "enum" | "date" | "uuid" | "json";

/** Operators by family, in the order the filter builder offers them (design §9). */
export const OPERATORS: Readonly<Record<FilterKind, readonly FilterOp[]>> = {
  text: ["contains", "ncontains", "starts", "ends", "eq", "neq", "is_null", "not_null"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
  enum: ["eq", "neq", "in"],
  date: ["eq", "gt", "lt", "between"],
  uuid: ["eq", "neq", "in", "is_null", "not_null"],
  json: ["contains", "ncontains", "is_null", "not_null"],
};

const KIND_OF_TYPE: Record<FieldType, FilterKind> = {
  text: "text",
  number: "number",
  money: "number",
  date: "date",
  datetime: "date",
  boolean: "enum",
  enum: "enum",
  uuid: "uuid",
  ref: "uuid",
  json: "json",
};

const KIND_OF_CUSTOM: Record<CustomFieldType, FilterKind> = {
  text: "text",
  url: "text",
  email: "text",
  number: "number",
  date: "date",
  bool: "enum",
  list: "enum",
};

export const filterKind = (type: FieldType): FilterKind => KIND_OF_TYPE[type];
export const customFilterKind = (type: CustomFieldType): FilterKind => KIND_OF_CUSTOM[type];

/** The operators a registry field type takes. */
export const operatorsFor = (type: FieldType): readonly FilterOp[] => OPERATORS[filterKind(type)];

/**
 * Code sets on a text field: `in` / `nin` over a list of stored codes. The filter builder never offers them; the grid
 * sends them when the user filters a coded column (municipality, document type…) by the label it shows (rule 20).
 */
export const CODE_SET_OPS: ReadonlySet<FilterOp> = new Set(["in", "nin"]);

/** Operators that take no value. */
export const NO_VALUE_OPS: ReadonlySet<FilterOp> = new Set(["is_null", "not_null"]);

/** Prefix of an admin-defined field in a filter or sort: `extra.<key>`. */
export const EXTRA_PREFIX = "extra.";
/** Key of an admin-defined field (the same rule as `kernel.custom_fields.key`). */
export const EXTRA_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Splits conditions into OR-groups of AND-runs (AND binds tighter than OR): `A y B o C` is `(A y B) o C`.
 * The first condition's join is ignored. The prototype's `condsMatch` does the same in the browser.
 */
export function orGroups<T extends { join?: "and" | "or" }>(conditions: readonly T[]): T[][] {
  const groups: T[][] = [];
  conditions.forEach((condition, index) => {
    if (index === 0 || condition.join === "or") groups.push([]);
    groups[groups.length - 1]!.push(condition);
  });
  return groups;
}
