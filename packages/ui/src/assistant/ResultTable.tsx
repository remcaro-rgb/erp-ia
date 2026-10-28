"use client";

import { useTranslations } from "next-intl";
import { formatMoney } from "../money/format";
import { browserDownload, useGridExport } from "../grid/use-grid-export";
import type { ExportResult } from "../grid/export-client";
import type { GridStateInput } from "../grid/types";
import type { ResultColumn } from "./model";

export interface ResultTableProps {
  entity: string;
  rows: Record<string, unknown>[];
  /** Labels and types of the entity's fields when the host knows them; otherwise the keys of the rows. */
  columns?: ResultColumn[];
  /** Rows the query matched in all. */
  total?: number;
  /** The result was cut at 50 rows. */
  truncated?: boolean;
  /** The query as a grid state: what "Abrir como grid" opens and "Excel" exports. */
  state: GridStateInput;
  /** Opens the entity's grid in a tab with the state; absent when the entity has no grid screen. */
  onOpenGrid?: (entity: string, state: GridStateInput) => void;
  /** Time zone dates and times are shown in (the company's). */
  timeZone?: string;
  /** `fetch` and the download of the export, injected by tests. */
  fetcher?: typeof fetch;
  download?: (result: ExportResult) => void;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The columns of the rows in the order the server returned them (never `id`), labelled and typed by the host's metadata when it has any. */
function columnsOf(rows: Record<string, unknown>[], given?: ResultColumn[]): ResultColumn[] {
  const known = new Map((given ?? []).map((column) => [column.field, column]));
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => key !== "id");
  return keys.map((field) => {
    const meta = known.get(field);
    if (meta) return { ...meta, label: meta.label ?? field.replaceAll("_", " ") };
    const sample = rows.map((row) => row[field]).find((v) => v !== null && v !== undefined);
    const type = typeof sample === "boolean" ? "boolean" : typeof sample === "string" && ISO_DATETIME.test(sample) ? "datetime" : "text";
    return { field, label: field.replaceAll("_", " "), type };
  });
}

/**
 * A `kernel.data.query` result in the chat (design §7.1, rules 14 and 17): the rows (already masked by the server) with
 * the grid's cell formatting, the cut at 50 rows said, and the three ways out: open it as a grid, export it to Excel and
 * save it as a report (plan 5).
 */
export function ResultTable({ entity, rows, columns, total, truncated, state, onOpenGrid, timeZone, fetcher, download = browserDownload }: ResultTableProps) {
  const t = useTranslations();
  const cols = columnsOf(rows, columns);
  const exporter = useGridExport({ entity, download, ...(fetcher ? { fetcher } : {}) });

  const dateTime = new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  const dateOnly = new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeZone: "UTC" });
  const text = (column: ResultColumn, value: unknown): string => {
    if (typeof value === "boolean") return t(value ? "common.yes" : "common.no");
    if (column.type === "money") return formatMoney(value as number | string);
    if ((column.type === "datetime" || column.type === "date") && typeof value === "string") {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return column.type === "date" || !ISO_DATETIME.test(value) ? dateOnly.format(date) : dateTime.format(date);
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };

  const failure = exporter.status.phase === "failed" ? exporter.status.code : null;
  return (
    <div className="erp-result">
      {rows.length === 0 ? (
        <div className="erp-small erp-muted">{t("agent.ui.result.empty")}</div>
      ) : (
        <div className="erp-result__scroll">
          <table>
            <thead>
              <tr>
                {cols.map((column) => (
                  <th key={column.field} className={column.type === "money" || column.type === "number" ? "erp-num" : undefined}>
                    {column.label ?? column.field}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={typeof row.id === "string" ? row.id : i}>
                  {cols.map((column) => {
                    const value = row[column.field];
                    const numeric = column.type === "money" || column.type === "number";
                    const empty = value === null || value === undefined || value === "";
                    return (
                      <td key={column.field} className={numeric ? "erp-num text-right" : undefined}>
                        {empty ? <span className="erp-muted">—</span> : text(column, value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="erp-small erp-muted">
        {total !== undefined && rows.length > 0 && <span>{t("agent.ui.result.count", { shown: rows.length, total })}</span>}
        {truncated && <span>{`${total !== undefined && rows.length > 0 ? " · " : ""}${t("agent.ui.result.truncated")}`}</span>}
      </div>
      <div className="erp-result__actions">
        {onOpenGrid && (
          <button type="button" className="erp-btn erp-btn--sm" onClick={() => onOpenGrid(entity, state)}>
            {t("agent.ui.result.open_grid")}
          </button>
        )}
        <button type="button" className="erp-btn erp-btn--sm" disabled={exporter.busy || rows.length === 0} onClick={() => void exporter.run("xlsx", state)}>
          {exporter.busy ? t("agent.ui.result.exporting") : t("agent.ui.result.excel")}
        </button>
        <button type="button" className="erp-btn erp-btn--sm" disabled title={t("agent.ui.result.phase5")}>
          {t("agent.ui.result.save_report")}
        </button>
      </div>
      {failure && (
        <span role="alert" className="erp-field__error">
          {t.has(`errors.${failure}`) ? t(`errors.${failure}`) : t("errors.export_failed")}
        </span>
      )}
    </div>
  );
}
