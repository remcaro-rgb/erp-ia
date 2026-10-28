"use client";

import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { formatMoney } from "../money/format";
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

const DATE_TIME = new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short" });

/** The text of one value of a column: option labels, Sí / No, dates and lists. */
export function useValueText() {
  const t = useTranslations();
  return (column: GridColumn, value: unknown): string => {
    if (value === null || value === undefined || value === "") return "";
    const label = (v: unknown) => column.options?.find((o) => o.value === String(v))?.label ?? String(v);
    if (Array.isArray(value)) return value.map(label).join(", ");
    if (typeof value === "boolean") return column.options ? label(value) : t(value ? "common.yes" : "common.no");
    if (column.type === "money") return formatMoney(value as number | string);
    if (column.type === "datetime" && (typeof value === "string" || value instanceof Date)) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : DATE_TIME.format(date);
    }
    if (typeof value === "object") return JSON.stringify(value);
    return label(value);
  };
}

const NUMERIC = new Set(["money", "number", "custom:number"]);
export const isNumeric = (column: GridColumn) => NUMERIC.has(column.type);

/** One cell of the grid (prototype `cell`): masked values as ••••••, money as $ 1.234.567,00 right-aligned, pills. */
export function GridCell({ column, row }: { column: GridColumn; row: GridRow }) {
  const t = useTranslations();
  const text = useValueText();
  const numeric = isNumeric(column);
  const base = cn(numeric && "erp-num text-right", column.display === "mono" && "erp-mono");
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
    return <td>{pill ? <Pill tone={pill.tone}>{t(`grid.dian.${pill.key}`, { count: pill.count })}</Pill> : <span className="erp-muted">—</span>}</td>;
  }
  const shown = text(column, value);
  const zeroMoney = column.type === "money" && Number(value) === 0;
  if (shown === "" || zeroMoney) {
    return (
      <td className={base}>
        <span className="erp-muted">—</span>
      </td>
    );
  }
  const tone = column.pills?.[String(value)];
  return <td className={base}>{tone ? <Pill tone={tone}>{shown}</Pill> : shown}</td>;
}
