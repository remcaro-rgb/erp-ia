import { describe, expect, it } from "vitest";
import type { ModuleState, Registry } from "@erp/kernel";
import { buildModuleViews } from "./modules-view";

// Task 50.9: the «módulo no contratado» row carries the parked not_entitled count; switched-off and bought modules show none.

const def = (id: string) => ({ id, navigation: [{ id: `${id}.home`, label: `nav.${id}.home`, href: `/${id}`, icon: "box" }], features: [] });
const registry = { module: (id: string) => def(id) } as unknown as Pick<Registry, "module">;
const state = (id: string, gate: ModuleState["gate"], needs: string[] = []): ModuleState => ({
  id, dependsOn: [], needs, purchased: gate !== "not_purchased", enabled: gate === "enabled", gate,
});

describe("buildModuleViews", () => {
  it("counts the open parked events whatever the gate is, and keeps menu and usedBy", () => {
    const states = [state("sales", "enabled", ["costing"]), state("costing", "not_purchased"), state("crm", "switched_off")];
    const views = buildModuleViews(states, registry, [{ moduleId: "costing", count: 3 }, { moduleId: "crm", count: 2 }, { moduleId: "sales", count: 1 }]);
    expect(views.map((v) => [v.id, v.parked])).toEqual([["sales", 1], ["costing", 3], ["crm", 2]]);
    expect(views[1]).toMatchObject({ gate: "not_purchased", usedBy: ["sales"], menu: ["nav.costing.home"] });
  });

  it("a not bought module with nothing parked shows zero", () => {
    expect(buildModuleViews([state("costing", "not_purchased")], registry, [])[0]!.parked).toBe(0);
  });
});
