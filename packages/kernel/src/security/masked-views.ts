import type { ResolvedEntityDef } from "../registry/entities";

/** Columns every row carries for isolation and audit; they are selected as they are, never masked. */
export const UNMASKED_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "company_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
]);

/**
 * SQL that publishes the masked read view `<schema>.v_<table>` of an entity (rule 14). Every
 * declared field other than the unmasked columns is wrapped in
 * `case when kernel.field_visible(entity, field) then col else null end`, so a hidden or masked
 * value never leaves the database. `security_invoker` makes the base table's RLS apply to the
 * caller; `id` and `company_id` are always selected. Grids, exports and the assistant must read
 * the view, never the table.
 */
export function maskedViewSql(entity: ResolvedEntityDef): string {
  const columns = [`  "id"`, `  "company_id"`];
  for (const field of entity.fields) {
    if (field.name === "id" || field.name === "company_id") continue;
    columns.push(
      UNMASKED_COLUMNS.has(field.name)
        ? `  "${field.name}"`
        : `  case when kernel.field_visible('${entity.id}', '${field.name}') then "${field.name}" else null end as "${field.name}"`,
    );
  }
  const view = `${entity.schema}.v_${entity.table}`;
  return [
    `create or replace view ${view} with (security_invoker = true) as`,
    `select`,
    columns.join(",\n"),
    `from ${entity.schema}.${entity.table};`,
    `grant select on ${view} to authenticated;`,
  ].join("\n");
}
