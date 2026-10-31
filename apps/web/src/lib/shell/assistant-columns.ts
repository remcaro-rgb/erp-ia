import "server-only";
import type { Caller, EntityDef, GridAccess, RunProcessDeps } from "@erp/kernel";
import { gridPageAccess } from "@erp/kernel";
import type { ResultColumn } from "@erp/ui";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { buildColumns, type Translate } from "@/lib/grid/columns";
import { gridEntities } from "@/lib/grid/hrefs";
import { linkableEntities, refTargets } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";

// What the assistant's result tables know of an entity (design §7.1, rule 14): labels and types of its registered
// fields with the caller's mode of each (a masked field shows ••••••, a hidden one has no column), read the way the
// grid page reads them: only entities whose grid the caller may open, and without the fields the grid leaves out.

/**
 * The columns of `entity` for a caller with `access`: the grid's columns without the admin-defined fields, with the
 * references and the identity column marked linkable when the caller may open their records (`linkable`, rule 21).
 */
export function assistantColumnsOf(entity: EntityDef, access: GridAccess, t: Translate, linkable: ReadonlySet<string> = new Set()): ResultColumn[] {
  return buildColumns(entity, access, presentationOf(entity.id), t, {}, linkable)
    .filter((column) => !column.field.startsWith("extra."))
    .map((column) => ({
      field: column.field,
      label: column.label,
      type: column.type,
      mode: column.mode,
      ...(column.options ? { options: column.options } : {}),
      ...(column.hiddenByDefault ? { hiddenByDefault: true } : {}),
      ...(column.identity ? { identity: true, ...(linkable.has(entity.id) ? { linkable: true } : {}) } : {}),
      ...(column.ref ? { ref: column.ref, ...(column.linkable ? { linkable: true } : {}) } : {}),
    }));
}

/** The columns of every entity with a grid screen that the caller may read. */
export async function loadAssistantColumns(deps: RunProcessDeps, caller: Caller, t: Translate): Promise<Record<string, ResultColumn[]>> {
  const entries = await Promise.all(
    gridEntities().map(async (id): Promise<[string, ResultColumn[]][]> => {
      const entity = gridEntity(deps.registry, id);
      if (!entity || (await gridDenial(deps, caller.claims, entity)) !== null) return [];
      const [access, linkable] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), linkableEntities(deps, caller.claims, [entity.id, ...refTargets(entity)])]);
      return [[id, assistantColumnsOf(entity, access, t, linkable)]];
    }),
  );
  return Object.fromEntries(entries.flat());
}
