"use client";

import { useTranslations } from "next-intl";
import { formatMoney } from "../money/format";
import { useValueText } from "./GridCell";
import type { Condition, GridColumn } from "./types";

export interface ConditionChipsProps {
  conditions: readonly Condition[];
  fields: readonly GridColumn[];
  onRemove: (index: number) => void;
}

/** The applied advanced conditions as removable chips with Y / O between them (prototype `condChips`). */
export function ConditionChips({ conditions, fields, onRemove }: ConditionChipsProps) {
  const t = useTranslations();
  const valueText = useValueText();
  const text = (field: GridColumn | undefined, value: unknown) => {
    if (!field) return String(value ?? "");
    if (field.type === "money" && typeof value === "number") return formatMoney(value);
    return valueText(field, value);
  };
  return (
    <ul className="erp-chips" aria-label={t("grid.adv.conditions_active")}>
      {conditions.map((c, i) => {
        const field = fields.find((f) => f.field === c.field);
        const op = t(`grid.ops.${field?.kind ?? "text"}.${c.op}`);
        const noValue = c.op === "is_null" || c.op === "not_null";
        return (
          <li key={`${i}-${c.field}`} className="erp-chips__item">
            {i > 0 && <span className="erp-chips__join">{c.join === "or" ? t("grid.rule_or") : t("grid.rule_and")}</span>}
            <span className="erp-chip">
              <b>{field?.label ?? c.field}</b> {op}
              {!noValue && ` ${text(field, c.value)}`}
              {c.op === "between" && ` ${t("grid.between_and")} ${text(field, c.value2)}`}
              <button type="button" aria-label={t("grid.remove_condition")} onClick={() => onRemove(i)}>
                ✕
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
