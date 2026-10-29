"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { AdvancedFilter } from "./AdvancedFilter";
import { ColumnChooser } from "./ColumnChooser";
import { ConditionChips } from "./ConditionChips";
import { ExportButtons } from "./ExportButtons";
import { gridFetcher } from "./fetch-grid";
import { FilterRow } from "./FilterRow";
import { GridCell, isNumeric } from "./GridCell";
import { GridFooter } from "./GridFooter";
import { initialView, moneyColumns, selectionTotals, shownColumns, stateFilters } from "./grid-model";
import { savedStateOf, viewFromSaved, type SavedGridState, type SavedViewItem } from "./saved-views";
import { SavedViewsMenu } from "./SavedViewsMenu";
import { useGrid } from "./use-grid";
import { useGridExport } from "./use-grid-export";
import type { Condition, ExportFormat, GridColumn, GridFetcher, GridRow, GridStateInput, GridView } from "./types";

type Filter = NonNullable<GridStateInput["filters"]>[number];

const NO_ROWS: GridRow[] = [];
/** Placeholder rows while the first page loads. */
const SKELETON_ROWS = 6;

const FORMAT_LABEL = { pdf: "pdf", xlsx: "excel", csv: "csv" } as const;

/** Why an export failed: the server's own reason when the screen has words for it, else the error code's. */
function failureText(t: ReturnType<typeof useTranslations>, status: { code: string; detail?: string }): string {
  if (status.detail && t.has(`grid.export.reasons.${status.detail}`)) return t(`grid.export.reasons.${status.detail}`);
  return t.has(`errors.${status.code}`) ? t(`errors.${status.code}`) : t("errors.unknown");
}

/** How the running export is going, for screen readers and eyes alike (role="status"). */
function ExportStatusText({ status }: { status: ReturnType<typeof useGridExport>["status"] }) {
  const t = useTranslations();
  if (status.phase === "idle") return null;
  const text =
    status.phase === "working"
      ? t("grid.export.working", { format: t(`grid.export.${FORMAT_LABEL[status.format]}`) })
      : status.phase === "job"
        ? t("grid.export.job")
        : status.phase === "ready"
          ? t("grid.export.ready", { file: status.fileName })
          : t("grid.export.failed", { reason: failureText(t, status) });
  return (
    <span role="status" className={status.phase === "failed" ? "erp-small erp-export-status is-error" : "erp-small erp-muted erp-export-status"}>
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
  /** Buttons before the grid's own (Nuevo, Importar). */
  toolbar?: ReactNode;
  /** Next to the title (the party switches). */
  headerExtra?: ReactNode;
  /** Filters every request carries. */
  baseFilters?: Filter[];
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
  debounceMs?: number;
}

/**
 * The universal grid (design §9, rule 20, prototype `gridHtml`): bound to an entity, server-driven (filters, sort and
 * pages go to POST /api/grid/<entity> and come back over the masked view), with the filter row by type, click to
 * sort (shift adds a key), the column chooser, the advanced filter with its chips, row selection with money totals,
 * the pager, saved views and the export buttons.
 */
export function DataGrid({ entity, title, columns, fetcher, initialState, onRowOpen, toolbar, headerExtra, baseFilters, onExport, exportEndpoint, savedViews, debounceMs }: DataGridProps) {
  const t = useTranslations();
  const fetchPage = useMemo(() => fetcher ?? gridFetcher(entity), [fetcher, entity]);
  const grid = useGrid({ columns, fetcher: fetchPage, initialView: initialState, baseFilters, debounceMs });
  const { view, data } = grid;
  const exporter = useGridExport({ entity, title, endpoint: exportEndpoint });
  const shown = shownColumns(columns, view);
  const rows = data.page?.rows ?? NO_ROWS;
  const total = data.page?.total ?? 0;
  // Nothing has come back yet: the count would read "0 registros" and the body would be empty.
  const firstLoad = data.loading && !data.page;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowsSeen, setRowsSeen] = useState(rows);
  if (rowsSeen !== rows) {
    // A new page of rows starts with nothing selected.
    setRowsSeen(rows);
    setSelected(new Set());
  }
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleRow = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const filterFields = columns.filter((c) => c.mode !== "hidden");
  const hiddenCount = columns.filter((c) => c.mode === "hidden" && !c.filterOnly).length;
  const maskedCount = shown.filter((c) => c.mode === "masked").length;
  const dirty = view.sort.length > 0 || Object.keys(view.columnFilters).length > 0 || view.conditions.length > 0;

  const preview = (conditions: Condition[]) =>
    fetchPage({
      filters: stateFilters(columns, { columnFilters: {}, conditions }, baseFilters),
      sort: view.sort,
      page: 1,
      pageSize: 50,
      columns: [...new Set(["id", ...shown.map((c) => (c.field.startsWith("extra.") ? "extra" : c.field))])],
    });

  const exportState = (): GridStateInput => ({ ...grid.state, aggregates: undefined, page: 1, columns: shown.map((c) => c.field) });

  const sums = moneyColumns(shown)
    .map((column) => ({ column, sum: data.page?.aggregates?.[`sum:${column.field}`] }))
    .filter((s) => s.sum !== undefined);
  const errorText =
    data.error === null
      ? null
      : t.has(`grid.query_errors.${data.error}`)
        ? t(`grid.query_errors.${data.error}`)
        : t.has(`errors.${data.error}`)
          ? t(`errors.${data.error}`)
          : t("grid.load_failed");

  return (
    <section className="erp-grid" aria-label={title} aria-busy={data.loading}>
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
        <ColumnChooser columns={columns} shown={view.columns} onChange={grid.setColumns} onReset={() => grid.setColumns(initialView(columns).columns)} />
        {savedViews && (
          <SavedViewsMenu
            views={savedViews.views}
            current={() => savedStateOf(columns, view)}
            onSave={savedViews.onSave}
            onDelete={savedViews.onDelete}
            onApply={(v) => grid.apply(viewFromSaved(columns, v.state))}
          />
        )}
        <button type="button" className={view.conditions.length > 0 ? "erp-btn erp-btn--primary" : "erp-btn"} onClick={() => setAdvancedOpen(true)}>
          <Search aria-hidden="true" className="erp-icon" />
          {view.conditions.length > 0 ? t("grid.advanced_count", { count: view.conditions.length }) : t("grid.advanced_filter")}
        </button>
        <ExportButtons onExport={(format) => (onExport ? onExport(format, exportState()) : void exporter.run(format, exportState()))} busy={exporter.busy} />
        <ExportStatusText status={exporter.status} />
        {dirty && (
          <button type="button" className="erp-btn erp-btn--ghost" onClick={grid.clear}>
            {t("grid.clear_filters")}
          </button>
        )}
      </div>
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
      <div className="erp-grid__body">
        <table>
          <thead>
            <tr>
              <th className="erp-grid__check">
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
                return (
                  <th
                    key={column.field}
                    className={isNumeric(column) ? "text-right" : undefined}
                    aria-sort={sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {canSort ? (
                      <button type="button" className="erp-grid__sort" aria-label={t("grid.sort_by", { label: column.label })} onClick={(e) => grid.sortBy(column.field, e.shiftKey)}>
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
            <FilterRow columns={shown} values={view.columnFilters} onChange={grid.setColumnFilter} selectable />
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={selected.has(row.id) ? "erp-row-link is-selected" : "erp-row-link"}
                tabIndex={onRowOpen ? 0 : undefined}
                onClick={() => onRowOpen?.(row)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) onRowOpen?.(row);
                }}
              >
                <td className="erp-grid__check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={t("grid.select_row")} checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
                </td>
                {shown.map((column) => (
                  <GridCell key={column.field} column={column} row={row} />
                ))}
              </tr>
            ))}
            {firstLoad &&
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <tr key={`skeleton-${i}`} className="erp-grid__skeleton" aria-hidden="true">
                  <td className="erp-grid__check" />
                  {shown.map((column) => (
                    <td key={column.field}>
                      <span />
                    </td>
                  ))}
                </tr>
              ))}
            {!data.loading && rows.length === 0 && (
              <tr>
                <td colSpan={shown.length + 1} className="erp-muted erp-grid__empty">
                  {dirty ? t("grid.empty_filtered") : t("grid.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <GridFooter
        page={view.page}
        pageSize={view.pageSize}
        total={total}
        loading={firstLoad}
        onPage={grid.setPage}
        onPageSize={grid.setPageSize}
        sums={sums}
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
