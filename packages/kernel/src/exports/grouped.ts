import type { AggregateFn } from "../query/grid-state";
import type { GroupRow } from "../query/run";
import { isSpanish } from "./format";
import type { ExportColumn, ExportRow, RowSource, WriterOptions } from "./types";

// A grouped export (accounting design §5.14): the grid's rows come ordered by the group fields; the file gets a group
// path column `Grupo` first, a subtotal row after each group (one per chosen aggregate function) and the grand total
// last. Rows carry `__level`, the Excel outline level: lines at the deepest level, a group's summary one above.

/** The path column's field. */
export const GROUP_FIELD = "__group";
/** Marks a row that is a subtotal (`subtotal`) or the grand total (`total`). */
export const ROW_KIND = "__kind";
/** The Excel outline level of a row. */
export const ROW_LEVEL = "__level";
/** The group fields' raw values on a line, which the reader attaches (`exportRows`). */
export const ROW_KEYS = "__keys";

const TEXT = {
  es: { group: "Grupo", general: "general", fn: { sum: "Total", avg: "Promedio", min: "Mínimo", max: "Máximo", count: "Conteo" } },
  en: { group: "Group", general: "overall", fn: { sum: "Total", avg: "Average", min: "Minimum", max: "Maximum", count: "Count" } },
};

export interface GroupedSpec {
  /** The `groupBy` fields in order. */
  fields: readonly string[];
  /** Every group of every level over the whole filter (`GridResult.groups`). */
  groups: readonly GroupRow[];
  /** The grand total's `<fn>:<field>` aggregates. */
  grand: Record<string, unknown>;
  /** One subtotal row per function. */
  fns: readonly AggregateFn[];
  /** The columns whose aggregates the rows carry. */
  valueFields: readonly string[];
  /** The text of a group key as the screen shows it (a label of an enum); the raw value when absent. */
  labelOf?: (field: string, value: unknown) => string;
}

const keyOf = (value: unknown): string => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? "" : String(value));

/** `columns` with the group path column first. */
export function groupedColumns(columns: readonly ExportColumn[], options: WriterOptions & { label?: string } = {}): ExportColumn[] {
  return [{ field: GROUP_FIELD, label: options.label ?? (isSpanish(options.locale) ? TEXT.es : TEXT.en).group, type: "text" }, ...columns];
}

/** The rows of the file: the lines with their path, the subtotals after each group and the grand total. */
export async function* groupedRows(rows: RowSource, spec: GroupedSpec, options: WriterOptions = {}): AsyncGenerator<ExportRow> {
  const text = isSpanish(options.locale) ? TEXT.es : TEXT.en;
  const depth = spec.fields.length;
  const labelOf = spec.labelOf ?? ((_field: string, value: unknown) => keyOf(value));
  const byKey = new Map(spec.groups.map((g) => [`${g.level}|${spec.fields.slice(0, g.level).map((f) => keyOf(g.keys[f])).join("\u0000")}`, g]));
  const path = (keys: readonly unknown[], level: number) => keys.slice(0, level).map((v, i) => labelOf(spec.fields[i]!, v)).join(" › ");
  const totals = function* (aggregates: Record<string, unknown>, label: (fn: AggregateFn) => string, level: number): Generator<ExportRow> {
    for (const fn of spec.fns) {
      const row: ExportRow = { [GROUP_FIELD]: label(fn), [ROW_KIND]: level === 0 ? "total" : "subtotal", [ROW_LEVEL]: level === 0 ? 0 : level - 1 };
      for (const field of spec.valueFields) row[field] = aggregates[`${fn}:${field}`];
      yield row;
    }
  };
  const closing = function* (keys: readonly unknown[], fromLevel: number): Generator<ExportRow> {
    for (let level = depth; level >= fromLevel; level--) {
      const group = byKey.get(`${level}|${keys.slice(0, level).map(keyOf).join("\u0000")}`);
      if (group) yield* totals(group.aggregates, (fn) => `${text.fn[fn]} ${path(keys, level)}`, level);
    }
  };

  let previous: unknown[] | null = null;
  for await (const row of Symbol.asyncIterator in rows ? rows : (async function* () { yield* rows as Iterable<ExportRow>; })()) {
    const stored = row[ROW_KEYS] as Record<string, unknown> | undefined;
    const keys = spec.fields.map((f) => stored?.[f] ?? row[f]);
    if (previous) {
      // The first level whose key changed: every group from there down is closed.
      const changed = keys.findIndex((k, i) => keyOf(k) !== keyOf(previous![i]));
      if (changed >= 0) yield* closing(previous, changed + 1);
    }
    previous = keys;
    yield { ...row, [GROUP_FIELD]: path(keys, depth), [ROW_LEVEL]: depth };
  }
  if (previous) yield* closing(previous, 1);
  yield* totals(spec.grand, (fn) => `${text.fn[fn]} ${text.general}`, 0);
}
