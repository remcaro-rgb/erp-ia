import { consultProcessesOf, entitled, entitlementKeyOf, runnableProcesses, type JwtClaims, type ResolvedEntityDef, type RunProcessDeps } from "@erp/kernel";

export { consultProcessesOf, gridEntity } from "@erp/kernel";

// Who may read an entity's grid (design §9, §5.12, rule 13): the company must be entitled to the feature that
// declares the entity (or its module), and one of the caller's roles must be allowed the entity's own consult
// process. An entity without one cannot be read through the grid. The read itself runs under the caller's claims
// over the masked view.

export type GridDenial = "not_found" | "not_entitled" | "forbidden";

/** Null when the caller may read the entity's grid in the active company, else why not. */
export async function gridDenial(deps: RunProcessDeps, claims: JwtClaims, entity: ResolvedEntityDef): Promise<GridDenial | null> {
  const { registry, sql } = deps;
  if (!registry.hasModule(entity.module)) return "not_found";
  const key = entitlementKeyOf(registry, entity);
  if (key !== null && !(await entitled(sql, claims.active_company_id, key))) return "not_entitled";
  const consults = consultProcessesOf(registry, entity);
  if (consults.length === 0) return "forbidden";
  const runnable = await runnableProcesses(sql, registry, claims, consults);
  return runnable.size > 0 ? null : "forbidden";
}
