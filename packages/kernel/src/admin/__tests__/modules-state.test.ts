import { describe, expect, it } from "vitest";
import { Registry } from "../../registry";
import type { ModuleDef } from "../../registry/types";
import type { Tx } from "../../db/client";
import { moduleStates, neededBy } from "../modules-state";

// Plan 2B Task 41 (Ruling R41-1): ModuleState carries `needs` and `neededBy` lists the modules that depend on or need a module.

const mod = (id: string, dependsOn: string[] = [], needs?: string[]): ModuleDef =>
  ({ id, version: "1", dependsOn, ...(needs ? { needs } : {}), entities: [], processes: [], features: [], navigation: [], events: { emits: [], consumes: {} } }) as ModuleDef;

describe("moduleStates needs", () => {
  it("exposes needs (empty when none) and neededBy lists needers next to dependents", async () => {
    const registry = { modules: () => [mod("core"), mod("inventory", ["core"], ["costing"]), mod("costing", ["core", "inventory"])] } as unknown as Registry;
    const tx = (async () => [
      { id: "core", purchased: true, disabled: false },
      { id: "inventory", purchased: true, disabled: false },
      { id: "costing", purchased: true, disabled: false },
    ]) as unknown as Tx;
    const states = await moduleStates(tx, registry);
    expect(states.map((s) => [s.id, s.needs])).toEqual([["core", []], ["inventory", ["costing"]], ["costing", []]]);
    expect(neededBy(states, "costing")).toEqual(["inventory"]);
    expect(neededBy(states, "inventory")).toEqual(["costing"]);
    expect(neededBy(states, "core")).toEqual(["inventory", "costing"]);
  });
});

describe("moduleStates gate (Task 50.9)", () => {
  it("the gate is the entitlement resolver's: switched_off wins over a lapsed purchase, never bought is not_purchased, the kernel is always enabled", async () => {
    const registry = { modules: () => [mod("kernel"), mod("a"), mod("b"), mod("c"), mod("d")] } as unknown as Registry;
    const tx = (async () => [
      { id: "kernel", purchased: false, disabled: false },
      { id: "a", purchased: true, disabled: false },
      { id: "b", purchased: true, disabled: true },
      { id: "c", purchased: false, disabled: false },
      { id: "d", purchased: false, disabled: true },
    ]) as unknown as Tx;
    const states = await moduleStates(tx, registry);
    expect(states.map((s) => [s.id, s.gate, s.enabled])).toEqual([
      ["kernel", "enabled", true], ["a", "enabled", true], ["b", "switched_off", false], ["c", "not_purchased", false], ["d", "switched_off", false],
    ]);
  });
});
