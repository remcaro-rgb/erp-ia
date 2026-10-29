"use client";

import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
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
  return (column: GridColumn, value: unknown): string => formatCellValue(column, value, { yes: t("common.yes"), no: t("common.no"), timeZone });
}

const NUMERIC = new Set(["money", "number", "custom:number"]);
export const isNumeric = (column: GridColumn) => NUMERIC.has(column.type);

/** One cell of the grid (prototype `cell`): masked values as ••••••, money as $ 1.234.567,00 right-aligned, pills. */
export function GridCell({ column, row, className }: { column: GridColumn; row: GridRow; className?: string }) {
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
  const value = cellValue(row, column.field);
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
  return <td className={base}>{tone ? <Pill tone={tone}>{shown}</Pill> : shown}</td>;
}
