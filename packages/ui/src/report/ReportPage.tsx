"use client";

import { useMemo, useState } from "react";
import { DataGrid } from "../grid/DataGrid";
import { useCellTimeZone } from "../grid/cell-format";
import type { SavedGridState, SavedViewItem } from "../grid/saved-views";
import type { GridFetcher, GridRow } from "../grid/types";
import { ParamBar } from "./ParamBar";
import { reportFetcher as defaultFetcher, todayIn, visibleParams, type ReportDefClient, type ReportParams } from "./report-model";

export interface ReportLink {
  entity: string;
  id: string;
}

export interface ReportPageProps {
  report: ReportDefClient;
  initialParams?: ReportParams;
  /** A row opened (Enter / double click), or a cell with `link` clicked: then `link` names the record of the other entity (rule 21). */
  onRowOpen?: (row: GridRow, link?: ReportLink) => void;
  /** The parameters changed: the route keeps them in the URL (`?p=`). */
  onParamsChange?: (params: ReportParams) => void;
  /** The caller's saved parameter sets of the report (entity `report:<id>`). */
  savedViews?: { views: readonly SavedViewItem[]; onSave: (name: string, isDefault: boolean, state: SavedGridState) => Promise<void>; onDelete?: (id: string) => Promise<void> };
  /** The fetcher for a set of parameters; POST /api/report/<id> by default. */
  reportFetcher?: (params: ReportParams) => GridFetcher;
  /** Today as `YYYY-MM-DD`; the company's today by default. */
  today?: string;
  debounceMs?: number;
}

/**
 * A report page (design §9, accounting design §8): the parameter bar the report's schema generates over the universal
 * grid. The parameters travel with every grid state to POST /api/report/<id>, the footer totals only the columns in
 * `totals`, the export buttons export the report with these parameters and Guardar vista keeps them with the view.
 */
export function ReportPage({ report, initialParams = {}, onRowOpen, onParamsChange, savedViews, reportFetcher, today, debounceMs }: ReportPageProps) {
  const timeZone = useCellTimeZone();
  const [params, setParams] = useState<ReportParams>(initialParams);
  const change = (next: ReportParams) => {
    setParams(next);
    onParamsChange?.(next);
  };

  // A new parameter set is a new report: the grid starts over from page 1 on it.
  const paramsKey = JSON.stringify(params);
  const fetcher = useMemo(() => {
    const read = (reportFetcher ?? ((p: ReportParams) => defaultFetcher(report.id, p)))(JSON.parse(paramsKey) as ReportParams);
    // Only the columns in `totals` are totalled in the footer.
    return (async (state, signal) => {
      const page = await read(state, signal);
      if (!page.aggregates) return page;
      const kept = Object.fromEntries(Object.entries(page.aggregates).filter(([key]) => report.totals.includes(key.replace(/^sum:/, ""))));
      return { ...page, aggregates: kept };
    }) satisfies GridFetcher;
  }, [reportFetcher, paramsKey, report.id, report.totals]);

  const open = (row: GridRow) => onRowOpen?.(row);
  const linked = (column: { field: string }, row: GridRow): ReportLink | null => {
    const link = report.links[column.field];
    const id = link && row[link.idField];
    return link && typeof id === "string" ? { entity: link.entity, id } : null;
  };

  return (
    <div className="erp-report">
      <ParamBar specs={visibleParams(report)} value={params} onChange={change} today={today ?? todayIn(timeZone ?? "America/Bogota")} period={report.period} />
      <DataGrid
        key={paramsKey}
        entity={report.id}
        title={report.label}
        columns={report.columns}
        fetcher={fetcher}
        onRowOpen={open}
        debounceMs={debounceMs}
        exportSource={{ kind: "report", id: report.id, params }}
        renderCell={(column, row) => {
          const link = onRowOpen ? linked(column, row) : null;
          const text = row[column.field];
          if (!link || column.mode === "masked" || text === null || text === undefined || text === "") return undefined;
          return (
            <button type="button" className="erp-link" onClick={(event) => (event.stopPropagation(), onRowOpen?.(row, link))}>
              {String(text)}
            </button>
          );
        }}
        savedViews={
          savedViews && {
            ...savedViews,
            onSave: (name, isDefault, state) => savedViews.onSave(name, isDefault, { ...state, params }),
          }
        }
        onViewApplied={(view) => {
          const saved = view.state.params;
          if (saved) change(Object.fromEntries(Object.entries(saved).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))) as ReportParams);
        }}
      />
    </div>
  );
}
