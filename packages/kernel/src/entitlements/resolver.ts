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
 * Registers the module's manifest in SQL (design §5.2, §5.12). Idempotent; service connection.
 *  - `kernel.module_features`: the feature -> process / entity map, so SQL resolves `process:x.y.z` through its feature;
 *  - `kernel.registered_processes`: every process with its feature, kind and step-up, for the role seeds and the
 *    sensitive defaults;
 *  - `kernel.entity_fields`: every field with its sensitivity. A `confidential` field the module registers for the
 *    first time (its first sync included) starts `masked` for every existing non-admin role of every company (rule 14;
 *    an existing row, an admin's own choice, is kept); roles created afterwards are masked by `kernel.seed_role_defaults`.
 * Rows the manifest no longer declares are dropped. The sensitive defaults of a company are written by
 * `kernel.seed_company_defaults` (the admin processes ask for the step-up in their definitions anyway).
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

    const processIds = module.processes.map((p) => p.id);
    await tx`delete from kernel.registered_processes where module_id = ${module.id} and not (process_id = any(${processIds}::text[]))`;
    for (const process of module.processes) {
      const feature = module.features.find((f) => f.processes.includes(process.id))?.id ?? process.feature ?? null;
      await tx`
        insert into kernel.registered_processes (process_id, module_id, feature_id, kind, step_up)
        values (${process.id}, ${module.id}, ${feature}, ${process.kind}, ${process.sensitivity === "step-up"})
        on conflict (process_id) do update set
          module_id = excluded.module_id, feature_id = excluded.feature_id, kind = excluded.kind, step_up = excluded.step_up, updated_at = now()`;
    }

    const known = await tx<{ entity: string; field: string; sensitivity: string }[]>`
      select entity, field, sensitivity from kernel.entity_fields where module_id = ${module.id}`;
    const wasConfidential = new Set(known.filter((f) => f.sensitivity === "confidential").map((f) => `${f.entity}.${f.field}`));
    const fields = module.entities.flatMap((entity) => entity.fields.map((field) => ({ entity: entity.id, field: field.name, sensitivity: field.sensitivity ?? "normal" })));
    const keys = fields.map((f) => `${f.entity}.${f.field}`);
    await tx`delete from kernel.entity_fields where module_id = ${module.id} and not ((entity || '.' || field) = any(${keys}::text[]))`;
    for (const f of fields) {
      await tx`
        insert into kernel.entity_fields (entity, field, module_id, sensitivity)
        values (${f.entity}, ${f.field}, ${module.id}, ${f.sensitivity})
        on conflict (entity, field) do update set module_id = excluded.module_id, sensitivity = excluded.sensitivity, updated_at = now()`;
    }
    const newlyConfidential = fields.filter((f) => f.sensitivity === "confidential" && !wasConfidential.has(`${f.entity}.${f.field}`));
    if (newlyConfidential.length > 0) {
      await tx`
        insert into kernel.field_permissions (company_id, role_id, entity, field, mode)
        select r.company_id, r.id, f.entity, f.field, 'masked'
        from kernel.roles r
        cross join unnest(${newlyConfidential.map((f) => f.entity)}::text[], ${newlyConfidential.map((f) => f.field)}::text[]) as f(entity, field)
        where not (r.is_system and r.name = 'admin')
        on conflict (company_id, role_id, entity, field) do nothing`;
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
