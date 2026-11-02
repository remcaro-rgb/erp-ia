"use client";

import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { selectFilter } from "./grid-model";
import type { ColumnFilterValue, GridColumn } from "./types";

export interface FilterRowProps {
  columns: readonly GridColumn[];
  values: Readonly<Record<string, ColumnFilterValue>>;
  onChange: (field: string, value: ColumnFilterValue | undefined, debounce: boolean) => void;
  /** The grid has a selection column first. */
  selectable?: boolean;
  /** The pinned identity column (OD-4): its filter stays in place while the grid scrolls sideways. */
  pinned?: string;
}

/** The options a filter select offers: the column's own, or Sí / No for a boolean. */
function useOptions() {
  const t = useTranslations();
  return (column: GridColumn) => column.options ?? (column.type === "boolean" ? [{ value: "true", label: t("common.yes") }, { value: "false", label: t("common.no") }] : null);
}

/**
 * The filter row under the header (design §9, prototype `tr.f`): text contains, a number comparison or range
 * (`>= 1000`, `1000..5000`; a bare number means "at least"), a date range, a select for enums and booleans. Masked columns show a disabled box;
 * active filters are tinted.
 */
export function FilterRow({ columns, values, onChange, selectable, pinned }: FilterRowProps) {
  const t = useTranslations();
  const optionsOf = useOptions();
  return (
    <tr className="erp-grid__filters" aria-label={t("grid.filter_row")}>
      {selectable && <th className={cn("erp-grid__check is-pinned", pinned === undefined && "is-pinned-edge")} />}
      {columns.map((column) => {
        const th = column.field === pinned ? "erp-grid__id is-pinned is-pinned-edge" : undefined;
        const label = t("grid.filter_label", { label: column.label });
        const value = values[column.field];
        const on = value !== undefined && value !== "" ? "is-on" : undefined;
        if (column.mode === "masked") {
          return (
            <th key={column.field} className={th}>
              <input disabled aria-label={t("grid.filter_unavailable")} placeholder={t("grid.filter_masked")} />
            </th>
          );
        }
        if (!column.filterable) return <th key={column.field} className={th} />;
        const options = optionsOf(column);
        if (options && (column.kind === "enum" || column.kind === "uuid" || selectFilter(column))) {
          return (
            <th key={column.field} className={th}>
              <select aria-label={label} className={on} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(column.field, e.target.value || undefined, false)}>
                <option value="">{t("grid.filter_all")}</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </th>
          );
        }
        if (column.kind === "date") {
          const range = typeof value === "object" ? value : { from: "", to: "" };
          const set = (part: "from" | "to", text: string) => {
            const next = { ...range, [part]: text };
            onChange(column.field, next.from || next.to ? next : undefined, false);
          };
          return (
            <th key={column.field} className={th}>
              <span className="erp-grid__range" role="group" aria-label={label}>
                <input type="date" aria-label={`${label} · ${t("grid.date_from")}`} className={on} value={range.from} onChange={(e) => set("from", e.target.value)} />
                <input type="date" aria-label={`${label} · ${t("grid.date_to")}`} className={on} value={range.to} onChange={(e) => set("to", e.target.value)} />
              </span>
            </th>
          );
        }
        if (column.kind === "number" || column.kind === "text" || column.kind === "json") {
          const numeric = column.kind === "number";
          return (
            <th key={column.field} className={th}>
              <input
                aria-label={label}
                className={on}
                inputMode={numeric ? "decimal" : undefined}
                placeholder={numeric ? t("grid.filter_number") : t("grid.filter_text")}
                title={numeric ? t("grid.filter_number_help") : undefined}
                style={numeric ? { textAlign: "right" } : undefined}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(column.field, e.target.value, true)}
              />
            </th>
          );
        }
        return <th key={column.field} className={th} />;
      })}
    </tr>
  );
}
