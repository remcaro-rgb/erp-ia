import { defineEntity } from "../registry/entities";
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

  for (const module of ordered) {
    for (const entity of module.entities) registry.registerEntity(defineEntity(entity));
    for (const process of module.processes) registry.registerProcess(process);
    registry.registerModule(module);
    for (const [event, fn] of Object.entries(module.events.consumes)) consumers.register(module.id, event, fn);
  }
}
