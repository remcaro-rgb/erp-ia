import { defineEntity } from "../registry/entities";
import { POSTING_CONSUMER, postingConsumer } from "../posting/engine";
import { consumers } from "../events/consumers";
import type { Registry } from "../registry";
import type { ModuleDef } from "../registry/types";

/**
 * Registers `modules` (their entities, processes and manifests) in dependency order: a module is
 * registered after everything in its `dependsOn`, which must be among `modules` or already in the
 * registry. Throws `module dependency cycle: a -> b -> a`, `missing dependency: <id>` or
 * `duplicate module <id>` or `entity <id>: unknown <create|attach> process <id>` before registering anything. Each entry of a module's `events.consumes` is
 * registered as that module's consumer of the event (design §5.5).
 */
export function loadModules(registry: Registry, modules: ModuleDef[]): void {
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
  const kinds = new Map([...registry.processes(), ...modules.flatMap((m) => m.processes)].map((p) => [p.id, p.kind]));
  for (const module of modules) {
    for (const provider of module.homeKpis ?? []) {
      if (provider.consult === undefined) continue;
      const kind = kinds.get(provider.consult);
      if (kind === undefined) throw new Error(`KPI provider ${provider.id}: unknown consult process ${provider.consult}`);
      if (kind !== "consult") throw new Error(`KPI provider ${provider.id}: ${provider.consult} is not a consult process`);
    }
  }

  // A report's `consult` must be a consult process some module declares: a typo would show a report that never runs.
  for (const module of modules) {
    for (const report of module.reports ?? []) {
      const kind = kinds.get(report.consult);
      if (kind === undefined) throw new Error(`report ${report.id}: unknown consult process ${report.consult}`);
      if (kind !== "consult") throw new Error(`report ${report.id}: ${report.consult} is not a consult process`);
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
    for (const [event, fn] of Object.entries(module.events.consumes)) {
      const wrapped = event === "*" && fn === POSTING_CONSUMER && module.postingProvider ? postingConsumer(module.postingProvider) : fn;
      consumers.register(module.id, event, wrapped);
    }
  }
}
