import type { ResolvedEntityDef } from "./entities";
import type { ModuleDef, ProcessDef } from "./types";

export { defineEntity } from "./entities";
export type { EntityDef, ResolvedEntityDef } from "./entities";
export type { FieldDef, FieldType, ResolvedFieldDef } from "./fields";
export type { ModuleDef, ProcessDef, ProcessKind } from "./types";

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

  modules(): ModuleDef[] {
    return [...this.moduleMap.values()];
  }
}

export const registry = new Registry();
