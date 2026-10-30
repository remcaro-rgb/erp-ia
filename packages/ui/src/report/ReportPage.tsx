"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { DataGrid } from "../grid/DataGrid";
import { useCellTimeZone } from "../grid/cell-format";
import type { SavedGridState, SavedViewItem } from "../grid/saved-views";
import type { GridFetcher, GridRow } from "../grid/types";
import { ParamBar } from "./ParamBar";
import { reportFetcher as defaultFetcher, todayIn, visibleParams, type ReportDefClient, type ReportParams } from "./report-model";

/** A cell value that is a catalogue key: `report.net_result`, or `accounting.statement.revenue` (the section of a statement, kept under `report.statement`). */
const CATALOGUE_KEY = /^(report|accounting\.statement)\.[a-z0-9_.]+$/;
const key = (text: string) => text.replace(/^accounting\.statement\./, "report.statement.");

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
  const t = useTranslations();
  const [params, setParams] = useState<ReportParams>(initialParams);
  const change = (next: ReportParams) => {
    setParams(next);
    onParamsChange?.(next);
  };

  // A new parameter set is a new report: the grid starts over from page 1 on it.
  const paramsKey = JSON.stringify(params);
  const fetcher = useMemo(() => {
    const read = (reportFetcher ?? ((p: ReportParams) => defaultFetcher(report.id, p)))(JSON.parse(paramsKey) as ReportParams);
    // A report row is not a record: the grid keys, selects and links rows by `id`, so a row without one gets its place in the report.
    // Only the columns in `totals` are totalled in the footer, which reads them as `sum:<column>` (a report names them by column).
    return (async (state, signal) => {
      const page = await read(state, signal);
      const start = ((state.page ?? 1) - 1) * (state.pageSize ?? page.rows.length);
      const rows = page.rows.map((row, index) => (row.id === undefined || row.id === null ? { ...row, id: `row-${start + index}` } : row));
      if (!page.aggregates) return { ...page, rows };
      const kept = Object.fromEntries(
        Object.entries(page.aggregates).flatMap(([key, value]) => {
          const field = key.replace(/^sum:/, "");
          return report.totals.includes(field) ? [[`sum:${field}`, value] as const] : [];
        }),
      );
      return { ...page, rows, aggregates: kept };
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
          // A report names its own rows with catalogue keys (`report.net_result`, a statement section): the page says them in the user's language.
          const phrase = typeof text === "string" && CATALOGUE_KEY.test(text) ? key(text) : null;
          if (phrase && t.has(phrase as never)) return t(phrase as never);
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
