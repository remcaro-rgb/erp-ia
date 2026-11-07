import { ENTITY_ID } from "../registry/fields";
import { ACCOUNT_ROLES } from "../posting/roles";
import { RuleTemplate } from "../posting/template";
import type { ModuleDef, NavItem } from "../registry/types";

export type { ConsumerContext, EventConsumer, FeatureDef, HomeKpiProvider, Kpi, ModuleDef, NavItem } from "../registry/types";

/** Module ids are Postgres schema names, so they follow the same lowercase identifier shape. */
const MODULE_ID = /^[a-z][a-z0-9_]*$/;

/** The items with every group replaced by its children, in order: the openable screens of a menu. */
export const flattenNav = (items: readonly NavItem[]): NavItem[] => items.flatMap((item) => item.children ?? [item]);

/** A group holds leaves only: a child that has children of its own is refused (one dropdown level). */
function checkNavigation(moduleId: string, items: readonly NavItem[]): void {
  for (const item of items) {
    for (const child of item.children ?? []) {
      if (child.children) throw new Error(`navigation item ${child.id} of module ${moduleId} is a child of ${item.id} and cannot have children`);
    }
  }
}

/**
 * Validates a module manifest and returns it. Throws when: the id is malformed; the module depends
 * on itself; a process is declared for another module; a feature is outside the module's namespace,
 * duplicated, or lists a process or entity the module does not declare.
 */
export function defineModule(def: ModuleDef): ModuleDef {
  if (!MODULE_ID.test(def.id)) throw new Error(`invalid module id "${def.id}": use lowercase letters, digits and underscores`);
  if (def.dependsOn.includes(def.id)) throw new Error(`module ${def.id} depends on itself`);
  for (const need of def.needs ?? []) {
    if (typeof need !== "string") throw new Error(`module ${def.id}: needs must be module id strings`);
    if (need === def.id) throw new Error(`module ${def.id} needs itself`);
  }
  for (const { item, under } of def.shortcuts ?? []) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(under)) throw new Error(`module ${def.id}: shortcut ${item.id} must sit under <module>.<section>, got "${under}"`);
    if (!def.dependsOn.includes(under.slice(0, under.indexOf(".")))) throw new Error(`module ${def.id}: shortcut ${item.id} under ${under} needs ${under.slice(0, under.indexOf("."))} in dependsOn`);
  }

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
  checkNavigation(def.id, def.navigation);
  for (const feature of def.features) checkNavigation(def.id, feature.nav ?? []);
  // A feature's menu item unlocks an item of the module's navigation (top level or group child); the shell never lists it a second time.
  const navIds = new Set(def.navigation.flatMap((i) => [i.id, ...(i.children ?? []).map((c) => c.id)]));
  for (const feature of def.features) {
    for (const item of feature.nav ?? []) {
      if (!navIds.has(item.id)) throw new Error(`feature ${feature.id} lists menu item ${item.id}, which is neither a top-level item nor a group child of module ${def.id}'s navigation`);
    }
  }

  // Card effects (plan 2B Task 25): keyed by an event or by one of the module's processes, each an i18n key of the module's namespace.
  for (const [key, lines] of Object.entries(def.effects ?? {})) {
    if (!ENTITY_ID.test(key)) throw new Error(`effects of module ${def.id}: "${key}" is neither an event nor a process id`);
    if (key.startsWith(`${def.id}.`) && !processIds.has(key) && !def.events.emits.includes(key) && def.events.consumes[key] === undefined) {
      throw new Error(`effects of module ${def.id}: "${key}" is none of its processes or events`);
    }
    if (lines.length === 0) throw new Error(`effects of module ${def.id}: "${key}" lists no effect`);
    for (const line of lines) if (!line.startsWith(`${def.id}.effects.`)) throw new Error(`effects of module ${def.id}: "${line}" must be an i18n key named "${def.id}.effects.<name>"`);
  }

  const tabIds = new Set<string>();
  for (const tab of def.recordTabs ?? []) {
    if (!tab.id.startsWith(`${def.id}.`)) throw new Error(`record tab ${tab.id} must be named "${def.id}.<name>"`);
    if (tabIds.has(tab.id)) throw new Error(`duplicate record tab ${tab.id} in module ${def.id}`);
    tabIds.add(tab.id);
    if (!featureIds.has(tab.feature)) throw new Error(`record tab ${tab.id} names feature ${tab.feature}, which module ${def.id} does not declare`);
    if (tab.forEntities !== "*" && tab.forEntities.length === 0) throw new Error(`record tab ${tab.id} names no entity`);
    if (tab.kind === "grid" && !tab.source) throw new Error(`grid contribution ${tab.id} needs a source`);
    if (tab.kind === "mapping" && (!tab.dimension || !tab.roles?.length || !tab.lookupEntity || !tab.saveProcess)) {
      throw new Error(`mapping contribution ${tab.id} needs dimension, roles, lookupEntity and saveProcess`);
    }
  }

  const reportIds = new Set<string>();
  for (const report of def.reports ?? []) {
    if (report.module !== def.id || !report.id.startsWith(`${def.id}.`)) throw new Error(`report ${report.id} must be named "${def.id}.<name>" and declared for module ${def.id}`);
    if (reportIds.has(report.id)) throw new Error(`duplicate report ${report.id} in module ${def.id}`);
    reportIds.add(report.id);
    if (!featureIds.has(report.feature)) throw new Error(`report ${report.id} names feature ${report.feature}, which module ${def.id} does not declare`);
  }

  const providerIds = new Set<string>();
  for (const provider of def.homeKpis ?? []) {
    if (!provider.id.startsWith(`${def.id}.`)) throw new Error(`KPI provider ${provider.id} must be named "${def.id}.<name>"`);
    if (providerIds.has(provider.id)) throw new Error(`duplicate KPI provider ${provider.id} in module ${def.id}`);
    providerIds.add(provider.id);
    if (!featureIds.has(provider.feature)) throw new Error(`KPI provider ${provider.id} names feature ${provider.feature}, which module ${def.id} does not declare`);
  }

  const chartIds = new Set<string>();
  for (const provider of def.homeCharts ?? []) {
    if (!provider.id.startsWith(`${def.id}.`)) throw new Error(`chart provider ${provider.id} must be named "${def.id}.<name>"`);
    if (chartIds.has(provider.id) || providerIds.has(provider.id)) throw new Error(`duplicate home provider ${provider.id} in module ${def.id}`);
    chartIds.add(provider.id);
    if (!featureIds.has(provider.feature)) throw new Error(`chart provider ${provider.id} names feature ${provider.feature}, which module ${def.id} does not declare`);
  }

  const roles = new Set<string>([...ACCOUNT_ROLES, ...(def.accountRoles ?? [])]);
  for (const rule of def.postingRules ?? []) {
    const parsed = RuleTemplate.safeParse(rule.template);
    if (!parsed.success) throw new Error(`posting rule "${rule.name}" of module ${def.id} has an invalid template: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    for (const line of parsed.data.lines) {
      if (line.role && !roles.has(line.role)) throw new Error(`posting rule "${rule.name}" of module ${def.id} names role ${line.role}, which is neither in the catalogue nor in accountRoles`);
    }
  }
  return def;
}
