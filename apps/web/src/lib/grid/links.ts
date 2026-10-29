import "server-only";
import { hasRecordPage, type EntityDef, type JwtClaims, type RunProcessDeps } from "@erp/kernel";
import { gridDenial, gridEntity } from "./access";

// Which records the viewer may open from a link (rule 21, design §22.15): an entity with a page of its own whose grid the
// viewer may read (its feature entitled, its own consult allowed to a role). Resolved by the page's loader once, so a
// cell knows without asking the server whether to draw a link or plain text.

/** The entities the `ref` fields of `entity` point to. */
export const refTargets = (entity: EntityDef): string[] => [...new Set(entity.fields.flatMap((f) => (f.type === "ref" && f.ref ? [f.ref.entity] : [])))];

/** Of `entities`, those the caller may open a record of. */
export async function linkableEntities(deps: RunProcessDeps, claims: JwtClaims, entities: readonly string[]): Promise<Set<string>> {
  const checked = await Promise.all(
    [...new Set(entities)].map(async (id) => {
      const entity = gridEntity(deps.registry, id);
      return entity && hasRecordPage(entity) && (await gridDenial(deps, claims, entity)) === null ? [id] : [];
    }),
  );
  return new Set(checked.flat());
}
