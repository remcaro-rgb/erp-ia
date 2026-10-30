import type { Registry } from "../registry";
import type { ProcessDef, ProcessKind } from "../registry/types";
import { ADMIN_FEATURE } from "./common";

// What the permission matrix shows for each process (design §6: "the permission matrix shows the entity name next to
// each process id"): the module it belongs to, the entity it acts on and the i18n key naming that entity.

export interface MatrixProcess {
  id: string;
  module: string;
  kind: ProcessKind;
  /** `core.party` for `core.party.create`: the process id without its verb. */
  entity: string;
  /**
   * i18n key of the name shown beside the id: the registered entity's label (`entity.core.party` → "Tercero"), else the
   * label of the feature the process belongs to (`feature.kernel.admin` → "Administración"), else the module's name.
   */
  entityLabel: string;
  /** The process always asks for the step-up (its definition says so); the admin cannot lower it. */
  stepUp: boolean;
  /** An administration process (feature kernel.admin): only the system admin role holds it, never given to another role. */
  admin: boolean;
}

/** The entity and its label key for one process of the registry. */
export function matrixProcess(registry: Registry, process: ProcessDef): MatrixProcess {
  const entity = process.id.includes(".") ? process.id.slice(0, process.id.lastIndexOf(".")) : process.id;
  const registered = registry.entities().find((e) => e.id === entity);
  const module = registry.hasModule(process.module) ? registry.module(process.module) : null;
  const feature = module?.features.find((f) => f.processes.includes(process.id));
  return {
    id: process.id,
    module: process.module,
    kind: process.kind,
    entity,
    entityLabel: registered?.label ?? feature?.label ?? `nav.modules.${process.module}`,
    stepUp: process.sensitivity === "step-up",
    admin: process.feature === ADMIN_FEATURE,
  };
}

/**
 * Every process of the registry for the matrix, grouped by module in load order and by entity then id inside a
 * module; `modules` keeps only the modules given (the ones the company may use).
 */
export function matrixProcesses(registry: Registry, modules?: ReadonlySet<string>): MatrixProcess[] {
  const order = registry.modules().map((m) => m.id);
  return registry
    .processes()
    .filter((p) => !p.origins && (!modules || modules.has(p.module)))
    .map((p) => matrixProcess(registry, p))
    .sort((a, b) => order.indexOf(a.module) - order.indexOf(b.module) || a.entity.localeCompare(b.entity) || a.id.localeCompare(b.id));
}
