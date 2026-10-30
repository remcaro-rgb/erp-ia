import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, defineProcess, kernelModule, loadModules, Registry, type NavItem } from "@erp/kernel";
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

  it("with everything granted: the core module, its four items and its three create commands, then Sistema", () => {
    const shell = buildShellNav(registry, all);
    // The kernel is the platform: always entitled, listed after the modules (the first carries Inicio).
    expect(shell.modules).toEqual([
      { id: "core", label: "nav.modules.core" },
      { id: "kernel", label: "nav.modules.kernel" },
    ]);
    expect(shell.nav.filter((i) => !i.id.startsWith("kernel.")).map((i) => i.href)).toEqual(["/parties", "/products", "/categories", "/import"]);
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
    const runnable = new Set([...all.runnable].filter((p) => !p.startsWith("kernel.")));
    expect(buildShellNav(registry, { entitled, runnable })).toEqual({ modules: [], nav: [], creates: [] });
  });

  it("Administración, Auditoría and Uso de IA show to whoever may run their processes, the other admin screens off the bar", () => {
    expect(keys.processes).toEqual(expect.arrayContaining(["kernel.admin.permission.set", "kernel.audit.consult", "kernel.admin.ai_usage.consult"]));
    const admin = buildShellNav(registry, { entitled: new Set(), runnable: new Set(keys.processes.filter((p) => p.startsWith("kernel.") || p === "kernel.custom_field.set")) });
    expect(admin.modules).toEqual([{ id: "kernel", label: "nav.modules.kernel" }]);
    expect(admin.nav.filter((i) => i.menu !== false).map((i) => i.href)).toEqual(["/admin/permissions", "/admin/audit", "/admin/ai-usage"]);
    expect(admin.nav.filter((i) => i.menu === false).map((i) => i.href)).toEqual([
      "/admin/roles",
      "/admin/users",
      "/admin/fields",
      "/admin/extra",
      "/admin/required-files",
      "/admin/sensitive",
      "/admin/verifiers",
      "/admin/modules",
      "/admin/companies",
    ]);
    const onlyUsage = buildShellNav(registry, { entitled: new Set(), runnable: new Set(["kernel.admin.ai_usage.consult"]) });
    expect(onlyUsage.nav.map((i) => i.href)).toEqual(["/admin/ai-usage"]);
    const onlyAudit = buildShellNav(registry, { entitled: new Set(), runnable: new Set(["kernel.audit.consult"]) });
    expect(onlyAudit.nav.map((i) => i.href)).toEqual(["/admin/audit"]);
  });

  it("an item whose feature is not entitled is hidden", () => {
    const entitled = new Set([...all.entitled].filter((k) => k !== "feature:core.products"));
    const shell = buildShellNav(registry, { ...all, entitled });
    expect(shell.nav.filter((i) => !i.id.startsWith("kernel.")).map((i) => i.href)).toEqual(["/parties", "/import"]);
    expect(shell.creates.map((c) => c.processId)).toEqual(["core.party.create"]);
  });

  it("an item naming a process shows only to callers who may run it (Importar datos: kernel.import.run)", () => {
    expect(keys.processes).toContain("kernel.import.run");
    const runnable = new Set([...all.runnable].filter((p) => p !== "kernel.import.run" && !p.startsWith("kernel.")));
    expect(buildShellNav(registry, { ...all, runnable }).nav.map((i) => i.href)).toEqual(["/parties", "/products", "/categories"]);
  });

  it("an item is hidden when no role of the caller may run any process of its feature; creates need their own grant", () => {
    const runnable = new Set(["core.party.consult"]);
    const shell = buildShellNav(registry, { ...all, runnable });
    expect(shell.nav.map((i) => i.href)).toEqual(["/parties"]);
    expect(shell.creates).toEqual([]);
  });
});

// A module whose menu has a group (design §8, §10b.19): `Maestros ▾` with two children, each behind its own feature.
const consult = (name: string) =>
  defineProcess({ id: `grp.${name}.consult`, module: "grp", kind: "consult", description: "prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });
const child = (name: string): NavItem => ({ id: `grp.${name}`, label: `nav.grp.${name}`, href: `/${name}`, icon: "list", feature: `grp.${name}` });
const grouped = new Registry();
loadModules(grouped, [
  kernelModule,
  defineModule({
    id: "grp",
    version: "1",
    dependsOn: [],
    entities: [],
    processes: [consult("alpha"), consult("beta")],
    features: ["alpha", "beta"].map((name) => ({ id: `grp.${name}`, label: `feature.grp.${name}`, processes: [`grp.${name}.consult`], entities: [] })),
    events: { emits: [], consumes: {} },
    navigation: [{ id: "grp.masters", label: "nav.grp.masters", href: "#", icon: "list", children: [child("alpha"), child("beta")] }],
  }),
]);
const groupedKeys = shellAccessKeys(grouped);
const groupedAll = { entitled: new Set(groupedKeys.entitlements), runnable: new Set(groupedKeys.processes) };

describe("shell nav groups", () => {
  it("asks for the entitlements and processes behind the children of a group", () => {
    expect(groupedKeys.entitlements).toEqual(expect.arrayContaining(["module:grp", "feature:grp.alpha", "feature:grp.beta"]));
    expect(groupedKeys.processes).toEqual(expect.arrayContaining(["grp.alpha.consult", "grp.beta.consult"]));
  });

  it("drops children the caller may not open and the group when none is left", () => {
    const grp = (shell: ReturnType<typeof buildShellNav>) => shell.nav.filter((i) => i.id.startsWith("grp."));
    expect(grp(buildShellNav(grouped, groupedAll)).map((g) => g.children?.map((c) => c.href))).toEqual([["/alpha", "/beta"]]);

    const noBeta = { ...groupedAll, entitled: new Set([...groupedAll.entitled].filter((k) => k !== "feature:grp.beta")) };
    expect(grp(buildShellNav(grouped, noBeta)).map((g) => g.children?.map((c) => c.href))).toEqual([["/alpha"]]);

    const none = { ...groupedAll, runnable: new Set([...groupedAll.runnable].filter((p) => !p.startsWith("grp."))) };
    const shell = buildShellNav(grouped, none);
    expect(grp(shell)).toEqual([]);
    expect(shell.modules.map((m) => m.id)).not.toContain("grp");
  });
});
