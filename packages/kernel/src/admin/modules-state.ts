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

/**
 * What keeps `moduleId` from being switched off, or null: the first enabled module that `dependsOn` it, else the first enabled module that
 * `needs` it (Ruling R41-1). A needer that `moduleId` itself depends on does not block (owner item 112, 2026-11-09): costing depends on
 * inventory and inventory needs costing, so costing may go off while inventory is on, and inventory then goes off as usual.
 */
export function disableBlocker(states: ModuleState[], moduleId: string): { kind: "dependsOn" | "needs"; by: string } | null {
  const dependent = states.find((m) => m.enabled && m.dependsOn.includes(moduleId));
  if (dependent) return { kind: "dependsOn", by: dependent.id };
  const ownDeps = states.find((m) => m.id === moduleId)?.dependsOn ?? [];
  const needer = states.find((m) => m.enabled && m.needs.includes(moduleId) && !ownDeps.includes(m.id));
  return needer ? { kind: "needs", by: needer.id } : null;
}

/** The modules that depend on or need `moduleId`, in load order. */
export const neededBy = (states: ModuleState[], moduleId: string): string[] =>
  states.filter((other) => other.dependsOn.includes(moduleId) || other.needs.includes(moduleId)).map((other) => other.id);
