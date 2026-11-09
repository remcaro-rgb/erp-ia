import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Registry } from "../registry";
import type { ModuleDef } from "../registry/types";
import { menuItemsOf } from "../module/menu";

/** Whether the company may use `key` (`module:x`, `feature:x.y`, `process:x.y.z`, `limit:x`). */
export type EntitledFn = (sql: Sql, companyId: string, key: string) => Promise<boolean>;

/**
 * Resolves `key` for the company in SQL (`kernel.entitled`, design §5.12): the most specific active
 * entitlement decides, falling back process -> feature -> module; a module the company disabled is
 * never entitled. Uses the service connection: the check is not made under the caller's claims.
 */
export const entitled: EntitledFn = (sql, companyId, key) => askEntitled(sql, companyId).ask(key);

/**
 * What a company may do with a module (design §5.12, owner 2026-11-06 decision item 9): `enabled` (bought and on), `switched_off` (the
 * company turned it off: its events park silently and wait for it) or `not_purchased` (the tenant never bought it: its events are
 * dead-lettered `not_entitled` and stay visible on Admin › Módulos). One answer for the dispatcher, the inline poster and the admin page.
 */
export type ModuleGate = "enabled" | "switched_off" | "not_purchased";

/**
 * The gate from its two facts: the company's own switch (`disabled`: a `kernel.company_modules` row with `enabled = false`) and whether the
 * tenant bought it. A switch that is off wins (a module once bought, then switched off, is silent even if the plan lapsed); otherwise a
 * module that was not bought is `not_purchased`. The platform module is always on.
 */
export function gateOf(facts: { moduleId?: string; purchased: boolean; disabled: boolean }): ModuleGate {
  if (facts.moduleId === "kernel") return "enabled";
  if (facts.disabled) return "switched_off";
  return facts.purchased ? "enabled" : "not_purchased";
}

/** `gateOf` for the company's module, asked in SQL on the service connection (`kernel.entitled` resolves the purchase; the switch is read from `kernel.company_modules`). */
export async function moduleGate(sql: Sql, companyId: string, moduleId: string): Promise<ModuleGate> {
  if (moduleId === "kernel") return "enabled";
  const [row] = await sql<{ disabled: boolean }[]>`
    select exists (select 1 from kernel.company_modules where company_id = ${companyId} and module_id = ${moduleId} and not enabled) as disabled`;
  if (row?.disabled) return "switched_off";
  return gateOf({ moduleId, purchased: await entitled(sql, companyId, `module:${moduleId}`), disabled: false });
}

type EntitledBatch = { keys: Set<string>; answers: Promise<Map<string, boolean>>; ask: (key: string) => Promise<boolean> };
const entitledBatches = new WeakMap<Sql, Map<string, EntitledBatch>>();

/**
 * `entitled` is asked key by key by a dozen loaders of one page at the same time (the shell's menu, each process run). Askers for the
 * same company in the same event-loop turn share one statement; nothing is kept after the answer.
 */
function askEntitled(sql: Sql, companyId: string): EntitledBatch {
  const bySql = entitledBatches.get(sql) ?? new Map<string, EntitledBatch>();
  entitledBatches.set(sql, bySql);
  const existing = bySql.get(companyId);
  if (existing) return existing;
  const keys = new Set<string>();
  const answers = new Promise<Map<string, boolean>>((resolve, reject) => {
    setImmediate(() => {
      bySql.delete(companyId);
      sql<{ key: string; entitled: boolean }[]>`select k as key, kernel.entitled(${companyId}, k) as entitled from unnest(${[...keys]}::text[]) as k`
        .then((rows) => resolve(new Map(rows.map((r) => [r.key, r.entitled]))), reject);
    });
  });
  const batch: EntitledBatch = {
    keys,
    answers,
    ask: async (key) => {
      keys.add(key);
      return (await answers).get(key) === true;
    },
  };
  bySql.set(companyId, batch);
  return batch;
}

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
 *  - `kernel.entity_tables`: the schema and table of every maestro and documento (the usability gate and the reference check read it);
 *  - `kernel.menu_items`: every menu item with its group, address, entity and the processes it lists (kernel.menu_access, 0047);
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
    // One statement per table, not one per row: a hosted database is a network round trip away (the arrays go as JSON).
    if (module.features.length > 0) {
      await tx`
        insert into kernel.module_features (module_id, feature_id, process_ids, entity_ids)
        select ${module.id}, f->>'id', array(select jsonb_array_elements_text(f->'processes')), array(select jsonb_array_elements_text(f->'entities'))
        from jsonb_array_elements(${tx.json(module.features.map((f) => ({ id: f.id, processes: f.processes, entities: f.entities })))}::jsonb) f
        on conflict (module_id, feature_id)
        do update set process_ids = excluded.process_ids, entity_ids = excluded.entity_ids, updated_at = now()`;
    }

    const processIds = module.processes.map((p) => p.id);
    await tx`delete from kernel.registered_processes where module_id = ${module.id} and not (process_id = any(${processIds}::text[]))`;
    const processRows = module.processes.map((process) => ({
      id: process.id,
      feature: module.features.find((f) => f.processes.includes(process.id))?.id ?? process.feature ?? null,
      kind: process.kind,
      step_up: process.sensitivity === "step-up",
    }));
    if (processRows.length > 0) {
      await tx`
        insert into kernel.registered_processes (process_id, module_id, feature_id, kind, step_up)
        select r.id, ${module.id}, r.feature, r.kind, r.step_up
        from jsonb_to_recordset(${tx.json(processRows)}::jsonb) as r(id text, feature text, kind text, step_up boolean)
        on conflict (process_id) do update set
          module_id = excluded.module_id, feature_id = excluded.feature_id, kind = excluded.kind, step_up = excluded.step_up, updated_at = now()`;
    }

    // kernel.entity_tables: where each maestro / documento lives, for kernel.record_usable and kernel.record_referenced (0041), and the lines entity for kernel.record_versions (0051).
    const typedEntities = module.entities.filter((e) => e.entityType === "maestro" || e.entityType === "documento");
    await tx`delete from kernel.entity_tables where module_id = ${module.id} and not (entity = any(${typedEntities.map((e) => e.id)}::text[]))`;
    if (typedEntities.length > 0) {
      const tableRows = typedEntities.map((e) => ({ id: e.id, type: e.entityType as string, schema: e.schema, table: e.table, lines: e.typed?.lines?.entity ?? null }));
      await tx`
        insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity)
        select r.id, ${module.id}, r.type, r.schema, r."table", r.lines
        from jsonb_to_recordset(${tx.json(tableRows)}::jsonb) as r(id text, type text, schema text, "table" text, lines text)
        on conflict (entity) do update set
          module_id = excluded.module_id, entity_type = excluded.entity_type, table_schema = excluded.table_schema, table_name = excluded.table_name,
          lines_entity = excluded.lines_entity, updated_at = now()`;
    }

    // kernel.menu_items: the module's menu items and the processes each lists, for kernel.menu_access (0047).
    const items = menuItemsOf(module);
    await tx`delete from kernel.menu_items where module_id = ${module.id} and not (nav_key = any(${items.map((i) => i.navKey)}::text[]))`;
    if (items.length > 0) {
      const itemRows = items.map((i) => ({ nav_key: i.navKey, module_id: i.moduleId, parent_key: i.parentKey, href: i.href, entity: i.entity, process_ids: i.processIds }));
      await tx`
        insert into kernel.menu_items (nav_key, module_id, parent_key, href, entity, process_ids)
        select r.nav_key, r.module_id, r.parent_key, r.href, r.entity, array(select jsonb_array_elements_text(r.process_ids))
        from jsonb_to_recordset(${tx.json(itemRows)}::jsonb) as r(nav_key text, module_id text, parent_key text, href text, entity text, process_ids jsonb)
        on conflict (nav_key) do update set
          module_id = excluded.module_id, parent_key = excluded.parent_key, href = excluded.href, entity = excluded.entity,
          process_ids = excluded.process_ids, updated_at = now()`;
    }

    const known = await tx<{ entity: string; field: string; sensitivity: string }[]>`
      select entity, field, sensitivity from kernel.entity_fields where module_id = ${module.id}`;
    const wasConfidential = new Set(known.filter((f) => f.sensitivity === "confidential").map((f) => `${f.entity}.${f.field}`));
    const fields = module.entities.flatMap((entity) => entity.fields.map((field) => ({ entity: entity.id, field: field.name, sensitivity: field.sensitivity ?? "normal" })));
    const keys = fields.map((f) => `${f.entity}.${f.field}`);
    await tx`delete from kernel.entity_fields where module_id = ${module.id} and not ((entity || '.' || field) = any(${keys}::text[]))`;
    // Chunked: one JSON parameter per few thousand fields.
    for (let i = 0; i < fields.length; i += 2000) {
      await tx`
        insert into kernel.entity_fields (entity, field, module_id, sensitivity)
        select r.entity, r.field, ${module.id}, r.sensitivity
        from jsonb_to_recordset(${tx.json(fields.slice(i, i + 2000))}::jsonb) as r(entity text, field text, sensitivity text)
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

/** What `syncModuleManifest` writes for the module, as one string: the same input gives the same hash, any change to it a different one. */
function manifestSignature(module: ModuleDef): string {
  const typed = module.entities.filter((e) => e.entityType === "maestro" || e.entityType === "documento");
  return createHash("sha256")
    .update(
      JSON.stringify({
        features: module.features.map((f) => [f.id, f.processes, f.entities]),
        processes: module.processes.map((p) => [p.id, module.features.find((f) => f.processes.includes(p.id))?.id ?? p.feature ?? null, p.kind, p.sensitivity === "step-up"]),
        tables: typed.map((e) => [e.id, e.entityType, e.schema, e.table, e.typed?.lines?.entity ?? null]),
        menu: menuItemsOf(module).map((i) => [i.navKey, i.moduleId, i.parentKey, i.href, i.entity, i.processIds]),
        fields: module.entities.map((e) => [e.id, e.fields.map((f) => [f.name, f.sensitivity ?? "normal"])]),
      }),
    )
    .digest("hex");
}

/**
 * `syncModuleManifest` only when the manifest differs from the one stored for the module (`kernel.manifest_hashes`, 0061): a server
 * that starts with the manifests it already registered pays one read. True when it synced.
 */
export async function syncModuleManifestIfChanged(sql: Sql, module: ModuleDef): Promise<boolean> {
  const hash = manifestSignature(module);
  // The stored hash and the row counts of the module's registry tables, in one read: a registry whose rows were removed or added
  // behind the hash's back (a test's cleanup, a restore) is not "unchanged".
  const [stored] = await sql<{ hash: string | null; features: number; processes: number; menu: number; fields: number; tables: number }[]>`
    select (select hash from kernel.manifest_hashes where module_id = ${module.id}) as hash,
           (select count(*)::int from kernel.module_features where module_id = ${module.id}) as features,
           (select count(*)::int from kernel.registered_processes where module_id = ${module.id}) as processes,
           (select count(*)::int from kernel.menu_items where module_id = ${module.id}) as menu,
           (select count(*)::int from kernel.entity_fields where module_id = ${module.id}) as fields,
           (select count(*)::int from kernel.entity_tables where module_id = ${module.id}) as tables`;
  const same =
    stored?.hash === hash &&
    stored.features === module.features.length &&
    stored.processes === module.processes.length &&
    stored.menu === menuItemsOf(module).length &&
    stored.fields === module.entities.reduce((n, e) => n + e.fields.length, 0) &&
    stored.tables === module.entities.filter((e) => e.entityType === "maestro" || e.entityType === "documento").length;
  if (same) return false;
  await syncModuleManifest(sql, module);
  await sql`
    insert into kernel.manifest_hashes (module_id, hash) values (${module.id}, ${hash})
    on conflict (module_id) do update set hash = excluded.hash, updated_at = now()`;
  return true;
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
  // The events parked as `not_entitled` while the module was not bought go back to the outbox, once (Task 50.9).
  await replayParkedEvents(sql, companyId, moduleId);
}

/**
 * Switches the module off for the company, keeping its row and data (the service-connection twin of `kernel.admin.module.disable`, same
 * dependsOn rule: refused while another enabled module depends on it). Idempotent; a module never enabled gets its off row. Service connection.
 */
export async function disableModule(sql: Sql, companyId: string, moduleId: string, registry: Registry): Promise<void> {
  registry.module(moduleId);
  const dependents = registry.modules().filter((m) => m.dependsOn.includes(moduleId)).map((m) => m.id);
  if (dependents.length > 0) {
    const [on] = await sql<{ module_id: string }[]>`
      select module_id from kernel.company_modules where company_id = ${companyId} and enabled and module_id = any(${dependents}::text[]) limit 1`;
    if (on) throw new Error(`module ${on.module_id} depends on ${moduleId}, which cannot be disabled while it is enabled for company ${companyId}`);
  }
  await sql`
    insert into kernel.company_modules (company_id, module_id, enabled, enabled_at)
    values (${companyId}, ${moduleId}, false, now())
    on conflict (company_id, module_id) do update set enabled = false`;
}

/** Sends the module's open `not_entitled` dead letters of the company back to the outbox; answers how many (`kernel.parked_events_replay`, 0120). */
export async function replayParkedEvents(sql: Sql, companyId: string, moduleId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select kernel.parked_events_replay(${companyId}, ${moduleId}) as n`;
  return Number(row?.n ?? 0);
}
