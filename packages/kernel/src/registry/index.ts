import type { ReportDef } from "../reports/types";
import type { ResolvedEntityDef } from "./entities";
import type { HomeChartProvider, HomeKpiProvider, ModuleDef, ProcessDef, RecordTabContribution } from "./types";

export { defineEntity } from "./entities";
export { hasRecordPage, recordHref, recordPageEntities, USER_ENTITY } from "./href";
export type { EntityDef, EntityType, ResolvedEntityDef, TypedDef } from "./entities";
export type { FieldDef, FieldType, ResolvedFieldDef } from "./fields";
export type { ConsumerContext, EventConsumer, Chart, FeatureDef, HomeChartProvider, HomeKpiProvider, Kpi, MenuSection, ModuleDef, NavItem, ProcessDef, ProcessKind, RecordTabContribution } from "./types";

/** The catalogue every module declares its entities, processes and manifest in (design §5.3). */
export class Registry {
  private readonly entityMap = new Map<string, ResolvedEntityDef>();
  private readonly processMap = new Map<string, ProcessDef>();
  private readonly moduleMap = new Map<string, ModuleDef>();
  private readonly reportMap = new Map<string, ReportDef>();
  private readonly kpiMap = new Map<string, HomeKpiProvider>();
  private readonly chartMap = new Map<string, HomeChartProvider>();

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

  registerReport(report: ReportDef): void {
    if (this.reportMap.has(report.id)) throw new Error(`report already registered: ${report.id}`);
    this.reportMap.set(report.id, report);
  }

  report(id: string): ReportDef {
    const report = this.reportMap.get(id);
    if (!report) throw new Error(`unknown report: ${id}`);
    return report;
  }

  reports(module?: string): ReportDef[] {
    return [...this.reportMap.values()].filter((r) => module === undefined || r.module === module);
  }

  /** Adds a provider of home screen KPIs (`kernel.home.kpis` runs the ones the company is entitled to). */
  registerKpiProvider(provider: HomeKpiProvider): void {
    if (this.kpiMap.has(provider.id)) throw new Error(`KPI provider already registered: ${provider.id}`);
    this.kpiMap.set(provider.id, provider);
  }

  /** The registered providers in registration order (modules load dependencies first). */
  kpiProviders(): HomeKpiProvider[] {
    return [...this.kpiMap.values()];
  }

  /** Adds a provider of Inicio charts (`kernel.home.kpis` runs the ones the company is entitled to). */
  registerChartProvider(provider: HomeChartProvider): void {
    if (this.chartMap.has(provider.id)) throw new Error(`chart provider already registered: ${provider.id}`);
    this.chartMap.set(provider.id, provider);
  }

  chartProviders(): HomeChartProvider[] {
    return [...this.chartMap.values()];
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

  /**
   * The tabs modules contribute to the record page of `entityId`, in module registration order: the ones for every
   * entity (`"*"`) and the ones naming it. Whether the company holds each one's feature is the page's check.
   */
  recordTabsFor(entityId: string): RecordTabContribution[] {
    return this.modules().flatMap((m) => (m.recordTabs ?? []).filter((c) => c.forEntities === "*" || c.forEntities.includes(entityId)));
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
