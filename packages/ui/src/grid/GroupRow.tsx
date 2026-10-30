"use client";

import { useTranslations } from "next-intl";
import { formatMoney } from "../money/format";
import { formatCellValue } from "./cell-format";
import { groupId } from "./grid-model";
import type { AggregateFn, GridColumn, GroupRow as Group } from "./types";

export interface GroupHeaderRowProps {
  group: Group;
  /** The group field of this level. */
  column: GridColumn | undefined;
  /** The shown columns, in order: a group's aggregates sit under their own money columns. */
  shown: readonly GridColumn[];
  fns: readonly AggregateFn[];
  collapsed: boolean;
  checkClass: string;
  timeZone?: string | undefined;
  onToggle: (id: string) => void;
  /** Ver líneas: the group's keys as conditions. */
  onOpen: (group: Group) => void;
}

/**
 * A group row (`erp-grid__group erp-grid__group--l1…`): `▾ <field>: <value> (n)` over the columns before the first
 * aggregated one, then one cell per money column listing the chosen functions (`Σ $ 1.234,00 · ⌀ $ 617,00`).
 */
export function GroupHeaderRow({ group, column, shown, fns, collapsed, checkClass, timeZone, onToggle, onOpen }: GroupHeaderRowProps) {
  const t = useTranslations();
  const field = column?.field ?? Object.keys(group.keys)[group.level - 1] ?? "";
  const raw = group.keys[field];
  const value = raw === null || raw === undefined || raw === "" ? t("grid.group.no_value") : column ? formatCellValue(column, raw, { yes: t("common.yes"), no: t("common.no"), timeZone }) : String(raw);
  const text = t("grid.group.title", { label: column?.label ?? field, value, count: group.count });
  const id = groupId(group);
  const aggregated = shown.map((c) => c.type === "money" && fns.some((fn) => group.aggregates[`${fn}:${c.field}`] !== undefined));
  // The label spans the columns up to the first aggregated one (at least the first), so a long value is not clipped.
  const first = aggregated.indexOf(true);
  const span = Math.max(1, first < 0 ? shown.length : first);
  return (
    <tr className={`erp-grid__group erp-grid__group--l${group.level}`} data-group={id}>
      <td className={checkClass} />
      <td colSpan={span} className="erp-grid__group-label">
        <button type="button" className="erp-grid__group-toggle" aria-expanded={!collapsed} onClick={() => onToggle(id)}>
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> {text}
        </button>
        <button type="button" className="erp-btn erp-btn--ghost erp-grid__group-open" onClick={() => onOpen(group)}>
          {t("grid.group.view_lines")}
        </button>
      </td>
      {shown.slice(span).map((c, i) => (
        <td key={c.field} className={aggregated[span + i] ? "erp-num text-right" : undefined}>
          {aggregated[span + i]
            ? fns
                .filter((fn) => group.aggregates[`${fn}:${c.field}`] !== undefined)
                .map((fn) => `${t(`grid.group.fn_mark.${fn}`)} ${fn === "count" ? String(group.aggregates[`${fn}:${c.field}`]) : formatMoney(group.aggregates[`${fn}:${c.field}`] as number | string) || formatMoney(0)}`)
                .join(" · ")
            : null}
        </td>
      ))}
    </tr>
  );
}
