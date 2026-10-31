import type { Tx } from "../db/client";
import { ProcessError } from "../process/errors";
import type { Registry } from "../registry";
import type { EntityDef } from "../registry/entities";
import { IDENTIFIER } from "../registry/fields";
import { gridEntity, requireGridAccess } from "./access";
import { labelText, refLabelKey } from "./ref-label";

// The names of the records a page of rows refers to (design §22.15, rule 21): for each `ref` field of the entity, the
// display field of the referenced records, read in the caller's transaction through the target entity's masked view, so
// company RLS, the party scope and field masking apply as in the target's own grid. Only for a target the caller may read
// as a grid (its feature entitled, its own consult allowed to a role): a reference to an entity they may not consult
// keeps its id and gets no name. A record they do not see, or whose display field is masked or hidden to them, gets none
// either. One select per target entity and page.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the caller may read `entity` as a grid, asked in their transaction (the grid's own gate). */
async function mayRead(tx: Tx, registry: Registry, entity: NonNullable<ReturnType<typeof gridEntity>>): Promise<boolean> {
  try {
    await requireGridAccess(tx, registry, entity);
    return true;
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return false;
    throw error;
  }
}

/**
 * Adds `<field>_label` (`refLabelKey`) to every row whose `ref` field names a record the caller may read, in place.
 * Rows without the field (a page of other columns) and empty references are left as they are.
 */
export async function addRefLabels(tx: Tx, registry: Registry, entity: EntityDef, rows: Record<string, unknown>[]): Promise<void> {
  const names = new Set(entity.fields.map((f) => f.name));
  // The fields to name, grouped by the entity they point to.
  const byTarget = new Map<string, { field: string; display: string }[]>();
  for (const field of entity.fields) {
    if (field.type !== "ref" || !field.ref || names.has(refLabelKey(field.name))) continue;
    if (!rows.some((row) => typeof row[field.name] === "string")) continue;
    byTarget.set(field.ref.entity, [...(byTarget.get(field.ref.entity) ?? []), { field: field.name, display: field.ref.display }]);
  }
  for (const [targetId, fields] of byTarget) {
    const target = gridEntity(registry, targetId);
    if (!target || !registry.hasModule(target.module) || !(await mayRead(tx, registry, target))) continue;
    for (const part of [target.schema, target.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${target.id}: invalid identifier "${part}"`);
    const displays = [...new Set(fields.map((f) => f.display))].filter((d) => target.fields.some((f) => f.name === d) && IDENTIFIER.test(d));
    if (displays.length === 0) continue;
    const ids = [...new Set(rows.flatMap((row) => fields.map((f) => row[f.field])).filter((v): v is string => typeof v === "string" && UUID.test(v)))];
    if (ids.length === 0) continue;
    const found = await tx.unsafe<Record<string, unknown>[]>(
      `select "id", ${displays.map((d) => `"${d}"`).join(", ")} from ${target.schema}.v_${target.table} where "id" = any($1::uuid[])`,
      [ids] as never[],
    );
    const byId = new Map(found.map((r) => [String(r.id), r]));
    for (const row of rows) {
      for (const { field, display } of fields) {
        const value = row[field];
        const label = typeof value === "string" ? byId.get(value)?.[display] : undefined;
        if (label !== null && label !== undefined && label !== "") row[refLabelKey(field)] = labelText(label, target.fields.find((f) => f.name === display));
      }
    }
  }
}
