"use client";

import { useTranslations } from "next-intl";
import { AGGREGATE_FNS } from "@erp/kernel/query";
import { MAX_GROUP_LEVELS, type AggregateFn, type GridColumn } from "./types";

export interface GroupControlsProps {
  /** The columns Agrupar por offers (`groupableColumns`). */
  columns: readonly GridColumn[];
  groupBy: readonly string[];
  aggregateFns: readonly AggregateFn[];
  onGroupBy: (fields: string[]) => void;
  onAggregateFns: (fns: AggregateFn[]) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}

/**
 * Agrupar por and Agregados (accounting design §5.14): a chip per group field in order (`1. Cuenta ×`), a select to add
 * one (up to three), the functions of the subtotals as toggles (Σ Suma · ⌀ Promedio · Mín · Máx · # Conteo) and
 * Contraer todo / Expandir todo.
 */
export function GroupControls({ columns, groupBy, aggregateFns, onGroupBy, onAggregateFns, onCollapseAll, onExpandAll }: GroupControlsProps) {
  const t = useTranslations();
  const label = (field: string) => columns.find((c) => c.field === field)?.label ?? field;
  const available = columns.filter((c) => !groupBy.includes(c.field));
  const toggle = (fn: AggregateFn) => {
    const next = aggregateFns.includes(fn) ? aggregateFns.filter((f) => f !== fn) : AGGREGATE_FNS.filter((f) => f === fn || aggregateFns.includes(f));
    // At least one function stays: the footer's totals and the subtotals need it.
    if (next.length > 0) onAggregateFns(next);
  };
  return (
    <div className="erp-grid__groupbar" role="group" aria-label={t("grid.group.controls")}>
      <ol className="erp-chips" aria-label={t("grid.group.group_by")}>
        {groupBy.map((field, i) => (
          <li key={field} className="erp-chips__item">
            <span className="erp-chip">
              <b>{t("grid.group.chip", { level: i + 1, label: label(field) })}</b>
              <button type="button" aria-label={t("grid.group.remove", { label: label(field) })} onClick={() => onGroupBy(groupBy.filter((f) => f !== field))}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
      {groupBy.length < MAX_GROUP_LEVELS && (
        <select aria-label={t("grid.group.add_field_label")} value="" onChange={(e) => e.target.value && onGroupBy([...groupBy, e.target.value])}>
          <option value="">{t("grid.group.add_field")}</option>
          {available.map((c) => (
            <option key={c.field} value={c.field}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <span className="erp-grid__fns" role="group" aria-label={t("grid.group.functions")}>
        {AGGREGATE_FNS.map((fn) => (
          <button key={fn} type="button" className="erp-btn erp-btn--ghost" aria-pressed={aggregateFns.includes(fn)} onClick={() => toggle(fn)}>
            {t(`grid.group.fn.${fn}`)}
          </button>
        ))}
      </span>
      {groupBy.length > 0 && (
        <span className="erp-grid__fns">
          <button type="button" className="erp-btn erp-btn--ghost" onClick={onCollapseAll}>
            {t("grid.group.collapse_all")}
          </button>
          <button type="button" className="erp-btn erp-btn--ghost" onClick={onExpandAll}>
            {t("grid.group.expand_all")}
          </button>
        </span>
      )}
    </div>
  );
}
