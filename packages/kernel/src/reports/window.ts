import type { ReportResult } from "./types";
import type { ReportState } from "./state";

// The window of a report (design §9, accounting design §10a.5): the consult computes its rows, then filters, sorts and pages them as the grid
// state asks, and sums the totals over the whole filter. Shared by every module's reports (moved from accounting's reports for the sales
// report of plan 2B.2 Task 30.4: a module never imports another, rule 3).

type GridFilter = ReportState["filters"][number];

const cell = (row: Record<string, unknown>, field: string): unknown => row[field];

function matches(row: Record<string, unknown>, f: GridFilter): boolean {
  const v = cell(row, f.field);
  const text = (x: unknown) => String(x ?? "").toLowerCase();
  const cmp = (a: unknown, b: unknown): number => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "") return na - nb;
    return String(a ?? "").localeCompare(String(b ?? ""));
  };
  switch (f.op) {
    case "eq": return String(v ?? "") === String(f.value ?? "") || (typeof v === "number" && v === Number(f.value));
    case "neq": return !matches(row, { ...f, op: "eq" });
    case "contains": return text(v).includes(text(f.value));
    case "ncontains": return !text(v).includes(text(f.value));
    case "starts": return text(v).startsWith(text(f.value));
    case "ends": return text(v).endsWith(text(f.value));
    case "gt": return cmp(v, f.value) > 0;
    case "gte": return cmp(v, f.value) >= 0;
    case "lt": return cmp(v, f.value) < 0;
    case "lte": return cmp(v, f.value) <= 0;
    case "between": return cmp(v, f.value) >= 0 && cmp(v, f.value2) <= 0;
    case "in": return Array.isArray(f.value) && f.value.map(String).includes(String(v ?? ""));
    case "nin": return !(Array.isArray(f.value) && f.value.map(String).includes(String(v ?? "")));
    case "is_null": return v === null || v === undefined || v === "";
    case "not_null": return !(v === null || v === undefined || v === "");
    default: return true;
  }
}

/** AND binds tighter than OR, as in the grids. */
function passes(row: Record<string, unknown>, filters: readonly GridFilter[]): boolean {
  if (filters.length === 0) return true;
  const groups: boolean[][] = [[]];
  filters.forEach((f, i) => {
    if (i > 0 && f.join === "or") groups.push([]);
    groups[groups.length - 1]!.push(matches(row, f));
  });
  return groups.some((g) => g.every(Boolean));
}

export interface WindowOptions {
  /** Columns whose sum over the whole filter goes to `aggregates`. */
  totals?: readonly string[];
  /** Rows that are subtotals or footers are kept out of the sums. */
  isDetail?: (row: Record<string, unknown>) => boolean;
  /** Extra aggregates the report adds (omitted lines, differences). */
  extra?: Record<string, unknown>;
}

/** Filters, sorts and pages the computed rows as the grid state asks, and sums the totals over the whole filter. */
export function windowOf(rows: Record<string, unknown>[], state: ReportState, options: WindowOptions = {}): ReportResult {
  const filtered = rows.filter((r) => passes(r, state.filters));
  if (state.sort.length > 0) {
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      for (const s of state.sort) {
        const av = cell(a, s.field);
        const bv = cell(b, s.field);
        const diff = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
        if (diff !== 0) return s.dir === "asc" ? diff : -diff;
      }
      return 0;
    });
    filtered.splice(0, filtered.length, ...sorted);
  }
  const aggregates: Record<string, unknown> = { ...(options.extra ?? {}) };
  for (const field of options.totals ?? []) {
    aggregates[field] = filtered.filter((r) => options.isDetail?.(r) ?? true).reduce((sum, r) => sum + Number(r[field] ?? 0), 0);
  }
  const start = (state.page - 1) * state.pageSize;
  return { rows: filtered.slice(start, start + state.pageSize), total: filtered.length, aggregates };
}
