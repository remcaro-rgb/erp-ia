"use client";

import { useTranslations } from "next-intl";
import { formatCellValue, isEmptyCell, useCellTimeZone } from "../grid/cell-format";
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
  /** Time zone dates and times are shown in; the shell's (the company's) when absent. */
  timeZone?: string;
  /** `fetch` and the download of the export, injected by tests. */
  fetcher?: typeof fetch;
  download?: (result: ExportResult) => void;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * The columns of the rows, in the order the server returned them (never `id`). With the host's metadata only the fields
 * it offers are columns (a hidden field, an internal one such as `extra`, has none) and it labels, types and marks them;
 * without it every key is a column, typed by its value.
 */
function columnsOf(rows: Record<string, unknown>[], given?: ResultColumn[]): ResultColumn[] {
  const known = given && given.length > 0 ? new Map(given.map((column) => [column.field, column])) : null;
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => key !== "id");
  return keys.flatMap((field): ResultColumn[] => {
    if (known) {
      const meta = known.get(field);
      return meta && meta.mode !== "hidden" ? [{ ...meta, label: meta.label ?? field.replaceAll("_", " ") }] : [];
    }
    const sample = rows.map((row) => row[field]).find((v) => v !== null && v !== undefined);
    const type = typeof sample === "boolean" ? "boolean" : typeof sample === "string" && ISO_DATETIME.test(sample) ? "datetime" : "text";
    return [{ field, label: field.replaceAll("_", " "), type }];
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

  const companyZone = useCellTimeZone();
  const zone = timeZone ?? companyZone;
  const text = (column: ResultColumn, value: unknown) => formatCellValue({ type: column.type ?? "text" }, value, { yes: t("common.yes"), no: t("common.no"), timeZone: zone });

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
                    // As the grid's cell: a masked field is ••••••, nothing (or a zero amount) is a dash.
                    if (column.mode === "masked") {
                      return (
                        <td key={column.field} className={`${numeric ? "erp-num text-right " : ""}erp-masked`}>
                          <span title={t("grid.masked_value")}>••••••</span>
                        </td>
                      );
                    }
                    return (
                      <td key={column.field} className={numeric ? "erp-num text-right" : undefined}>
                        {isEmptyCell({ type: column.type ?? "text" }, value) ? <span className="erp-muted">—</span> : text(column, value)}
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
