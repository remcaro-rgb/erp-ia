import type { AggregateFn, FilterKind, FilterOp, GridStateInput } from "@erp/kernel/query";

export type { AggregateFn, FilterKind, FilterOp, GridStateInput } from "@erp/kernel/query";

/** How a field reaches the caller (rule 14): masked fields show `••••••` and never filter or sort; hidden ones are left out. */
export type FieldMode = "visible" | "masked" | "hidden";

/** Colour of a pill (prototype `.pill.ok`…). */
export type PillTone = "ok" | "warn" | "danger" | "info" | "gray";

/**
 * One field of an entity as a grid, its filter row and its advanced filter offer it (design §9). The page builds the
 * list from the registry and the caller's field modes; labels arrive translated (admin-defined fields carry the
 * admin's own label).
 */
export interface GridColumn {
  /** Registry field, or `extra.<key>` for an admin-defined field. */
  field: string;
  label: string;
  /** Registry type (`money`, `enum`…) or `custom:<type>` for an admin-defined field. */
  type: string;
  /** The operator family (`@erp/kernel/query`). */
  kind: FilterKind;
  mode: FieldMode;
  filterable: boolean;
  sortable: boolean;
  /** Values of an enum, a boolean or a reference, with their labels (also how the cell shows them). */
  options?: { value: string; label: string }[];
  /** Pill colour per raw value (`true`, `complete`…). */
  pills?: Record<string, PillTone>;
  /** A row whose `field` holds a value while this column is `whenValue` shows `label` in `tone` instead (a posted comprobante that was reversed). Display only: filters keep the stored values. */
  marked?: { field: string; whenValue: string; label: string; tone: PillTone };
  /** `mono`: codes and ids; `dian`: a DIAN status pill (`complete`, `missing: n`, `errors`). */
  display?: "mono" | "dian";
  /** Offered by the column chooser and the advanced filter, but not shown until chosen. */
  hiddenByDefault?: boolean;
  /** The value of a row already includes its descendants: totals count only the rows with no ancestor in the result or the selection. */
  rollup?: boolean;
  /** Only in the advanced filter (stored fields not shown in the grid, admin-defined extra data). */
  filterOnly?: boolean;
  /**
   * The entity's identity column (its display field: Razón social, Descripción): shown first, pinned next to the
   * selection column while the grid scrolls sideways, and never moved behind other columns (OD-4).
   */
  identity?: boolean;
  /** A reference to a record of another entity (`ref` field): the cell shows its name (`<field>_label`) and links to it. */
  ref?: { entity: string; display: string };
  /**
   * The viewer may open the records of this column (rule 21): a reference's target, or for the identity column the row's
   * own record. Absent: the name is plain text.
   */
  linkable?: boolean;
  /**
   * A reference column whose target the viewer may not be able to read (a pedido of another salesperson): when the row carries no name for it,
   * the cell reads this text, plain and muted, never the id and never a link.
   */
  unavailable?: string;
}

export type GridRow = Record<string, unknown> & { id: string };

/** One group of a grouped grid (`GridResult.groups`): `keys` of the first `level` group fields, `<fn>:<field>` aggregates over the whole filter. */
export interface GroupRow {
  level: number;
  keys: Record<string, unknown>;
  count: number;
  aggregates: Record<string, unknown>;
}

/** One page as POST /api/grid/:entity answers it. */
export interface GridPage {
  rows: GridRow[];
  total: number;
  aggregates?: Record<string, unknown>;
  groups?: GroupRow[];
}

/** Reads a page of the grid's entity for a state (the grid passes an AbortSignal to drop stale requests). */
export type GridFetcher = (state: GridStateInput, signal?: AbortSignal) => Promise<GridPage>;

/** A condition of the advanced filter: `field · rule · value(s)`, joined to the previous one with Y / O. */
export interface Condition {
  field: string;
  op: FilterOp;
  value?: unknown;
  value2?: unknown;
  join?: "and" | "or";
}

/** What the filter row holds per column: the typed text, the chosen option, or a date range. */
export type ColumnFilterValue = string | { from: string; to: string };

export interface SortEntry {
  field: string;
  dir: "asc" | "desc";
}

/** Everything the user changed in a grid: what a saved view keeps (but the page). */
export interface GridView {
  columnFilters: Record<string, ColumnFilterValue>;
  conditions: Condition[];
  sort: SortEntry[];
  /** Agrupar por: up to three fields, in order (design §5.14); the rows come grouped and each group has its subtotals. */
  groupBy: string[];
  /** The functions of the group subtotals and the footer, per money column. */
  aggregateFns: AggregateFn[];
  page: number;
  pageSize: number;
  /** Fields shown, in order (what the grid request, the export and a saved view carry). */
  columns: string[];
  /**
   * Every field the column chooser offers, shown or not, in the user's order: a column the user hides keeps its place
   * here and comes back to it (design §22.12). Filled by `initialView`; `columns` is always this order's shown subset.
   */
  order?: string[];
}

/** Levels of a grid's sort and of its grouping. */
export const MAX_SORT_LEVELS = 5;
export const MAX_GROUP_LEVELS = 3;

export type ExportFormat = "pdf" | "xlsx" | "csv";
