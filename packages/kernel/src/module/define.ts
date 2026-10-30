import { ENTITY_ID } from "../registry/fields";
import type { ModuleDef } from "../registry/types";

export type { ConsumerContext, EventConsumer, FeatureDef, HomeKpiProvider, Kpi, ModuleDef, NavItem } from "../registry/types";

/** Module ids are Postgres schema names, so they follow the same lowercase identifier shape. */
const MODULE_ID = /^[a-z][a-z0-9_]*$/;

/**
 * Validates a module manifest and returns it. Throws when: the id is malformed; the module depends
 * on itself; a process is declared for another module; a feature is outside the module's namespace,
 * duplicated, or lists a process or entity the module does not declare.
 */
export function defineModule(def: ModuleDef): ModuleDef {
  if (!MODULE_ID.test(def.id)) throw new Error(`invalid module id "${def.id}": use lowercase letters, digits and underscores`);
  if (def.dependsOn.includes(def.id)) throw new Error(`module ${def.id} depends on itself`);

  const processIds = new Set<string>();
  for (const process of def.processes) {
    if (process.module !== def.id) {
      throw new Error(`process ${process.id} is declared for module "${process.module}" but ships in module "${def.id}"`);
    }
    processIds.add(process.id);
  }
  const entityIds = new Set(def.entities.map((entity) => entity.id));

  const featureIds = new Set<string>();
  for (const feature of def.features) {
    if (!ENTITY_ID.test(feature.id) || !feature.id.startsWith(`${def.id}.`)) {
      throw new Error(`feature ${feature.id} must be named "${def.id}.<name>"`);
    }
    if (featureIds.has(feature.id)) throw new Error(`duplicate feature ${feature.id} in module ${def.id}`);
    featureIds.add(feature.id);
    for (const id of feature.processes) {
      if (!processIds.has(id)) throw new Error(`feature ${feature.id} lists process ${id}, which module ${def.id} does not declare`);
    }
    for (const id of feature.entities) {
      if (!entityIds.has(id)) throw new Error(`feature ${feature.id} lists entity ${id}, which module ${def.id} does not declare`);
    }
  }

  // `events.consumes` keys are event names or "*" (every event); the loader registers them as they are.
  const providerIds = new Set<string>();
  for (const provider of def.homeKpis ?? []) {
    if (!provider.id.startsWith(`${def.id}.`)) throw new Error(`KPI provider ${provider.id} must be named "${def.id}.<name>"`);
    if (providerIds.has(provider.id)) throw new Error(`duplicate KPI provider ${provider.id} in module ${def.id}`);
    providerIds.add(provider.id);
    if (!featureIds.has(provider.feature)) throw new Error(`KPI provider ${provider.id} names feature ${provider.feature}, which module ${def.id} does not declare`);
  }
  return def;
}
