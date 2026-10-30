import { orGroups } from "@erp/kernel/query";
import { columnOrder, initialView, viewFilters } from "./grid-model";
import type { Condition, GridColumn, GridStateInput, GridView, SortEntry } from "./types";

// Saved views (design §9, rule 20): what a view keeps of a grid (filters with their Y / O joins, sort, page size and
// columns, never the page) and how a grid comes back from one. The filter row and the advanced conditions are kept
// as one list of conditions: a view comes back with them as chips, which select the same rows.

type Filter = NonNullable<GridStateInput["filters"]>[number];

/** The state a view stores (`kernel.saved_views.state`, the kernel's `SavedViewState`). */
export interface SavedGridState {
  filters?: Filter[];
  sort?: SortEntry[];
  pageSize?: number;
  columns?: string[];
  /** Every field the column chooser offers, shown or not, in the user's order (design §22.12); older views have none. */
  order?: string[];
  /** A report's parameter set (entity `report:<id>`); the report's own schema checks it when it runs. */
  params?: Record<string, unknown>;
}

/** A saved view of the user, as `kernel.saved_view.list` returns it. */
export interface SavedViewItem {
  id: string;
  name: string;
  isDefault: boolean;
  state: SavedGridState;
}

/**
 * What to store for the grid as it is now: the filters as typed (a coded column keeps its label, rule 20), the shown
 * columns in their order and the chooser's full order (hidden columns included), so a column moved and then hidden
 * comes back to its place when shown again (design §22.12).
 */
export function savedStateOf(columns: readonly GridColumn[], view: GridView): SavedGridState {
  return { filters: viewFilters(columns, view), sort: view.sort, pageSize: view.pageSize, columns: view.columns, order: columnOrder(columns, view) };
}

/** The grid view a saved state comes back as; fields the caller no longer sees are dropped. */
export function viewFromSaved(columns: readonly GridColumn[], saved: SavedGridState): GridView {
  const known = new Map(columns.filter((c) => c.mode !== "hidden").map((c) => [c.field, c]));
  // A masked field never filters or sorts (rule 14): its conditions and sort are dropped like a hidden field's.
  const usable = (field: string) => known.get(field)?.mode === "visible";
  const shown = (saved.columns ?? []).filter((f) => known.has(f));
  const order = (saved.order ?? []).filter((f) => known.has(f));
  // The saved columns in their saved order and the saved full order (design §22.12); a view saved without `order`
  // (older ones) gets the declared order, the chooser's other columns falling in around the shown ones.
  const base = initialView(columns, { ...(shown.length > 0 ? { columns: shown } : {}), ...(order.length > 0 ? { order } : {}) });
  return {
    ...base,
    conditions: keepGroups(saved.filters ?? [], usable),
    sort: (saved.sort ?? []).filter((s) => usable(s.field)),
    pageSize: saved.pageSize ?? base.pageSize,
  };
}

/**
 * The conditions whose field passes `keep`, with the OR groups as they were: a group that loses its first condition
 * still starts with O, and a group left empty disappears.
 */
export function keepGroups(filters: readonly Filter[], keep: (field: string) => boolean): Condition[] {
  return orGroups(filters)
    .map((group) => group.filter((f) => keep(f.field)))
    .filter((group) => group.length > 0)
    .flatMap((group, g) => group.map((f, i): Condition => ({ ...f, join: i > 0 ? "and" : g === 0 ? undefined : "or" })));
}

/** The user's default view of the entity, if any. */
export const defaultView = (views: readonly SavedViewItem[]): SavedViewItem | undefined => views.find((v) => v.isDefault);
