"use client";

import { useTranslations } from "next-intl";
import { refLabelKey } from "@erp/kernel/query";
import { cn } from "@erp/ui/lib/utils";
import { RecordLink } from "../record/RecordLink";
import { shortId } from "../record/record-model";
import { formatCellValue, isEmptyCell, useCellTimeZone } from "./cell-format";
import { cellValue, dianPill } from "./grid-model";
import type { GridColumn, GridRow, PillTone } from "./types";

/** A coloured label (prototype `.pill`). */
export function Pill({ tone, children, title }: { tone: PillTone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`erp-pill erp-pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** The text of one value of a column (the formatter the assistant's result tables share): option labels, Sí / No, money, dates in the company's zone and lists. */
export function useValueText() {
  const t = useTranslations();
  const timeZone = useCellTimeZone();
  return (column: GridColumn, value: unknown): string => formatCellValue(column, value, { yes: t("common.yes"), no: t("common.no"), timeZone, json: (count, kind) => t(`grid.json_${kind}`, { count }) });
}

const NUMERIC = new Set(["money", "number", "custom:number"]);
export const isNumeric = (column: GridColumn) => NUMERIC.has(column.type);

/**
 * What a screen shows in a cell instead of the value's text (the audit's process description over its id, an actor's
 * link): its content, or undefined to keep the default. Never called for a masked column.
 */
export type CellRenderer = (column: GridColumn, row: GridRow) => React.ReactNode | undefined;

/** One cell of the grid (prototype `cell`): masked values as ••••••, money as $ 1.234.567,00 right-aligned, pills. */
export function GridCell({ column, row, className, render }: { column: GridColumn; row: GridRow; className?: string; render?: CellRenderer }) {
  const t = useTranslations();
  const text = useValueText();
  const numeric = isNumeric(column);
  const base = cn(numeric && "erp-num text-right", column.display === "mono" && "erp-mono", className);
  if (column.mode === "masked") {
    return (
      <td className={cn(base, "erp-masked")}>
        <span title={t("grid.masked_value")}>••••••</span>
      </td>
    );
  }
  const custom = render?.(column, row);
  if (custom !== undefined) return <td className={base}>{custom}</td>;
  const value = cellValue(row, column.field);
  if (column.ref && typeof value === "string" && value !== "") {
    // A reference names its record (the row's `<field>_label`, else the column's option, else the short id) and links
    // to the record's page when the viewer may open it (rule 21).
    const named = row[refLabelKey(column.field)];
    const label = typeof named === "string" && named !== "" ? named : column.options?.some((o) => o.value === value) ? text(column, value) : null;
    const shown = label ?? shortId(value);
    return (
      <td className={base}>
        {column.linkable ? (
          <RecordLink entity={column.ref.entity} id={value} label={shown} mono={label === null} inRow />
        ) : (
          <span className={label === null ? "erp-mono" : undefined} title={label === null ? value : undefined}>
            {shown}
          </span>
        )}
      </td>
    );
  }
  if (column.display === "dian") {
    const pill = dianPill(value);
    return <td className={className}>{pill ? <Pill tone={pill.tone}>{t(`grid.dian.${pill.key}`, { count: pill.count })}</Pill> : <span className="erp-muted">—</span>}</td>;
  }
  const shown = text(column, value);
  if (shown === "" || isEmptyCell(column, value)) {
    return (
      <td className={base}>
        <span className="erp-muted">—</span>
      </td>
    );
  }
  const tone = column.pills?.[String(value)];
  if (column.type === "json" && typeof value === "object") return <td className={base}><span title={JSON.stringify(value)}>{shown}</span></td>;
  return <td className={base}>{tone ? <Pill tone={tone}>{shown}</Pill> : shown}</td>;
}
