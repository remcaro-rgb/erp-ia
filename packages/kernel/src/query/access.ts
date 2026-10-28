import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";

// Who may read an entity's grid, and so export it (design §9, §5.12, rule 13): the company must be entitled to the
// feature that declares the entity (or its module), and one of the caller's roles must be allowed the entity's own
// consult process. Shared by the grid route and the export process, so both refuse the same callers.

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

/**
 * The entitlement key the company needs to read the entity: its feature when a feature of the module declares it,
 * else the module. The kernel is the platform and needs none (null).
 */
export function entitlementKeyOf(registry: Registry, entity: ResolvedEntityDef): string | null {
  if (entity.module === "kernel") return null;
  const feature = registry.module(entity.module).features.find((f) => f.entities.includes(entity.id));
  return feature ? `feature:${feature.id}` : `module:${entity.module}`;
}
