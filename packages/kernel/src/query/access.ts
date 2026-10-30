import type { JwtClaims, Tx } from "../db/client";
import { getServiceDb } from "../db/service";
import { entitled } from "../entitlements/resolver";
import { ProcessError } from "../process/errors";
import { runnableProcesses } from "../process/permissions";
import type { RunProcessDeps } from "../process/run";
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
 * A `query` entity opens its grid through `<entity>.list`. Never another entity's: a role allowed to consult categories does not read price lists. Empty when the entity has none.
 */
export function consultProcessesOf(registry: Registry, entity: ResolvedEntityDef): string[] {
  const name = entity.id.slice(entity.id.indexOf(".") + 1);
  const ids =
    entity.kind === "query"
      ? [`${entity.id}.list`, `${entity.id}.consult`]
      : [`${entity.id}.consult`, `${entity.module}.${name.split("_").at(-1)}.consult`];
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

export type GridDenial = "not_found" | "not_entitled" | "forbidden";

/**
 * Null when the caller may read the entity's grid in the active company, else why not: the entity's module is not
 * loaded (`not_found`), the company is not entitled to its feature (`not_entitled`), or no role of the caller may run
 * its own consult process (`forbidden`; also when it has none). The grid route, the export and the assistant's
 * `data.query` ask the same question. The read itself runs under the caller's claims over the masked view.
 */
export async function gridDenial(deps: RunProcessDeps, claims: JwtClaims, entity: ResolvedEntityDef): Promise<GridDenial | null> {
  const { registry, sql } = deps;
  if (!registry.hasModule(entity.module)) return "not_found";
  const key = entitlementKeyOf(registry, entity);
  if (key !== null && !(await (deps.entitled ?? entitled)(sql, claims.active_company_id, key))) return "not_entitled";
  const consults = consultProcessesOf(registry, entity);
  if (consults.length === 0) return "forbidden";
  const runnable = await runnableProcesses(sql, registry, claims, consults);
  return runnable.size > 0 ? null : "forbidden";
}

/**
 * The grid's own gate inside a process (rule 13): the company is entitled to the entity's feature (or module) and a
 * role of the caller may run the entity's consult process; else `not_entitled` / `forbidden`. Runs in the caller's
 * transaction; the entitlement is resolved with the service connection, as `runProcess` does. The export and
 * `kernel.data.query` read nothing a grid would refuse.
 */
export async function requireGridAccess(tx: Tx, registry: Registry, entity: ResolvedEntityDef): Promise<void> {
  const [company] = await tx<{ id: string }[]>`select kernel.current_company_id() as id`;
  const key = entitlementKeyOf(registry, entity);
  if (key !== null && !(await entitled(getServiceDb(), company!.id, key))) {
    throw new ProcessError("not_entitled", `${entity.id} is not entitled for company ${company!.id}`);
  }
  const consults = consultProcessesOf(registry, entity);
  const [row] =
    consults.length === 0
      ? [{ allowed: false }]
      : await tx<{ allowed: boolean }[]>`select coalesce(bool_or(kernel.can_run_process(p)), false) as allowed from unnest(${consults}::text[]) as p`;
  if (!row?.allowed) throw new ProcessError("forbidden", `no role of the caller may consult ${entity.id}`);
}
