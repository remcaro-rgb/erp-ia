import { NO_VALUE_OPS, OPERATORS, orGroups } from "@erp/kernel/query";
import { parseMoney } from "../money/format";
import type { ColumnFilterValue, Condition, FilterOp, GridColumn, GridRow, GridStateInput, GridView, PillTone, SortEntry } from "./types";

// Pure rules of the DataGrid (design §9, prototype `gridHtml` / `setFilter` / `sortBy` / the pager): what the filter
// row sends per column type, how clicks sort, how the state reaches the server, the pager's buttons and the totals.

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;

type Filter = NonNullable<GridStateInput["filters"]>[number];

/** The view a grid starts from: the columns not hidden by default, no filters, the first page. */
export function initialView(columns: readonly GridColumn[], overrides: Partial<GridView> = {}): GridView {
  return {
    columnFilters: {},
    conditions: [],
    sort: [],
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    columns: columns.filter((c) => c.mode !== "hidden" && !c.hiddenByDefault && !c.filterOnly).map((c) => c.field),
    ...overrides,
  };
}

/** The columns shown, in the view's order, without the hidden ones (rule 14). */
export function shownColumns(columns: readonly GridColumn[], view: Pick<GridView, "columns">): GridColumn[] {
  const byField = new Map(columns.map((c) => [c.field, c]));
  return view.columns.map((f) => byField.get(f)).filter((c): c is GridColumn => c !== undefined && c.mode !== "hidden");
}

/**
 * Click on a header (prototype `sortBy`): ascending, then descending, then off. With shift the field is added to
 * (or cycled within) the current multi-sort; without it, it replaces it.
 */
export function toggleSort(sort: readonly SortEntry[], field: string, multi: boolean): SortEntry[] {
  const current = sort.find((s) => s.field === field);
  const next: SortEntry | null = !current ? { field, dir: "asc" } : current.dir === "asc" ? { field, dir: "desc" } : null;
  if (!multi) return next ? [next] : [];
  const others = sort.filter((s) => s.field !== field);
  if (!next) return others;
  return current ? sort.map((s) => (s.field === field ? next : s)) : [...others, next];
}

const NUMBER_TEXT = String.raw`-?[\d.,]+`;
const RANGE = new RegExp(String.raw`^\s*(${NUMBER_TEXT})\s*(?:\.\.|–|\s-\s)\s*(${NUMBER_TEXT})\s*$`);
const COMPARISON = new RegExp(String.raw`^\s*(>=|<=|>|<|=)?\s*(${NUMBER_TEXT})\s*$`);
const OP_OF: Record<string, FilterOp> = { ">=": "gte", "<=": "lte", ">": "gt", "<": "lt", "=": "eq" };

/** A number filter as typed in the filter row: `>= 1000`, `< 5`, `= 3`, `1000..5000` (between); a bare number is `>=`. */
export function parseNumberFilter(text: string): Pick<Filter, "op" | "value" | "value2"> | null {
  const range = RANGE.exec(text);
  if (range) {
    const a = parseMoney(range[1]!);
    const b = parseMoney(range[2]!);
    return a === null || b === null ? null : { op: "between", value: a, value2: b };
  }
  const m = COMPARISON.exec(text);
  if (!m) return null;
  const n = parseMoney(m[2]!);
  return n === null ? null : { op: OP_OF[m[1] ?? ">="]!, value: n };
}

const optionValue = (column: GridColumn, raw: string): unknown => (column.type === "boolean" ? raw === "true" : raw);

/** Up to this many values, a text column with a code table filters with a select (document types, taxes). */
export const SELECT_FILTER_MAX = 60;

/** A text column whose values come from a short code table: the filter row offers them in a select (exact match). */
export const selectFilter = (column: GridColumn): boolean => column.kind === "text" && (column.options?.length ?? 0) > 0 && column.options!.length <= SELECT_FILTER_MAX;

/**
 * What the filter row sends for a column (brief: text `contains`, number / money / date `between` or a comparison,
 * enum / boolean `in`). Empty or unreadable input sends nothing, as in the prototype.
 */
export function columnFilter(column: GridColumn, value: ColumnFilterValue | undefined): Filter | null {
  if (value === undefined || column.mode !== "visible" || !column.filterable) return null;
  if (typeof value === "object") {
    if (column.kind !== "date" || (!value.from && !value.to)) return null;
    return { field: column.field, op: "between", value: value.from || "0001-01-01", value2: value.to || "9999-12-31" };
  }
  if (value.trim() === "") return null;
  if (column.options && (column.kind === "enum" || column.kind === "uuid")) return { field: column.field, op: "in", value: [optionValue(column, value)] };
  if (selectFilter(column)) return { field: column.field, op: "eq", value };
  if (column.kind === "number") {
    const parsed = parseNumberFilter(value);
    return parsed ? { field: column.field, ...parsed } : null;
  }
  if (column.kind === "text" || column.kind === "json") return { field: column.field, op: "contains", value: value.trim() };
  return null;
}

/** A condition is complete when its rule takes no value or its value(s) are filled. */
export function conditionReady(c: Condition): boolean {
  if (NO_VALUE_OPS.has(c.op)) return true;
  const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  return filled(c.value) && (c.op !== "between" || filled(c.value2));
}

/** The conditions to send: only the complete ones (prototype `advApply`). */
export const readyConditions = (conditions: readonly Condition[]): Condition[] => conditions.filter(conditionReady);

/**
 * The flat filter list of the server's grid state. Fixed filters (`base`: the party switches) and the filter row
 * apply to every result, so they are put in front of each OR-group of the advanced conditions:
 * `P y (G1 o G2)` is sent as `P y G1 o P y G2`, which AND-before-OR evaluates the same.
 */
export function stateFilters(columns: readonly GridColumn[], view: Pick<GridView, "columnFilters" | "conditions">, base: readonly Filter[] = []): Filter[] {
  const byField = new Map(columns.map((c) => [c.field, c]));
  const prefix: Filter[] = [...base];
  for (const [field, value] of Object.entries(view.columnFilters)) {
    const column = byField.get(field);
    const filter = column ? columnFilter(column, value) : null;
    if (filter) prefix.push(filter);
  }
  const groups = orGroups(readyConditions(view.conditions));
  if (groups.length === 0) return prefix.map((f, i) => ({ ...f, join: i === 0 ? undefined : "and" }));
  return groups.flatMap((group, g) =>
    [...prefix, ...group].map((filter, i): Filter => {
      const f: Filter = { ...filter };
      delete f.join;
      return i === 0 ? (g === 0 ? f : { ...f, join: "or" }) : { ...f, join: "and" };
    }),
  );
}

/** Visible money columns: their sums come back as aggregates and the selection totals them. */
export const moneyColumns = (columns: readonly GridColumn[]): GridColumn[] => columns.filter((c) => c.type === "money" && c.mode === "visible");

/** The grid state POST /api/grid/:entity receives. */
export function toGridState(columns: readonly GridColumn[], view: GridView, options: { base?: readonly Filter[]; search?: string } = {}): GridStateInput {
  const shown = shownColumns(columns, view);
  const money = moneyColumns(shown);
  // Admin-defined values travel inside `extra`, already reduced to the keys the caller's roles may view.
  const fields = [...new Set(shown.map((c) => (c.field.startsWith("extra.") ? "extra" : c.field)))];
  return {
    filters: stateFilters(columns, view, options.base),
    sort: view.sort.map((s) => ({ field: s.field, dir: s.dir })),
    page: view.page,
    pageSize: view.pageSize,
    columns: fields,
    ...(money.length > 0 ? { aggregates: money.map((c) => ({ field: c.field, fn: "sum" as const })) } : {}),
    ...(options.search ? { search: options.search } : {}),
  };
}

/** Page buttons of the pager (prototype): every page up to 7, else the first, the last and two either side of the current, with `…` gaps. */
export function pagerButtons(page: number, pages: number): (number | "…")[] {
  const out: (number | "…")[] = [];
  for (let p = 1; p <= pages; p++) {
    if (pages > 7 && Math.abs(p - page) > 2 && p !== 1 && p !== pages) {
      if (out[out.length - 1] !== "…") out.push("…");
      continue;
    }
    out.push(p);
  }
  return out;
}

export const pageCount = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / pageSize));

/** Sums of the selected rows per visible money column. */
export function selectionTotals(rows: readonly GridRow[], selected: ReadonlySet<string>, columns: readonly GridColumn[]): { column: GridColumn; sum: number }[] {
  const chosen = rows.filter((r) => selected.has(r.id));
  return moneyColumns(columns).map((column) => ({
    column,
    sum: chosen.reduce((sum, row) => sum + (Number(row[column.field] ?? 0) || 0), 0),
  }));
}

/** A DIAN status (`complete`, `missing: n`, `errors`) as a pill. */
export function dianPill(status: unknown): { tone: PillTone; key: "complete" | "missing" | "errors"; count: number } | null {
  if (typeof status !== "string" || status === "") return null;
  if (status === "complete") return { tone: "ok", key: "complete", count: 0 };
  const missing = /^missing: (\d+)$/.exec(status);
  if (missing) return { tone: "warn", key: "missing", count: Number(missing[1]) };
  return { tone: "danger", key: "errors", count: 0 };
}

/** The value of `field` in a row: registry fields at the top level, admin-defined ones inside `extra`. */
export function cellValue(row: GridRow, field: string): unknown {
  if (field.startsWith("extra.")) {
    const extra = row.extra;
    return extra && typeof extra === "object" ? (extra as Record<string, unknown>)[field.slice(6)] : undefined;
  }
  return row[field];
}

/** The operators a column's family takes, in the builder's order. */
export const operatorsOf = (column: Pick<GridColumn, "kind">): readonly FilterOp[] => OPERATORS[column.kind];
