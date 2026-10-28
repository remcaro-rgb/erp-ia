import { initialView, stateFilters } from "./grid-model";
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
}

/** A saved view of the user, as `kernel.saved_view.list` returns it. */
export interface SavedViewItem {
  id: string;
  name: string;
  isDefault: boolean;
  state: SavedGridState;
}

/** What to store for the grid as it is now. */
export function savedStateOf(columns: readonly GridColumn[], view: GridView): SavedGridState {
  return { filters: stateFilters(columns, view), sort: view.sort, pageSize: view.pageSize, columns: view.columns };
}

/** The grid view a saved state comes back as; fields the caller no longer sees are dropped. */
export function viewFromSaved(columns: readonly GridColumn[], saved: SavedGridState): GridView {
  const known = new Map(columns.filter((c) => c.mode !== "hidden").map((c) => [c.field, c]));
  const base = initialView(columns);
  const shown = (saved.columns ?? []).filter((f) => known.has(f));
  return {
    ...base,
    conditions: (saved.filters ?? []).filter((f) => known.has(f.field)).map((f, i): Condition => ({ ...f, join: i === 0 ? undefined : f.join })),
    sort: (saved.sort ?? []).filter((s) => known.has(s.field)),
    pageSize: saved.pageSize ?? base.pageSize,
    columns: shown.length > 0 ? shown : base.columns,
  };
}

/** The user's default view of the entity, if any. */
export const defaultView = (views: readonly SavedViewItem[]): SavedViewItem | undefined => views.find((v) => v.isDefault);
