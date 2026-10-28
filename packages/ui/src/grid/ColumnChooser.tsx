"use client";

import { useTranslations } from "next-intl";
import { Columns3 } from "lucide-react";
import { usePopover } from "./use-popover";
import type { GridColumn } from "./types";

export interface ColumnChooserProps {
  columns: readonly GridColumn[];
  /** Fields shown, in order. */
  shown: readonly string[];
  onChange: (shown: string[]) => void;
  onReset: () => void;
}

/** Which columns the grid shows (design §19a): every column the role may see; hidden fields are never offered. */
export function ColumnChooser({ columns, shown, onChange, onReset }: ColumnChooserProps) {
  const t = useTranslations();
  const { open, setOpen, ref } = usePopover();
  const offered = columns.filter((c) => c.mode !== "hidden" && !c.filterOnly);
  const toggle = (field: string, on: boolean) => {
    if (on) {
      // Keep the declared order.
      const next = new Set([...shown, field]);
      onChange(offered.map((c) => c.field).filter((f) => next.has(f)));
    } else if (shown.length > 1) onChange(shown.filter((f) => f !== field));
  };
  return (
    <div className="erp-pop" ref={ref}>
      <button type="button" className="erp-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Columns3 aria-hidden="true" className="erp-icon" />
        {t("grid.columns")}
      </button>
      {open && (
        <div className="erp-pop__panel" role="group" aria-label={t("grid.columns")}>
          <div className="erp-pop__head">{t("grid.columns_shown", { shown: shown.length, total: offered.length })}</div>
          {offered.map((c) => (
            <label key={c.field} className="erp-pop__check">
              <input type="checkbox" checked={shown.includes(c.field)} onChange={(e) => toggle(c.field, e.target.checked)} />
              {c.label}
            </label>
          ))}
          <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" onClick={onReset}>
            {t("grid.columns_reset")}
          </button>
        </div>
      )}
    </div>
  );
}
