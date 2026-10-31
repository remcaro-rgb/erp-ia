"use client";

import { useTranslations } from "next-intl";
import { DataGrid, type DataGridProps } from "../grid/DataGrid";
import type { GridRow } from "../grid/types";
import { useTabs } from "../shell/tabs-store";
import { NoAccess } from "./record-tables";

// The Movimientos tab of a Cuenta or an analytic node (accounting design §8): the DataGrid of the ledger lines (`accounting.ledger_line`,
// §4.16) filtered to the record (and its descendants, by the server's filter). A row opens its comprobante. The grid reads through the
// masked view, so a restricted account's lines are not there for who may not view them; a caller who may not view the record at all
// gets "Sin acceso" instead.

export interface MovementsTabProps {
  /** The grid's entity: the ledger lines, or the comprobantes of a period. */
  entity: string;
  title: string;
  columns: DataGridProps["columns"];
  filters: NonNullable<DataGridProps["baseFilters"]>;
  /** False when the caller may not view the record. */
  allowed?: boolean;
  /** Field that holds the comprobante's id on a row (the line's `entry_id`; a comprobante's own `id`). */
  entryField?: string;
  /** Opens on this sort (design §5.14: date, number, line). */
  sort?: { field: string; dir: "asc" | "desc" }[];
}

export function MovementsTab({ entity, title, columns, filters, allowed = true, entryField = "entry_id", sort }: MovementsTabProps) {
  const t = useTranslations("accounting.record");
  const open = useTabs((s) => s.open);
  if (!allowed) return <NoAccess text={t("no_access")} />;
  const openRow = (row: GridRow) => {
    const id = row[entryField];
    if (typeof id === "string") open({ title: String(row.number ?? t("entry")), href: `/r/accounting.entry/${id}`, kind: "record" });
  };
  return <DataGrid entity={entity} title={title} columns={columns} baseFilters={filters} onRowOpen={openRow} {...(sort ? { initialState: { sort } } : {})} />;
}
