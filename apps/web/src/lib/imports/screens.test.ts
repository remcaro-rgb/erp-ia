import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { importScreenProcesses, importScreens } from "./screens";

const registry = new Registry();
loadModules(registry, [kernelModule, core]);

describe("import screens", () => {
  it("asks for kernel.import.run and each screen's create process", () => {
    expect(importScreenProcesses()).toEqual(["kernel.import.run", "core.party.create", "core.product.create", "core.category.create"]);
  });

  it("offers the screens whose create process the caller may run, with their table and column count", () => {
    const screens = importScreens(registry, new Set(importScreenProcesses()));
    expect(screens.map((s) => [s.entity, s.href, s.table, s.columns])).toEqual([
      ["core.party", "/parties", "core.parties", 24],
      ["core.product", "/products", "core.products", 20],
      ["core.product_category", "/categories", "core.product_categories", 7],
    ]);
    expect(importScreens(registry, new Set(["kernel.import.run", "core.party.create"])).map((s) => s.entity)).toEqual(["core.party"]);
  });

  it("marks a documento's screen xlsx only (no Plantilla CSV, Task 13 ruling); maestros keep CSV", () => {
    const screens = importScreens(registry, new Set(importScreenProcesses()));
    expect(screens.map((s) => s.xlsxOnly)).toEqual([false, false, false]);
    const fake = Object.assign(Object.create(registry) as Registry, { entities: () => [{ ...registry.entity("core.party"), entityType: "documento" }] });
    expect(importScreens(fake, new Set(importScreenProcesses()))[0]?.xlsxOnly).toBe(true);
  });

  it("offers nothing without kernel.import.run", () => {
    expect(importScreens(registry, new Set(["core.party.create", "core.product.create"]))).toEqual([]);
  });
});
