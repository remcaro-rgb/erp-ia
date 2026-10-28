import type { Sql } from "postgres";
import type { Registry } from "../registry";
import type { ModuleDef } from "../registry/types";

/** Whether the company may use `key` (`module:x`, `feature:x.y`, `process:x.y.z`, `limit:x`). */
export type EntitledFn = (sql: Sql, companyId: string, key: string) => Promise<boolean>;

/**
 * Resolves `key` for the company in SQL (`kernel.entitled`, design §5.12): the most specific active
 * entitlement decides, falling back process -> feature -> module; a module the company disabled is
 * never entitled. Uses the service connection: the check is not made under the caller's claims.
 */
export const entitled: EntitledFn = async (sql, companyId, key) => {
  const [row] = await sql<{ entitled: boolean }[]>`select kernel.entitled(${companyId}, ${key}) as entitled`;
  return row!.entitled;
};

/**
 * The `limit_value` for a `limit:x` key (`kernel.entitlement_limit`), under the same specificity rule
 * as `entitled`: the company's own active rows win over tenant-wide ones, so a company row with
 * `enabled = false` masks a tenant-wide limit. Null when there is none or it has no value.
 */
export async function entitlementLimit(sql: Sql, companyId: string, key: string): Promise<number | null> {
  const [row] = await sql<{ limit_value: string | null }[]>`select kernel.entitlement_limit(${companyId}, ${key}) as limit_value`;
  return row?.limit_value == null ? null : Number(row.limit_value);
}

/**
 * Stores the module's feature -> process / entity map in `kernel.module_features` so SQL can resolve
 * `process:x.y.z` through its feature, and drops features the manifest no longer declares.
 * Service connection; idempotent.
 */
export async function syncModuleManifest(sql: Sql, module: ModuleDef): Promise<void> {
  await sql.begin(async (tx) => {
    const featureIds = module.features.map((f) => f.id);
    await tx`delete from kernel.module_features where module_id = ${module.id} and not (feature_id = any(${featureIds}::text[]))`;
    for (const feature of module.features) {
      await tx`
        insert into kernel.module_features (module_id, feature_id, process_ids, entity_ids)
        values (${module.id}, ${feature.id}, ${feature.processes}::text[], ${feature.entities}::text[])
        on conflict (module_id, feature_id)
        do update set process_ids = excluded.process_ids, entity_ids = excluded.entity_ids, updated_at = now()`;
    }
  });
}

/**
 * Switches the module on for the company. Every module in `dependsOn` must already be enabled for
 * it (`<id> requires <dep>`). Also syncs the module's features so its processes resolve. Idempotent;
 * re-enables a module the company had disabled. Service connection.
 */
export async function enableModule(sql: Sql, companyId: string, moduleId: string, registry: Registry): Promise<void> {
  const module = registry.module(moduleId);
  const enabled = await sql<{ module_id: string }[]>`
    select module_id from kernel.company_modules
    where company_id = ${companyId} and enabled and module_id = any(${module.dependsOn}::text[])`;
  const have = new Set(enabled.map((r) => r.module_id));
  const missing = module.dependsOn.find((dep) => !have.has(dep));
  if (missing !== undefined) throw new Error(`module ${moduleId} requires ${missing}, which is not enabled for company ${companyId}`);

  await syncModuleManifest(sql, module);
  await sql`
    insert into kernel.company_modules (company_id, module_id, enabled, enabled_at)
    values (${companyId}, ${moduleId}, true, now())
    on conflict (company_id, module_id)
    do update set enabled = true, enabled_at = case when kernel.company_modules.enabled then kernel.company_modules.enabled_at else now() end`;
}
