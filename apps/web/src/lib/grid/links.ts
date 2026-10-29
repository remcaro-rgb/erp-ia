import "server-only";
import { hasRecordPage, USER_ENTITY, withClaims, type EntityDef, type JwtClaims, type RunProcessDeps } from "@erp/kernel";
import { callerIsCompanyAdmin } from "@/lib/admin/company-admin";
import { gridDenial, gridEntity } from "./access";

// Which records the viewer may open from a link (rule 21, design §22.15): an entity with a page of its own whose grid the
// viewer may read (its feature entitled, its own consult allowed to a role). A user's page is under Administración ›
// Usuarios, which only the company admin opens: `kernel.user` links for the admin alone, anyone else reads the name as
// plain text. Resolved by the page's loader once, so a cell knows without asking the server whether to draw a link or
// plain text.

/** Entities whose record pages only the company admin opens (the users' pages, `/admin/users/<id>`). */
const ADMIN_PAGES = new Set([USER_ENTITY]);

/** The entities the `ref` fields of `entity` point to. */
export const refTargets = (entity: EntityDef): string[] => [...new Set(entity.fields.flatMap((f) => (f.type === "ref" && f.ref ? [f.ref.entity] : [])))];

/** Of `entities`, those the caller may open a record of. */
export async function linkableEntities(deps: RunProcessDeps, claims: JwtClaims, entities: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(entities)];
  // Asked once, and only when an admin-only page is among them.
  const admin = wanted.some((id) => ADMIN_PAGES.has(id)) ? withClaims(deps.sql, claims, callerIsCompanyAdmin) : Promise.resolve(false);
  const checked = await Promise.all(
    wanted.map(async (id) => {
      const entity = gridEntity(deps.registry, id);
      if (!entity || !hasRecordPage(entity)) return [];
      if (ADMIN_PAGES.has(id) && !(await admin)) return [];
      return (await gridDenial(deps, claims, entity)) === null ? [id] : [];
    }),
  );
  return new Set(checked.flat());
}
