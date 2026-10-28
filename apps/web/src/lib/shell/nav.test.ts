import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { buildShellNav, shellAccessKeys } from "./nav";

// What the shell offers a caller (design §19a, rule 4, rule 13): modules the company is entitled to, menu items
// whose feature is entitled and readable by one of the caller's roles, and the create processes they may run.

const registry = new Registry();
loadModules(registry, [kernelModule, core]);
const keys = shellAccessKeys(registry);
const all = { entitled: new Set(keys.entitlements), runnable: new Set(keys.processes) };

describe("buildShellNav", () => {
  it("asks for the module and feature entitlements and every process behind a menu item", () => {
    expect(keys.entitlements).toEqual(expect.arrayContaining(["module:core", "feature:core.parties", "feature:core.products"]));
    expect(keys.processes).toEqual(expect.arrayContaining(["core.party.consult", "core.party.create", "core.category.create"]));
  });

  it("with everything granted: the core module, its four items and its three create commands", () => {
    const shell = buildShellNav(registry, all);
    expect(shell.modules).toEqual([{ id: "core", label: "nav.modules.core" }]);
    expect(shell.nav.map((i) => i.href)).toEqual(["/parties", "/products", "/categories", "/import"]);
    const byId = (a: { processId: string }, b: { processId: string }) => a.processId.localeCompare(b.processId);
    expect([...shell.creates].sort(byId)).toEqual([
      { processId: "core.category.create", labelKey: "nav.create.core.category", href: "/categories?new=1" },
      { processId: "core.party.create", labelKey: "nav.create.core.party", href: "/parties?new=1" },
      { processId: "core.product.create", labelKey: "nav.create.core.product", href: "/products?new=1" },
    ]);
    // A contact is created inside its party: no screen of its own, no command.
    expect(shell.creates.map((c) => c.processId).sort()).toEqual(["core.category.create", "core.party.create", "core.product.create"]);
  });

  it("a module the company is not entitled to disappears with its items (rule 4)", () => {
    const entitled = new Set([...all.entitled].filter((k) => k !== "module:core"));
    expect(buildShellNav(registry, { ...all, entitled })).toEqual({ modules: [], nav: [], creates: [] });
  });

  it("an item whose feature is not entitled is hidden", () => {
    const entitled = new Set([...all.entitled].filter((k) => k !== "feature:core.products"));
    const shell = buildShellNav(registry, { ...all, entitled });
    expect(shell.nav.map((i) => i.href)).toEqual(["/parties", "/import"]);
    expect(shell.creates.map((c) => c.processId)).toEqual(["core.party.create"]);
  });

  it("an item naming a process shows only to callers who may run it (Importar datos: kernel.import.run)", () => {
    expect(keys.processes).toContain("kernel.import.run");
    const runnable = new Set([...all.runnable].filter((p) => p !== "kernel.import.run"));
    expect(buildShellNav(registry, { ...all, runnable }).nav.map((i) => i.href)).toEqual(["/parties", "/products", "/categories"]);
  });

  it("an item is hidden when no role of the caller may run any process of its feature; creates need their own grant", () => {
    const runnable = new Set(["core.party.consult"]);
    const shell = buildShellNav(registry, { ...all, runnable });
    expect(shell.nav.map((i) => i.href)).toEqual(["/parties"]);
    expect(shell.creates).toEqual([]);
  });
});
