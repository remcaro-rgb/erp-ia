import { defineEntity } from "../registry/entities";
import { POSTING_CONSUMER, postingConsumer } from "../posting/engine";
import { consumers } from "../events/consumers";
import type { Registry } from "../registry";
import type { ModuleDef, ProcessDef } from "../registry/types";
import { genericProcesses, isTypedEntity } from "../typed/processes";
import { stateMailConsumer } from "../typed/notify";
import { statusChangedEvent } from "../typed/runner";
import { withMenuSections } from "./menu";

/**
 * Registers `modules` (their entities, processes and manifests) in dependency order: a module is
 * registered after everything in its `dependsOn`, which must be among `modules` or already in the
 * registry. Throws `module dependency cycle: a -> b -> a`, `missing dependency: <id>` or
 * `duplicate module <id>` or `entity <id>: unknown <create|attach> process <id>` before registering anything. Each entry of a module's `events.consumes` is
 * registered as that module's consumer of the event (design §5.5).
 *
 * Every maestro and documento of a module also gets the kernel's generic lifecycle processes (`<entity>.save`, `.submit`,
 * `.approve`, `.reject`, `.void`, `.delete`, entity types spec §5): added to the module's processes and to each feature that
 * lists the entity, so they are entitled and permissioned like the module's own. An id the module declares itself is kept.
 * `typedHooks` may only name the module's maestros and documentos, and a documento that numbers `on_save` needs a `number` hook.
 *
 * Every maestro and documento also gets the kernel's consumer of its `<entity>.status_changed` event: the state e-mails of spec §7
 * (typed/notify.ts), registered as the kernel's.
 *
 * Every module with a menu has the four level-1 sections Maestros, Documentos, Reportes and Parámetros (entity types spec §2.4, §9.2):
 * `module x: missing menu section <s>` otherwise; the list pages of its maestros, documentos and parametros are placed in their
 * section (`withMenuSections`, module/menu.ts).
 */
export function loadModules(registry: Registry, declared: ModuleDef[]): void {
  const modules = declared.map(withLifecycleProcesses).map((module) => withMenuSections(module));
  const byId = new Map<string, ModuleDef>();
  for (const module of modules) {
    if (byId.has(module.id)) throw new Error(`duplicate module ${module.id}`);
    if (registry.hasModule(module.id)) throw new Error(`module already registered: ${module.id}`);
    byId.set(module.id, module);
  }

  // Depth-first topological sort that keeps the input order among independent modules.
  const ordered: ModuleDef[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (module: ModuleDef) => {
    if (done.has(module.id)) return;
    const at = path.indexOf(module.id);
    if (at !== -1) throw new Error(`module dependency cycle: ${[...path.slice(at), module.id].join(" -> ")}`);
    path.push(module.id);
    for (const dep of module.dependsOn) {
      const target = byId.get(dep);
      if (target) visit(target);
      else if (!registry.hasModule(dep)) throw new Error(`missing dependency: ${dep}`);
    }
    path.pop();
    done.add(module.id);
    ordered.push(module);
  };
  for (const module of modules) visit(module);

  // An entity's declared processes (`processIds.create` / `.attach`) must exist once these modules are in.
  const processIds = new Set([...registry.processes().map((p) => p.id), ...modules.flatMap((m) => m.processes.map((p) => p.id))]);
  for (const module of modules) {
    for (const entity of module.entities) {
      for (const [role, id] of Object.entries(entity.processIds ?? {})) {
        if (id !== undefined && !processIds.has(id)) throw new Error(`entity ${entity.id}: unknown ${role} process ${id}`);
      }
    }
  }

  // A KPI provider's `consult` gate must be a consult process some module declares: a typo would silently hide the card.
  const known = [...registry.processes(), ...modules.flatMap((m) => m.processes)];
  const kinds = new Map(known.map((p) => [p.id, p.kind]));
  const features = new Map(known.map((p) => [p.id, p.feature]));
  for (const module of modules) {
    for (const provider of module.homeKpis ?? []) {
      if (provider.consult === undefined) continue;
      const kind = kinds.get(provider.consult);
      if (kind === undefined) throw new Error(`KPI provider ${provider.id}: unknown consult process ${provider.consult}`);
      if (kind !== "consult") throw new Error(`KPI provider ${provider.id}: ${provider.consult} is not a consult process`);
    }
  }

  for (const module of modules) {
    for (const provider of module.homeCharts ?? []) {
      if (provider.consult === undefined) continue;
      const kind = kinds.get(provider.consult);
      if (kind === undefined) throw new Error(`chart provider ${provider.id}: unknown consult process ${provider.consult}`);
      if (kind !== "consult") throw new Error(`chart provider ${provider.id}: ${provider.consult} is not a consult process`);
    }
  }

  // A report's `consult` must be a consult process some module declares: a typo would show a report that never runs.
  for (const module of modules) {
    for (const report of module.reports ?? []) {
      const kind = kinds.get(report.consult);
      if (kind === undefined) throw new Error(`report ${report.id}: unknown consult process ${report.consult}`);
      if (kind !== "consult") throw new Error(`report ${report.id}: ${report.consult} is not a consult process`);
      // A file action runs a consult of the report's own feature: the entitlement and the role matrix read the same feature.
      for (const action of report.fileActions ?? []) {
        const actionKind = kinds.get(action.process);
        if (actionKind === undefined) throw new Error(`report ${report.id}: file action ${action.id} names unknown process ${action.process}`);
        if (actionKind !== "consult") throw new Error(`report ${report.id}: file action ${action.id}: ${action.process} is not a consult process`);
        if (features.get(action.process) !== report.feature) throw new Error(`report ${report.id}: file action ${action.id}: ${action.process} is of feature ${features.get(action.process)}, not ${report.feature}`);
      }
    }
  }

  // A posting provider receives every event, so it must consume "*"; the marker is replaced by the engine over it.
  for (const module of modules) {
    if (module.postingProvider && module.events.consumes["*"] === undefined) throw new Error(`module ${module.id} has a postingProvider and must consume "*"`);
  }

  for (const module of ordered) {
    for (const entity of module.entities) registry.registerEntity(defineEntity(entity));
    for (const process of module.processes) registry.registerProcess(process);
    registry.registerModule(module);
    for (const report of module.reports ?? []) registry.registerReport(report);
    for (const provider of module.homeKpis ?? []) registry.registerKpiProvider(provider);
    for (const provider of module.homeCharts ?? []) registry.registerChartProvider(provider);
    for (const [event, fn] of Object.entries(module.events.consumes)) {
      const wrapped = event === "*" && fn === POSTING_CONSUMER && module.postingProvider ? postingConsumer(module.postingProvider) : fn;
      consumers.register(module.id, event, wrapped);
    }
    for (const entity of module.entities.filter(isTypedEntity)) consumers.register("kernel", statusChangedEvent(entity.id), stateMailConsumer(registry));
  }
}

/**
 * Fail closed (Task 5 review): the generic Grabar (`<entity>.save`) writes the record's columns itself, so a typed entity whose module
 * validates its own updates (an update process `<entity>.update`, or the `update` sibling of its declared create process, e.g.
 * `core.category.update`) must register a `validate` hook that runs that validation, or the generic save would bypass it.
 */
function assertValidateHooks(module: ModuleDef, typed: ModuleDef["entities"]): void {
  const own = new Set(module.processes.map((p) => p.id));
  for (const entity of typed) {
    const updates = [`${entity.id}.update`];
    const create = entity.processIds?.create;
    if (create?.endsWith(".create")) updates.push(`${create.slice(0, -".create".length)}.update`);
    if (!updates.some((id) => own.has(id)) || module.typedHooks?.[entity.id]?.validate) continue;
    throw new Error(`module ${module.id}: typed entity ${entity.id} needs a validate hook`);
  }
}

/**
 * The module with the generic lifecycle processes of its maestros and documentos added (see loadModules). Refuses hooks for an
 * entity that is not one of the module's typed entities and an `on_save` documento without a number hook, and a typed entity
 * with an update process of its own but no validate hook.
 */
function withLifecycleProcesses(module: ModuleDef): ModuleDef {
  const typed = module.entities.filter(isTypedEntity);
  const typedIds = new Set(typed.map((e) => e.id));
  for (const entityId of Object.keys(module.typedHooks ?? {})) {
    if (!typedIds.has(entityId)) throw new Error(`module ${module.id}: typedHooks names ${entityId}, which is not a maestro or documento of the module`);
  }
  for (const entity of typed) {
    if (entity.typed?.numbering === "on_save" && !module.typedHooks?.[entity.id]?.number) {
      throw new Error(`entity ${entity.id} numbers on_save: module ${module.id} must register a typedHooks number hook`);
    }
  }
  assertValidateHooks(module, typed);
  if (typed.length === 0) return module;

  const own = new Set(module.processes.map((p) => p.id));
  const added: ProcessDef[] = [];
  const byEntity = new Map<string, string[]>();
  for (const entity of typed) {
    const feature = module.features.find((f) => f.entities.includes(entity.id))?.id;
    const ids: string[] = [];
    for (const process of genericProcesses({ ...entity, module: module.id })) {
      if (own.has(process.id)) continue;
      added.push(feature ? { ...process, feature } : process);
      ids.push(process.id);
    }
    byEntity.set(entity.id, ids);
  }
  return {
    ...module,
    processes: [...module.processes, ...added],
    features: module.features.map((f) => {
      const ids = f.entities.flatMap((e) => byEntity.get(e) ?? []).filter((id) => !f.processes.includes(id));
      return ids.length === 0 ? f : { ...f, processes: [...f.processes, ...ids] };
    }),
  };
}
