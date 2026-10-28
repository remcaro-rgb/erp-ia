import { entitled, runnableProcesses, type JwtClaims, type Registry, type ResolvedEntityDef, type RunProcessDeps } from "@erp/kernel";

// Who may read an entity's grid (design §9, §5.12, rule 13): the company must be entitled to the feature that
// declares the entity (or its module), and one of the caller's roles must be allowed a consult process of that
// feature, preferably the entity's own (`core.party` → `core.party.consult`, `core.product_category` →
// `core.category.consult`). The read itself runs under the caller's claims over the masked view.

export type GridDenial = "not_found" | "not_entitled" | "forbidden";

/** The registered entity `id`, or null (also for an id the registry rejects). */
export function gridEntity(registry: Registry, id: string): ResolvedEntityDef | null {
  try {
    return registry.entity(id);
  } catch {
    return null;
  }
}

/** The consult processes that open the entity's grid: the entity's own when it has one, else the feature's. */
export function consultProcessesOf(registry: Registry, entity: ResolvedEntityDef): string[] {
  const mod = registry.hasModule(entity.module) ? registry.module(entity.module) : null;
  if (!mod) return [];
  const feature = mod.features.find((f) => f.entities.includes(entity.id));
  const candidates = (feature?.processes ?? mod.processes.map((p) => p.id)).filter((id) => registry.process(id).kind === "consult");
  const name = entity.id.slice(entity.id.indexOf(".") + 1);
  const own = candidates.filter((id) => {
    const noun = id.split(".")[1] ?? "";
    return noun === name || name.endsWith(`_${noun}`);
  });
  return own.length > 0 ? own : candidates;
}

/** Null when the caller may read the entity's grid in the active company, else why not. */
export async function gridDenial(deps: RunProcessDeps, claims: JwtClaims, entity: ResolvedEntityDef): Promise<GridDenial | null> {
  const { registry, sql } = deps;
  if (!registry.hasModule(entity.module)) return "not_found";
  const feature = registry.module(entity.module).features.find((f) => f.entities.includes(entity.id));
  const key = feature ? `feature:${feature.id}` : `module:${entity.module}`;
  if (entity.module !== "kernel" && !(await entitled(sql, claims.active_company_id, key))) return "not_entitled";
  const consults = consultProcessesOf(registry, entity);
  const runnable = await runnableProcesses(sql, registry, claims, consults);
  return runnable.size > 0 ? null : "forbidden";
}
