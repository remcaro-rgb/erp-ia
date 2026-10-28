import type { ResolvedEntityDef } from "./entities";
import type { ModuleDef, ProcessDef } from "./types";

export { defineEntity } from "./entities";
export type { EntityDef, ResolvedEntityDef } from "./entities";
export type { FieldDef, FieldType, ResolvedFieldDef } from "./fields";
export type { ConsumerContext, EventConsumer, FeatureDef, ModuleDef, NavItem, ProcessDef, ProcessKind } from "./types";

/** The catalogue every module declares its entities, processes and manifest in (design §5.3). */
export class Registry {
  private readonly entityMap = new Map<string, ResolvedEntityDef>();
  private readonly processMap = new Map<string, ProcessDef>();
  private readonly moduleMap = new Map<string, ModuleDef>();

  registerEntity(entity: ResolvedEntityDef): void {
    if (this.entityMap.has(entity.id)) throw new Error(`entity already registered: ${entity.id}`);
    this.entityMap.set(entity.id, entity);
  }

  entity(id: string): ResolvedEntityDef {
    const entity = this.entityMap.get(id);
    if (!entity) throw new Error(`unknown entity: ${id}`);
    return entity;
  }

  entities(module?: string): ResolvedEntityDef[] {
    return [...this.entityMap.values()].filter((e) => module === undefined || e.module === module);
  }

  registerProcess(process: ProcessDef): void {
    if (this.processMap.has(process.id)) throw new Error(`process already registered: ${process.id}`);
    this.processMap.set(process.id, process);
  }

  process(id: string): ProcessDef {
    const process = this.processMap.get(id);
    if (!process) throw new Error(`unknown process: ${id}`);
    return process;
  }

  processes(filter?: { module?: string }): ProcessDef[] {
    return [...this.processMap.values()].filter((p) => filter?.module === undefined || p.module === filter.module);
  }

  registerModule(module: ModuleDef): void {
    if (this.moduleMap.has(module.id)) throw new Error(`module already registered: ${module.id}`);
    this.moduleMap.set(module.id, module);
  }

  module(id: string): ModuleDef {
    const module = this.moduleMap.get(id);
    if (!module) throw new Error(`unknown module: ${id}`);
    return module;
  }

  hasModule(id: string): boolean {
    return this.moduleMap.has(id);
  }

  /** Registered modules in registration order (dependencies first when loaded through `loadModules`). */
  modules(): ModuleDef[] {
    return [...this.moduleMap.values()];
  }
}

// Kept on globalThis: the Workflow bundler loads this module a second time into the step bundle, and
// the consumers it runs must see the modules the app registered.
const GLOBAL_KEY = Symbol.for("erp.kernel.registry");
const globals = globalThis as { [GLOBAL_KEY]?: Registry };

export const registry: Registry = (globals[GLOBAL_KEY] ??= new Registry());
