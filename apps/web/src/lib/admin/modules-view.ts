import { flattenNav, neededBy, type ModuleState, type ParkedEvents, type Registry } from "@erp/kernel";

// What Admin › Módulos shows per module (design §5.12, Task 50.9, Ruling R50-9): its state with the entitlement gate, its menu, who needs
// it, and, for a module the company never bought, the events parked as `not_entitled` waiting for it («módulo no contratado»).

export type ModuleView = ModuleState & {
  usedBy: string[];
  menu: string[];
  /** Open events parked because the module was not bought (dismissed and replayed ones are not counted). */
  parked: number;
};

export function buildModuleViews(states: ModuleState[], registry: Pick<Registry, "module">, parked: ParkedEvents[]): ModuleView[] {
  const counts = new Map(parked.map((p) => [p.moduleId, p.count]));
  return states.map((state) => {
    const def = registry.module(state.id);
    const items = flattenNav([...def.navigation, ...def.features.flatMap((f) => f.nav ?? [])]).filter((item) => item.menu !== false);
    return {
      ...state,
      usedBy: neededBy(states, state.id),
      menu: [...new Set(items.map((item) => item.label))],
      // Open rows whatever the gate is now (a module bought but not yet swept still shows them); a replayed or dismissed one is not counted.
      parked: counts.get(state.id) ?? 0,
    };
  });
}
