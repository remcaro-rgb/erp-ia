"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { cn } from "@erp/ui/lib/utils";
import { formatMoney } from "../money/format";
import { AdvancedFilter } from "./AdvancedFilter";
import { ColumnChooser } from "./ColumnChooser";
import { ConditionChips } from "./ConditionChips";
import { ExportButtons } from "./ExportButtons";
import { gridFetcher } from "./fetch-grid";
import { FilterRow } from "./FilterRow";
import { GridCell, isNumeric, type CellRenderer } from "./GridCell";
import { GridFooter } from "./GridFooter";
import { GroupControls } from "./GroupControls";
import { GroupHeaderRow } from "./GroupRow";
import { groupableColumns, groupHeads, groupId, identityField, moneyColumns, moveColumn, pageCount, selectionTotals, shownColumns, stateFilters, withGroupKeys } from "./grid-model";
import { savedStateOf, viewFromSaved, type SavedGridState, type SavedViewItem } from "./saved-views";
import { SavedViewsMenu } from "./SavedViewsMenu";
import { useGrid } from "./use-grid";
import { exportFailureText as failureText } from "./export-jobs";
import type { ExportSource } from "./export-client";
import { useGridExport } from "./use-grid-export";
import { MAX_SORT_LEVELS, type Condition, type ExportFormat, type GridColumn, type GridFetcher, type GridRow, type GridStateInput, type GridView, type GroupRow } from "./types";
import { useCellTimeZone } from "./cell-format";

type Filter = NonNullable<GridStateInput["filters"]>[number];

const NO_ROWS: GridRow[] = [];
/** Placeholder rows while the first page loads. */
const SKELETON_ROWS = 6;

const FORMAT_LABEL = { pdf: "pdf", xlsx: "excel", csv: "csv" } as const;

/** How long the grid's status row keeps a notice ("Columna Municipio movida a la posición 3"). */
const NOTICE_MS = 5000;
/** A movable header moves one place with these (design §22.12). */
const MOVE_KEYS = "Alt+ArrowLeft Alt+ArrowRight";

/**
 * One fixed slot for what the grid is doing (an export, a refetch, a column just moved), for screen readers and eyes
 * alike (role="status"). Always rendered, empty when idle, so the header never reflows (UI density audit M3).
 */
export function GridStatusText({ status, refreshing, notice }: { status: ReturnType<typeof useGridExport>["status"]; refreshing: boolean; notice: string }) {
  const t = useTranslations();
  const text =
    status.phase === "idle"
      ? notice || (refreshing ? t("grid.refreshing") : "")
      : status.phase === "working"
      ? t("grid.export.working", { format: t(`grid.export.${FORMAT_LABEL[status.format]}`) })
      : status.phase === "job"
        ? t("grid.export.job")
        : status.phase === "ready"
          ? t("grid.export.ready", { file: status.fileName })
          : t("grid.export.failed", { reason: failureText(t, status) });
  return (
    <span role="status" title={text || undefined} className={status.phase === "failed" ? "erp-small erp-grid__status is-error" : "erp-small erp-muted erp-grid__status"}>
      {text}
    </span>
  );
}

export interface DataGridProps {
  /** Registry id of the entity (`core.party`). */
  entity: string;
  /** The grid header names the entity (grid pages have no page title, design §19a). */
  title: string;
  /** Every field the caller may know of, with its mode; the grid shows the ones not hidden by default. */
  columns: GridColumn[];
  /** Reads a page; POST /api/grid/<entity> by default. */
  fetcher?: GridFetcher;
  initialState?: Partial<GridView>;
  onRowOpen?: (row: GridRow) => void;
  /** A cell's own content for some columns (the default text for the rest); masked cells always show ••••••. */
  renderCell?: CellRenderer;
  /** Buttons before the grid's own (Nuevo, Importar). */
  toolbar?: ReactNode;
  /** Next to the title (the party switches). */
  headerExtra?: ReactNode;
  /** Filters every request carries. */
  baseFilters?: Filter[];
  /** Shown under "Aún no hay registros" when the entity has none (its create action, when the caller may create); never under a filtered empty result. */
  emptyAction?: ReactNode;
  /** Values of the entity's grid params (`EntityDef.gridParams`, e.g. the period of a figure column): merged into every request, preview and export. */
  params?: Record<string, string>;
  /**
   * Exports the current filter (all pages, visible columns). The grid runs the export itself (POST /api/export,
   * `kernel.export.run`) unless a handler is given. The state carries the grid's filters and sort and the shown
   * columns by field name (an admin-defined one as `extra.<key>`), on page 1 and without sums: the server exports
   * every page of what the caller is allowed to see.
   */
  onExport?: (format: ExportFormat, state: GridStateInput) => void;
  /** The user's saved views of the entity; "Guardar vista" shows when given. */
  savedViews?: {
    views: readonly SavedViewItem[];
    onSave: (name: string, isDefault: boolean, state: SavedGridState) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
  };
  /** Where the export is requested; POST /api/export by default. */
  exportEndpoint?: string;
  /** A report's grid exports the report with its parameters (`source: { kind: "report" }`), not the entity's rows. */
  exportSource?: ExportSource;
  /** Called after a saved view is applied (a report restores the parameters it saved). */
  onViewApplied?: (view: SavedViewItem) => void;
  debounceMs?: number;
}

/**
 * The universal grid (design §9, rule 20, prototype `gridHtml`): bound to an entity, server-driven (filters, sort and
 * pages go to POST /api/grid/<entity> and come back over the masked view), with the filter row by type, click to
 * sort (shift adds a key), the column chooser, the advanced filter with its chips, row selection with money totals,
 * the pager, saved views and the export buttons.
 */
export function DataGrid({ entity, title, columns, fetcher, initialState, onRowOpen, renderCell, toolbar, headerExtra, baseFilters, emptyAction, params, onExport, exportEndpoint, exportSource, onViewApplied, savedViews, debounceMs }: DataGridProps) {
  const t = useTranslations();
  const fetchPage = useMemo(() => fetcher ?? gridFetcher(entity), [fetcher, entity]);
  const grid = useGrid({ columns, fetcher: fetchPage, initialView: initialState, baseFilters, params, debounceMs });
  const { view, data } = grid;
  const exporter = useGridExport({ entity, title, source: exportSource, endpoint: exportEndpoint });
  const shown = shownColumns(columns, view);
  const rows = data.page?.rows ?? NO_ROWS;
  const total = data.page?.total ?? 0;
  const timeZone = useCellTimeZone();

  // Agrupar por (accounting design §5.14): the rows come ordered by the group fields; a group row opens each group on
  // the page and a click collapses it (client state: the rows stay in the page, only the view hides them).
  const groupFields = view.groupBy;
  const groupColumns = useMemo(() => groupableColumns(columns), [columns]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const heads = useMemo(() => (groupFields.length > 0 ? groupHeads(rows, groupFields, data.page?.groups) : new Map<number, GroupRow[]>()), [rows, groupFields, data.page?.groups]);
  const ancestorIds = (row: GridRow) => groupFields.map((_, i) => groupId({ level: i + 1, keys: Object.fromEntries(groupFields.slice(0, i + 1).map((f) => [f, row[f]])) }));
  const rowHidden = (row: GridRow) => groupFields.length > 0 && ancestorIds(row).some((id) => collapsed.has(id));
  const hiddenRows = rows.filter(rowHidden).length;
  const toggleGroup = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const collapseAll = () => setCollapsed(new Set([...heads.values()].flat().map(groupId)));
  const [sortNotice, setSortNotice] = useState("");
  useEffect(() => {
    if (!sortNotice) return;
    const timer = setTimeout(() => setSortNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [sortNotice]);
  // Nothing has come back yet: the count would read "0 registros" and the body would be empty.
  const firstLoad = data.loading && !data.page;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Roving tabindex (WAI-ARIA grid rows): one row is the grid's single tab stop and the arrow keys move it.
  const [activeRow, setActiveRow] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const refocusRows = useRef(false);
  const [rowsSeen, setRowsSeen] = useState(rows);
  if (rowsSeen !== rows) {
    // A new page of rows starts with nothing selected, on its first row.
    setRowsSeen(rows);
    setSelected(new Set());
    setActiveRow(0);
  }
  // PgDn / PgUp: the caret follows onto the new page's first row, but only if it is still on the rows (or was dropped
  // with the old page): the user may have moved on meanwhile. A failed read forgets the request.
  useEffect(() => {
    if (!refocusRows.current || rows.length === 0) return;
    refocusRows.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && !bodyRef.current?.contains(active)) return;
    bodyRef.current?.querySelector<HTMLTableRowElement>("tr[data-row]")?.focus();
  }, [rows]);
  useEffect(() => {
    if (data.error !== null) refocusRows.current = false;
  }, [data.error]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleRow = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const firstFilter = () => sectionRef.current?.querySelector<HTMLElement>(".erp-grid__filters :is(input, select):not(:disabled)");
  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - hiddenRows - 1, index));
    setActiveRow(next);
    bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[next]?.focus();
  };
  const pages = pageCount(total, view.pageSize);
  const turnPage = (page: number) => {
    refocusRows.current = true;
    grid.setPage(page);
  };
  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: GridRow) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusRow(index + 1),
      ArrowUp: () => (index === 0 ? firstFilter()?.focus() : focusRow(index - 1)),
      Home: () => focusRow(0),
      End: () => focusRow(rows.length - hiddenRows - 1),
      PageDown: () => view.page < pages && turnPage(view.page + 1),
      PageUp: () => view.page > 1 && turnPage(view.page - 1),
      " ": () => toggleRow(row.id),
      Enter: () => onRowOpen?.(row),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };
  // "/" anywhere in the grid (outside a text box) goes to the first filter, as in mail and issue trackers.
  const onGridKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    // React events bubble through portals: a key typed in a dialog the grid opened is the dialog's.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).closest("input, select, textarea, [contenteditable]")) return;
    event.preventDefault();
    firstFilter()?.focus();
  };
  const tabRow = Math.min(activeRow, Math.max(rows.length - hiddenRows - 1, 0));

  // Movable columns (design §22.12, rule 20): drag a header, or Alt+← / Alt+→ on it. The identity column is pinned
  // first (OD-4) and does not move. The new order goes with the next grid request and is kept by a saved view.
  const identity = identityField(columns);
  const pinned = shown[0]?.identity ? shown[0].field : undefined;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ field: string; side: "before" | "after" } | null>(null);
  const [moved, setMoved] = useState<{ field: string; columns: readonly string[] } | null>(null);
  // The column the last move was about, and whether the caret goes back to its header (a keyboard move).
  const pendingMove = useRef<{ field: string; focus: boolean } | null>(null);
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => setMoved(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [moved]);
  // The move has been applied: say where the column is now (from the committed order, so every auto-repeated
  // Alt+→ reads its own result) and give the caret back to its header, which React re-laid.
  const [columnsSeen, setColumnsSeen] = useState(view.columns);
  if (columnsSeen !== view.columns) {
    setColumnsSeen(view.columns);
    const pending = pendingMove.current;
    if (pending) setMoved({ field: pending.field, columns: view.columns });
  }
  useEffect(() => {
    const pending = pendingMove.current;
    pendingMove.current = null;
    if (!pending?.focus) return;
    const th = sectionRef.current?.querySelector<HTMLElement>(`thead th[data-field="${CSS.escape(pending.field)}"]`);
    (th?.querySelector<HTMLElement>("button") ?? th)?.focus();
  }, [view.columns]);
  const movedLabel = moved ? (columns.find((c) => c.field === moved.field)?.label ?? moved.field) : "";
  const notice = sortNotice || (moved ? t("grid.column_moved", { label: movedLabel, position: moved.columns.indexOf(moved.field) + 1 }) : "");
  const onHeaderKey = (event: KeyboardEvent<HTMLTableCellElement>, field: string) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Alt+← is also the browser's Back: never let it through from a header.
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    if (moveColumn(view, field, view.columns.indexOf(field) + delta, identity) === view) return;
    pendingMove.current = { field, focus: true };
    grid.moveColumnBy(field, delta);
  };
  const dropSide = (event: DragEvent<HTMLElement>, field: string): "before" | "after" => {
    if (field === pinned) return "after";
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX > box.left + box.width / 2 ? "after" : "before";
  };
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const headerDrag = (field: string) => ({
    onDragStart: (event: DragEvent<HTMLTableCellElement>) => {
      setDragging(field);
      event.dataTransfer?.setData("text/plain", field);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event: DragEvent<HTMLTableCellElement>) => {
      if (dragging === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const side = dropSide(event, field);
      if (dropAt?.field !== field || dropAt.side !== side) setDropAt({ field, side });
    },
    onDrop: (event: DragEvent<HTMLTableCellElement>) => {
      if (dragging === null) return;
      event.preventDefault();
      const from = view.columns.indexOf(dragging);
      let to = view.columns.indexOf(field) + (dropSide(event, field) === "after" ? 1 : 0);
      if (from >= 0 && from < to) to -= 1;
      if (from >= 0 && to >= 0 && moveColumn(view, dragging, to, identity) !== view) {
        pendingMove.current = { field: dragging, focus: false };
        grid.moveColumn(dragging, to);
      }
      endDrag();
    },
    onDragEnd: endDrag,
  });

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const filterFields = columns.filter((c) => c.mode !== "hidden");
  const hiddenCount = columns.filter((c) => c.mode === "hidden" && !c.filterOnly).length;
  const maskedCount = shown.filter((c) => c.mode === "masked").length;
  // Only what the user typed makes an empty page "no matches"; a sort, a base filter or a scope does not.
  const filtering = Object.keys(view.columnFilters).length > 0 || view.conditions.length > 0;
  const dirty = view.sort.length > 0 || Object.keys(view.columnFilters).length > 0 || view.conditions.length > 0;

  const preview = (conditions: Condition[]) =>
    fetchPage({
      filters: stateFilters(columns, { columnFilters: {}, conditions }, baseFilters),
      sort: view.sort,
      page: 1,
      pageSize: 50,
      columns: [...new Set(["id", ...shown.map((c) => (c.field.startsWith("extra.") ? "extra" : c.field))])],
      ...(params ? { params } : {}),
    });

  const exportState = (): GridStateInput => ({ ...grid.state, aggregates: groupFields.length > 0 ? grid.state.aggregates : undefined, page: 1, columns: shown.map((c) => c.field) });

  // The footer's grand totals: the sum, or the first chosen function when Suma is off.
  const footFn = view.aggregateFns.includes("sum") ? "sum" : (view.aggregateFns[0] ?? "sum");
  const sums = moneyColumns(shown)
    .map((column) => ({ column, sum: data.page?.aggregates?.[`${footFn}:${column.field}`] }))
    .filter((s) => s.sum !== undefined);
  // "Suma" goes in the identity cell, or the first column without a total of its own.
  const sumLabelAt = shown.findIndex((c) => !sums.some((s) => s.column.field === c.field));
  // OD-4: the selection column and the identity column stay put while the others scroll sideways under them.
  const pinClass = "erp-grid__id is-pinned is-pinned-edge";
  const checkClass = pinned ? "erp-grid__check is-pinned" : "erp-grid__check is-pinned is-pinned-edge";
  const errorText =
    data.error === null
      ? null
      : data.errorNote
        ? data.errorNote
        : t.has(`grid.query_errors.${data.error}`)
        ? t(`grid.query_errors.${data.error}`)
        : t.has(`errors.${data.error}`)
          ? t(`errors.${data.error}`)
          : t("grid.load_failed");

  return (
    <section ref={sectionRef} className="erp-grid" aria-label={title} aria-busy={data.loading} onKeyDown={onGridKey}>
      <div className="erp-grid__hd">
        <h2>{title}</h2>
        <span className="erp-small erp-muted">
          {firstLoad ? t("grid.loading") : t("grid.count", { count: total })}
          {(hiddenCount > 0 || maskedCount > 0) && (
            <span title={t("grid.visibility_title")}>
              {" · "}
              {[hiddenCount > 0 && t("grid.hidden_count", { count: hiddenCount }), maskedCount > 0 && t("grid.masked_count", { count: maskedCount })].filter(Boolean).join(", ")}
            </span>
          )}
        </span>
        {headerExtra}
        <div className="erp-grow" />
        {toolbar}
        <ColumnChooser columns={columns} order={view.order} shown={view.columns} onToggle={grid.showColumn} onMove={grid.stepColumn} onReset={grid.resetColumns} />
        {savedViews && (
          <SavedViewsMenu
            views={savedViews.views}
            current={() => savedStateOf(columns, view)}
            onSave={savedViews.onSave}
            onDelete={savedViews.onDelete}
            onApply={(v) => (grid.apply(viewFromSaved(columns, v.state)), onViewApplied?.(v))}
          />
        )}
        {groupColumns.length > 0 && (
          <button type="button" className={groupFields.length > 0 ? "erp-btn erp-btn--primary" : "erp-btn"} aria-expanded={groupsOpen || groupFields.length > 0} onClick={() => setGroupsOpen((o) => !o)}>
            {t("grid.group.group_by")}
            {groupFields.length > 0 ? ` (${groupFields.length})` : ""}
          </button>
        )}
        {groupColumns.length > 0 && moneyColumns(shown).length > 0 && (
          <button type="button" className="erp-btn" onClick={() => setGroupsOpen((o) => !o)}>
            {t("grid.group.aggregates")}
          </button>
        )}
        <button type="button" className={view.conditions.length > 0 ? "erp-btn erp-btn--primary" : "erp-btn"} onClick={() => setAdvancedOpen(true)}>
          <Search aria-hidden="true" className="erp-icon" />
          {view.conditions.length > 0 ? t("grid.advanced_count", { count: view.conditions.length }) : t("grid.advanced_filter")}
        </button>
        <ExportButtons onExport={(format) => (onExport ? onExport(format, exportState()) : void exporter.run(format, exportState()))} busy={exporter.busy} />
        <GridStatusText status={exporter.status} refreshing={data.loading && data.page !== null} notice={notice} />
        {/* Always laid out; hidden (not removed) while there is nothing to clear, so nothing to its left moves. */}
        <button
          type="button"
          className={dirty ? "erp-btn erp-btn--ghost erp-grid__clear" : "erp-btn erp-btn--ghost erp-grid__clear is-reserved"}
          onClick={() => {
            grid.clear();
            // The button hides itself (nothing left to clear): the caret goes where the next filter is typed.
            firstFilter()?.focus();
          }}
          disabled={!dirty}
          aria-hidden={dirty ? undefined : true}
          tabIndex={dirty ? undefined : -1}
        >
          {t("grid.clear_filters")}
        </button>
      </div>
      {(groupsOpen || groupFields.length > 0) && groupColumns.length > 0 && (
        <GroupControls
          columns={groupColumns}
          groupBy={groupFields}
          aggregateFns={view.aggregateFns}
          onGroupBy={(fields) => {
            setCollapsed(new Set());
            grid.setGroupBy(fields);
          }}
          onAggregateFns={grid.setAggregateFns}
          onCollapseAll={collapseAll}
          onExpandAll={() => setCollapsed(new Set())}
        />
      )}
      {view.conditions.length > 0 && (
        <div className="erp-grid__chips">
          <ConditionChips conditions={view.conditions} fields={filterFields} onRemove={grid.removeCondition} />
        </div>
      )}
      {errorText && (
        <div role="alert" className="erp-grid__error">
          {errorText}
        </div>
      )}
      <div
        className="erp-grid__body"
        onScroll={(e) => {
          // The pinned columns cast a shadow once the others slide under them (not managed by React: no re-render).
          e.currentTarget.toggleAttribute("data-scrolled-x", e.currentTarget.scrollLeft > 0);
        }}
      >
        <table>
          <thead>
            <tr>
              <th className={checkClass}>
                <input
                  type="checkbox"
                  aria-label={t("grid.select_all")}
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                />
              </th>
              {shown.map((column) => {
                const sortIndex = view.sort.findIndex((s) => s.field === column.field);
                const sort = view.sort[sortIndex];
                const canSort = column.sortable && column.mode === "visible";
                const fixed = column.field === pinned;
                return (
                  <th
                    key={column.field}
                    data-field={column.field}
                    className={cn(
                      isNumeric(column) && "text-right",
                      fixed && pinClass,
                      !fixed && "erp-grid__movable",
                      dragging === column.field && "is-dragging",
                      dropAt?.field === column.field && dragging !== column.field && `is-drop-${dropAt.side}`,
                    )}
                    aria-sort={sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    draggable={fixed ? undefined : true}
                    aria-grabbed={fixed ? undefined : dragging === column.field}
                    // The shortcut is named on what takes the caret: the sort button, or the header itself.
                    aria-keyshortcuts={fixed || canSort ? undefined : MOVE_KEYS}
                    // A header without a sort button still takes the caret, so the keyboard can move it.
                    tabIndex={canSort || fixed ? undefined : 0}
                    onKeyDown={(e) => onHeaderKey(e, column.field)}
                    {...(fixed ? { onDragOver: headerDrag(column.field).onDragOver, onDrop: headerDrag(column.field).onDrop } : headerDrag(column.field))}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className="erp-grid__sort"
                        aria-label={t("grid.sort_by", { label: column.label })}
                        aria-keyshortcuts={fixed ? undefined : MOVE_KEYS}
                        onClick={(e) => (e.shiftKey && view.sort.length >= MAX_SORT_LEVELS && !view.sort.some((s) => s.field === column.field) ? setSortNotice(t("grid.sort.max_levels")) : grid.sortBy(column.field, e.shiftKey))}
                      >
                        {column.label}{" "}
                        {sort ? (
                          <span aria-hidden="true">
                            {sort.dir === "asc" ? "▲" : "▼"}
                            {view.sort.length > 1 ? <sup>{sortIndex + 1}</sup> : null}
                          </span>
                        ) : (
                          <span aria-hidden="true" className="erp-grid__unsorted">
                            ↕
                          </span>
                        )}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
            <FilterRow columns={shown} values={view.columnFilters} onChange={grid.setColumnFilter} selectable pinned={pinned} />
          </thead>
          <tbody ref={bodyRef}>
            {(() => {
              let visible = -1;
              return rows.flatMap((row, rowIndex) => {
                const ancestors = groupFields.length > 0 ? ancestorIds(row) : [];
                // A group row is hidden under a collapsed group of a higher level; the line, under its own too.
                const heads_ = (heads.get(rowIndex) ?? [])
                  .filter((g) => !ancestors.slice(0, g.level - 1).some((id) => collapsed.has(id)))
                  .map((g) => (
                    <GroupHeaderRow
                      key={`group-${groupId(g)}`}
                      group={g}
                      column={columns.find((c) => c.field === groupFields[g.level - 1])}
                      shown={shown}
                      fns={view.aggregateFns}
                      collapsed={collapsed.has(groupId(g))}
                      checkClass={checkClass}
                      timeZone={timeZone}
                      onToggle={toggleGroup}
                      onOpen={(group) => grid.setConditions(withGroupKeys(view.conditions, group))}
                    />
                  ));
                if (ancestors.some((id) => collapsed.has(id))) return heads_;
                visible += 1;
                const index = visible;
                return [
                  ...heads_,
                  <tr
                    key={row.id}
                    data-row=""
                    className={selected.has(row.id) ? "erp-row-link is-selected" : "erp-row-link"}
                    tabIndex={index === tabRow ? 0 : -1}
                    aria-selected={selected.has(row.id)}
                    onFocus={(e) => e.target === e.currentTarget && setActiveRow(index)}
                    onClick={() => onRowOpen?.(row)}
                    onKeyDown={(e) => onRowKey(e, index, row)}
                  >
                    <td className={checkClass} onClick={(e) => e.stopPropagation()}>
                      {/* Out of the tab order: Space on the row selects it (one tab stop for the whole body). */}
                      <input type="checkbox" tabIndex={-1} aria-label={t("grid.select_row")} checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
                    </td>
                    {shown.map((column) => (
                      <GridCell key={column.field} column={column} row={row} render={renderCell} className={column.field === pinned ? pinClass : undefined} />
                    ))}
                  </tr>,
                ];
              });
            })()}
            {firstLoad &&
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <tr key={`skeleton-${i}`} className="erp-grid__skeleton" aria-hidden="true">
                  <td className={checkClass} />
                  {shown.map((column) => (
                    <td key={column.field} className={column.field === pinned ? pinClass : undefined}>
                      <span />
                    </td>
                  ))}
                </tr>
              ))}
            {!data.loading && rows.length === 0 && (
              <tr>
                <td colSpan={shown.length + 1} className="erp-muted erp-grid__empty">
                  {filtering ? (
                    t("grid.empty_filtered")
                  ) : (
                    <>
                      <div>{t("grid.empty")}</div>
                      {emptyAction ? <div className="erp-grid__empty-action">{emptyAction}</div> : null}
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
          {/* OD-5: the filter's money totals (every page) under their own columns, pinned to the bottom of the scroll area. */}
          {sums.length > 0 && rows.length > 0 && (
            <tfoot>
              <tr>
                <td className={checkClass} />
                {shown.map((column, i) => {
                  const sum = sums.find((s) => s.column.field === column.field);
                  return (
                    <td key={column.field} className={cn(column.field === pinned && pinClass, sum && "erp-num text-right")}>
                      {sum ? (sum.sum === null ? <span className="erp-muted" title={t("grid.total_unknown")}>—</span> : formatMoney(sum.sum as number | string) || formatMoney(0)) : i === sumLabelAt ? (footFn === "sum" ? t("grid.totals") : t(`grid.group.fn.${footFn}`)) : null}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <GridFooter
        page={view.page}
        pageSize={view.pageSize}
        total={total}
        loading={firstLoad}
        onPage={grid.setPage}
        keysHint={rows.length > 0}
        hiddenInGroups={hiddenRows}
        onPageSize={grid.setPageSize}
        selection={{ count: [...selected].filter((id) => rows.some((r) => r.id === id)).length, totals: selectionTotals(rows, selected, shown) }}
      />
      <AdvancedFilter
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        entityLabel={title}
        fields={filterFields}
        conditions={view.conditions}
        onApply={grid.setConditions}
        preview={preview}
        previewColumns={shown.filter((c) => c.field !== "seq")}
        mode="open"
        onPickRow={(row) => onRowOpen?.(row)}
      />
    </section>
  );
}
