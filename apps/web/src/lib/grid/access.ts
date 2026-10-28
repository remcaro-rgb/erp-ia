import { entitled, runnableProcesses, type JwtClaims, type Registry, type ResolvedEntityDef, type RunProcessDeps } from "@erp/kernel";

// Who may read an entity's grid (design §9, §5.12, rule 13): the company must be entitled to the feature that
// declares the entity (or its module), and one of the caller's roles must be allowed the entity's own consult
// process. An entity without one cannot be read through the grid. The read itself runs under the caller's claims
// over the masked view.

export type GridDenial = "not_found" | "not_entitled" | "forbidden";

/** The registered entity `id`, or null (also for an id the registry rejects). */
export function gridEntity(registry: Registry, id: string): ResolvedEntityDef | null {
  try {
    return registry.entity(id);
  } catch {
    return null;
  }
}

/**
 * The entity's own consult process, which opens its grid: `<entity>.consult` (`core.party.consult`), or the consult of
 * the entity's last name segment where the module names it so (`core.product_category` → `core.category.consult`).
 * Never another entity's: a role allowed to consult categories does not read price lists. Empty when the entity has none.
 */
export function consultProcessesOf(registry: Registry, entity: ResolvedEntityDef): string[] {
  const name = entity.id.slice(entity.id.indexOf(".") + 1);
  const ids = [`${entity.id}.consult`, `${entity.module}.${name.split("_").at(-1)}.consult`];
  return [...new Set(ids)].filter((id) => {
    try {
      const process = registry.process(id);
      return process.kind === "consult" && process.module === entity.module;
    } catch {
      return false;
    }
  });
}

/** Null when the caller may read the entity's grid in the active company, else why not. */
export async function gridDenial(deps: RunProcessDeps, claims: JwtClaims, entity: ResolvedEntityDef): Promise<GridDenial | null> {
  const { registry, sql } = deps;
  if (!registry.hasModule(entity.module)) return "not_found";
  const feature = registry.module(entity.module).features.find((f) => f.entities.includes(entity.id));
  const key = feature ? `feature:${feature.id}` : `module:${entity.module}`;
  if (entity.module !== "kernel" && !(await entitled(sql, claims.active_company_id, key))) return "not_entitled";
  const consults = consultProcessesOf(registry, entity);
  if (consults.length === 0) return "forbidden";
  const runnable = await runnableProcesses(sql, registry, claims, consults);
  return runnable.size > 0 ? null : "forbidden";
}
