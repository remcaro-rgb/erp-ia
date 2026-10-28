import "server-only";
import { gridPageAccess, type Caller, type ResolvedEntityDef, type RunProcessDeps } from "@erp/kernel";
import type { ExportPresentation } from "@erp/kernel/exports";
import { isLocale, messages, type Messages } from "@erp/i18n";
import { buildColumns } from "@/lib/grid/columns";
import { categoryOptions } from "@/lib/grid/options";
import { presentationOf } from "@/lib/grid/presentation";
import { gridTables } from "@/lib/records/tables";

// What an export's headers and value labels say (design §9, rule 24): the same labels the grid shows the caller —
// the catalogue's field labels, the admin's own labels for extra data, the option labels of enums, booleans and codes
// — so a file reads like the screen it came from. Cosmetic only: which columns the file has is decided by the
// kernel from the caller's field access, never from this.

/** A translator over a locale's catalogue, without the request context a page has: the key itself when missing. */
export function translator(locale: string): (key: string) => string {
  const catalogue: Messages = messages(isLocale(locale) ? locale : "es-419");
  return (key) => {
    let node: string | Messages | undefined = catalogue;
    for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
    return typeof node === "string" ? node : key;
  };
}

/** Labels and value labels of the entity's columns that the grid state exports (all of them when it names none). */
export async function exportPresentation(deps: RunProcessDeps, caller: Caller, entity: ResolvedEntityDef, columns: readonly string[] | undefined): Promise<Required<ExportPresentation>> {
  const locale = caller.claims.locale;
  const [access, categories] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), entity.id === "core.product" ? categoryOptions(caller) : Promise.resolve([])]);
  const wanted = columns ? new Set(columns) : null;
  const labels: Record<string, string> = {};
  const values: Record<string, Record<string, string>> = {};
  for (const column of buildColumns(entity, access, presentationOf(entity.id), translator(locale), { ...gridTables(locale), categories })) {
    if (wanted && !wanted.has(column.field)) continue;
    labels[column.field] = column.label;
    if (column.options) values[column.field] = Object.fromEntries(column.options.map((o) => [o.value, o.label]));
  }
  return { labels, values };
}
