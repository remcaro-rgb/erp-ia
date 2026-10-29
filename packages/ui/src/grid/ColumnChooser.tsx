"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { usePopover } from "./use-popover";
import type { GridColumn } from "./types";

export interface ColumnChooserProps {
  columns: readonly GridColumn[];
  /** Every offered field in the user's order, shown or not (`GridView.order`); the declared order when absent. */
  order?: readonly string[];
  /** Fields shown, in order. */
  shown: readonly string[];
  /** A column switched on or off (it keeps its place in the order). */
  onToggle: (field: string, on: boolean) => void;
  /** ↑ (-1) / ↓ (+1): one place in the order. */
  onMove: (field: string, delta: -1 | 1) => void;
  onReset: () => void;
}

/**
 * Which columns the grid shows and in what order (design §19a, §22.12): every column the role may see, in the grid's
 * order, with its visibility box and ↑ / ↓ to move it; hidden fields are never offered. The identity column stays
 * first (OD-4): it has no arrows and nothing goes above it.
 */
export function ColumnChooser({ columns, order, shown, onToggle, onMove, onReset }: ColumnChooserProps) {
  const t = useTranslations();
  const { open, setOpen, ref } = usePopover();
  const offered = columns.filter((c) => c.mode !== "hidden" && !c.filterOnly);
  const byField = new Map(offered.map((c) => [c.field, c]));
  const listed = order ? [...order.map((f) => byField.get(f)).filter((c): c is GridColumn => c !== undefined), ...offered.filter((c) => !order.includes(c.field))] : offered;
  const pinned = listed[0]?.identity ? listed[0].field : undefined;
  // The row of a moved column is re-laid by React: the caret goes back to the arrow that was pressed.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (!refocus.current) return;
    const button = ref.current?.querySelector<HTMLButtonElement>(`[data-move="${CSS.escape(refocus.current)}"]`);
    refocus.current = null;
    if (button && !button.disabled) button.focus();
  });
  const move = (field: string, delta: -1 | 1) => {
    refocus.current = `${field}:${delta}`;
    onMove(field, delta);
  };
  return (
    <div className="erp-pop" ref={ref}>
      <button type="button" className="erp-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Columns3 aria-hidden="true" className="erp-icon" />
        {t("grid.columns")}
      </button>
      {open && (
        <div className="erp-pop__panel erp-pop__panel--wide" role="group" aria-label={t("grid.columns")}>
          <div className="erp-pop__head">{t("grid.columns_shown", { shown: shown.length, total: offered.length })}</div>
          <ul className="erp-pop__list erp-columns">
            {listed.map((c, i) => {
              const fixed = c.field === pinned;
              const first = i === 0 || (i === 1 && pinned !== undefined);
              return (
                <li key={c.field} className="erp-columns__item">
                  <label className="erp-pop__check">
                    <input type="checkbox" checked={shown.includes(c.field)} onChange={(e) => onToggle(c.field, e.target.checked)} />
                    {c.label}
                  </label>
                  {fixed ? (
                    <span className="erp-hint">{t("grid.columns_pinned")}</span>
                  ) : (
                    <span className="erp-columns__moves">
                      <button
                        type="button"
                        className="erp-btn erp-btn--ghost erp-columns__move"
                        aria-label={t("grid.column_up", { label: c.label })}
                        data-move={`${c.field}:-1`}
                        disabled={first}
                        onClick={() => move(c.field, -1)}
                      >
                        <ArrowUp aria-hidden="true" className="erp-icon" />
                      </button>
                      <button
                        type="button"
                        className="erp-btn erp-btn--ghost erp-columns__move"
                        aria-label={t("grid.column_down", { label: c.label })}
                        data-move={`${c.field}:1`}
                        disabled={i === listed.length - 1}
                        onClick={() => move(c.field, 1)}
                      >
                        <ArrowDown aria-hidden="true" className="erp-icon" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" onClick={onReset}>
            {t("grid.columns_reset")}
          </button>
        </div>
      )}
    </div>
  );
}
