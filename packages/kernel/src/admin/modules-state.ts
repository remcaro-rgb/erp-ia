import type { Tx } from "../db/client";
import type { Registry } from "../registry";

// Which modules the active company may use (design §5.12), read as its admin: the tenant bought it
// (`kernel.module_purchased`, the entitlement rows) and the company has not switched it off (`kernel.company_modules`).
// The kernel is the platform and is always on.

export interface ModuleState {
  id: string;
  dependsOn: string[];
  purchased: boolean;
  enabled: boolean;
}

/** Every registered module with its state for the active company of `tx`, in load order. */
export async function moduleStates(tx: Tx, registry: Registry): Promise<ModuleState[]> {
  const modules = registry.modules();
  const ids = modules.map((m) => m.id);
  const rows = await tx<{ id: string; purchased: boolean; disabled: boolean }[]>`
    select m.id, kernel.module_purchased(m.id) as purchased,
           exists (select 1 from kernel.company_modules cm
                   where cm.company_id = kernel.current_company_id() and cm.module_id = m.id and not cm.enabled) as disabled
    from unnest(${ids}::text[]) as m(id)`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return modules.map((m) => {
    const row = byId.get(m.id)!;
    const platform = m.id === "kernel";
    return { id: m.id, dependsOn: [...m.dependsOn], purchased: platform || row.purchased, enabled: platform || (row.purchased && !row.disabled) };
  });
}
