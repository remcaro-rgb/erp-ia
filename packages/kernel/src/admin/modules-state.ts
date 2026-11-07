import type { Tx } from "../db/client";
import { gateOf, type ModuleGate } from "../entitlements/resolver";
import type { Registry } from "../registry";

// Which modules the active company may use (design §5.12), read as its admin: the tenant bought it
// (`kernel.module_purchased`, the entitlement rows) and the company has not switched it off (`kernel.company_modules`).
// The kernel is the platform and is always on.

export interface ModuleState {
  id: string;
  dependsOn: string[];
  /** Modules it uses without a load-order edge (`ModuleDef.needs`); empty when none. */
  needs: string[];
  purchased: boolean;
  enabled: boolean;
  /** The entitlement resolver's answer (`gateOf`): the one the dispatcher and the inline poster use too. */
  gate: ModuleGate;
}

/** Every registered module with its state for the active company of `tx`, in load order. */
export async function moduleStates(tx: Tx, registry: Registry): Promise<ModuleState[]> {
  const modules = registry.modules();
  const ids = modules.map((m) => m.id);
  const rows = await tx<{ id: string; purchased: boolean; disabled: boolean }[]>`
    select m.id, kernel.module_purchased(m.id) as purchased,
           exists (select 1 from kernel.v_company_modules cm
                   where cm.company_id = kernel.current_company_id() and cm.module_id = m.id and not cm.enabled) as disabled
    from unnest(${ids}::text[]) as m(id)`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return modules.map((m) => {
    const row = byId.get(m.id)!;
    const gate = gateOf({ moduleId: m.id, purchased: row.purchased, disabled: row.disabled });
    return { id: m.id, dependsOn: [...m.dependsOn], needs: [...(m.needs ?? [])], purchased: m.id === "kernel" || row.purchased, enabled: gate === "enabled", gate };
  });
}

/** The modules that depend on or need `moduleId`, in load order. */
export const neededBy = (states: ModuleState[], moduleId: string): string[] =>
  states.filter((other) => other.dependsOn.includes(moduleId) || other.needs.includes(moduleId)).map((other) => other.id);
