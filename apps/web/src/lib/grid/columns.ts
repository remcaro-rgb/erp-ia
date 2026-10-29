import { customFilterKind, filterKind } from "@erp/kernel/query";
import type { EntityDef, GridAccess } from "@erp/kernel";
import type { GridColumn } from "@erp/ui";
import type { GridPresentation } from "./presentation";

// The columns a grid page hands the DataGrid (design §9, rule 14): every registry field of the entity with the
// caller's mode (hidden ones stay out of sight; masked ones show •••••• and never filter or sort), labels translated,
// value labels from the catalogue or the pack's tables, then the admin-defined fields the caller's roles may view.
// The identity column the grid pins first is the presentation's `title`, else the entity's display field.

export type Translate = (key: string) => string;
export type CodeTables = Record<string, readonly { value: string; label: string }[]>;

export function buildColumns(entity: EntityDef, access: GridAccess, presentation: GridPresentation, t: Translate, tables: CodeTables = {}): GridColumn[] {
  const fields = entity.fields.filter((f) => !presentation.exclude.includes(f.name));
  const shown = presentation.shown.filter((name) => fields.some((f) => f.name === name));
  const ordered = [...shown.map((name) => fields.find((f) => f.name === name)!), ...fields.filter((f) => !shown.includes(f.name))];
  const columns: GridColumn[] = ordered.map((f) => {
    const p = presentation.fields[f.name] ?? {};
    const options = p.table
      ? tables[p.table]
      : p.valuesKey
        ? (f.type === "boolean" ? ["true", "false"] : (f.enumValues ?? [])).map((value) => ({ value, label: t(`${p.valuesKey}.${value}`) }))
        : undefined;
    return {
      field: f.name,
      label: t(f.label),
      type: f.type,
      kind: filterKind(f.type),
      mode: access.modes[f.name] ?? "visible",
      filterable: f.filterable ?? true,
      sortable: f.sortable ?? true,
      ...(options ? { options: [...options] } : {}),
      ...(p.pills ? { pills: p.pills } : {}),
      ...(p.display ? { display: p.display } : {}),
      ...(shown.length > 0 && !shown.includes(f.name) ? { hiddenByDefault: true } : {}),
      // The grid's identity column: first, pinned and never moved (OD-4).
      ...(f.name === (presentation.title ?? entity.displayField) ? { identity: true } : {}),
    };
  });
  // Admin-defined data (design §5.14): offered when the `extra` column and the field's roles_view let the caller see it.
  const extraVisible = access.modes.extra === undefined || access.modes.extra === "visible";
  for (const extra of access.extras) {
    columns.push({
      field: `extra.${extra.key}`,
      label: extra.label,
      type: `custom:${extra.type}`,
      kind: customFilterKind(extra.type),
      mode: extraVisible && extra.viewable ? "visible" : "hidden",
      filterable: true,
      sortable: true,
      hiddenByDefault: true,
      ...(extra.type === "list" && extra.options ? { options: extra.options.map((o) => ({ value: o, label: o })) } : {}),
      ...(extra.type === "bool" ? { options: [{ value: "true", label: t("common.yes") }, { value: "false", label: t("common.no") }] } : {}),
    });
  }
  return columns;
}
