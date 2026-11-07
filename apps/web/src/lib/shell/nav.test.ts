import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, defineProcess, flattenNav, kernelModule, loadModules, menuSections, Registry, type NavItem } from "@erp/kernel";
import { core } from "@erp/module-core";
import { accounting } from "@erp/module-accounting";
import { crm } from "@erp/module-crm";
import { sales } from "@erp/module-sales";
import { buildShellNav, shellAccessKeys } from "./nav";

// What the shell offers a caller (design §19a, rule 4, rule 13): modules the company is entitled to, menu items
// whose feature is entitled and readable by one of the caller's roles, and the create processes they may run.

const registry = new Registry();
loadModules(registry, [kernelModule, core]);
const keys = shellAccessKeys(registry);
const all = { entitled: new Set(keys.entitlements), runnable: new Set(keys.processes) };
/** The screens of the non-platform items, sections opened (the order the bar and its menus show them). */
const hrefs = (nav: NavItem[]) => flattenNav(nav.filter((i) => !i.id.startsWith("kernel."))).map((i) => i.href);
/** The ids of the non-platform level-1 items with, for a group, its children's ids. */
const tree = (nav: NavItem[]) => nav.filter((i) => !i.id.startsWith("kernel.")).map((i) => (i.children ? [i.id, i.children.map((c) => c.id)] : i.id));

describe("buildShellNav", () => {
  it("asks for the module and feature entitlements and every process behind a menu item", () => {
    expect(keys.entitlements).toEqual(expect.arrayContaining(["module:core", "feature:core.parties", "feature:core.products"]));
    expect(keys.processes).toEqual(expect.arrayContaining(["core.party.consult", "core.party.create", "core.category.create"]));
  });

  it("with everything granted: the core module, its four sections and Importar, its three create commands, then Sistema", () => {
    const shell = buildShellNav(registry, all);
    // The kernel is the platform: always entitled, listed after the modules (the first carries Inicio).
    expect(shell.modules).toEqual([
      { id: "core", label: "nav.modules.core", icon: "database" },
      { id: "kernel", label: "nav.modules.kernel", icon: "settings" },
    ]);
    // Entity types spec §2.4, §9.2: the level-1 items are the four sections; the maestros place themselves under Maestros.
    expect(tree(shell.nav)).toEqual([
      ["core.maestros", ["core.parties", "core.products", "core.categories"]],
      ["core.documentos", []],
      ["core.reportes", []],
      // The kernel's Parámetros screens of the module's maestros (Task 16), for whoever may run their admin processes.
      ["core.parametros", ["core.entity_types", "core.state_recipients", "core.doc_templates"]],
      "core.import",
    ]);
    expect(hrefs(shell.nav)).toEqual(["/parties", "/products", "/categories", "/core/parametros/tipos", "/core/parametros/destinatarios", "/core/parametros/plantillas", "/import"]);
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
    expect(admin.modules).toEqual([{ id: "kernel", label: "nav.modules.kernel", icon: "settings" }]);
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
      "/admin/menu-access",
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
    expect(hrefs(shell.nav)).toEqual(["/parties", "/core/parametros/tipos", "/core/parametros/destinatarios", "/core/parametros/plantillas", "/import"]);
    expect(shell.creates.map((c) => c.processId)).toEqual(["core.party.create"]);
  });

  it("an item naming a process shows only to callers who may run it (Importar datos: kernel.import.run)", () => {
    expect(keys.processes).toContain("kernel.import.run");
    const runnable = new Set([...all.runnable].filter((p) => p !== "kernel.import.run" && !p.startsWith("kernel.")));
    expect(hrefs(buildShellNav(registry, { ...all, runnable }).nav)).toEqual(["/parties", "/products", "/categories"]);
  });

  it("an item is hidden when no role of the caller may run any process of its feature; creates need their own grant", () => {
    const runnable = new Set(["core.party.consult"]);
    const shell = buildShellNav(registry, { ...all, runnable });
    expect(hrefs(shell.nav)).toEqual(["/parties"]);
    // An empty section stays: the shell shows its empty state.
    expect(tree(shell.nav)).toEqual([["core.maestros", ["core.parties"]], ["core.documentos", []], ["core.reportes", []], ["core.parametros", []]]);
    expect(shell.creates).toEqual([]);
  });

  it("a module none of whose screens the caller may open disappears, its empty sections with it", () => {
    const shell = buildShellNav(registry, { ...all, runnable: new Set(["kernel.audit.consult"]) });
    expect(shell.modules.map((m) => m.id)).toEqual(["kernel"]);
    expect(tree(shell.nav)).toEqual([]);
  });
});

// Menu access (entity types spec §9.2, Task 10): an item the company's rules hide for the caller (kernel.menu_hidden_keys) is dropped
// with its create commands; a hidden section takes its items with it. Rules only narrow: a hidden key never adds an item.
describe("menu access in the shell", () => {
  it("drops a hidden item and its create command, for this caller only", () => {
    const shell = buildShellNav(registry, { ...all, hidden: new Set(["core.products"]) });
    expect(hrefs(shell.nav)).toEqual(["/parties", "/categories", "/core/parametros/tipos", "/core/parametros/destinatarios", "/core/parametros/plantillas", "/import"]);
    expect(shell.creates.map((c) => c.processId).sort()).toEqual(["core.category.create", "core.party.create"]);
    // An admin's hidden set is always empty (kernel.menu_hidden_keys): everything shows.
    expect(hrefs(buildShellNav(registry, { ...all, hidden: new Set() }).nav)).toEqual(["/parties", "/products", "/categories", "/core/parametros/tipos", "/core/parametros/destinatarios", "/core/parametros/plantillas", "/import"]);
  });

  it("a hidden section disappears with every item under it; a hidden level-1 item too", () => {
    const shell = buildShellNav(registry, { ...all, hidden: new Set(["core.maestros"]) });
    expect(tree(shell.nav)).toEqual([["core.documentos", []], ["core.reportes", []], ["core.parametros", ["core.entity_types", "core.state_recipients", "core.doc_templates"]], "core.import"]);
    expect(shell.creates).toEqual([]);
    // Nothing left to open: the module goes, its empty sections with it.
    const none = buildShellNav(registry, { ...all, hidden: new Set(["core.maestros", "core.parametros", "core.import"]) });
    expect(tree(none.nav)).toEqual([]);
    expect(none.modules.map((m) => m.id)).toEqual(["kernel"]);
  });

  it("a hidden key never shows what the role may not open", () => {
    const shell = buildShellNav(registry, { ...all, runnable: new Set(["core.party.consult"]), hidden: new Set(["core.categories"]) });
    expect(hrefs(shell.nav)).toEqual(["/parties"]);
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
    navigation: menuSections("grp", { maestros: [child("alpha"), child("beta")] }),
  }),
]);
const groupedKeys = shellAccessKeys(grouped);
const groupedAll = { entitled: new Set(groupedKeys.entitlements), runnable: new Set(groupedKeys.processes) };

describe("shell nav groups", () => {
  it("asks for the entitlements and processes behind the children of a group", () => {
    expect(groupedKeys.entitlements).toEqual(expect.arrayContaining(["module:grp", "feature:grp.alpha", "feature:grp.beta"]));
    expect(groupedKeys.processes).toEqual(expect.arrayContaining(["grp.alpha.consult", "grp.beta.consult"]));
  });

  it("drops children the caller may not open, keeps an empty section, and drops the module when nothing is left", () => {
    const grp = (shell: ReturnType<typeof buildShellNav>) => shell.nav.filter((i) => i.id.startsWith("grp."));
    expect(grp(buildShellNav(grouped, groupedAll)).map((g) => g.children?.map((c) => c.href))).toEqual([["/alpha", "/beta"], [], [], []]);

    const noBeta = { ...groupedAll, entitled: new Set([...groupedAll.entitled].filter((k) => k !== "feature:grp.beta")) };
    expect(grp(buildShellNav(grouped, noBeta)).map((g) => g.children?.map((c) => c.href))).toEqual([["/alpha"], [], [], []]);

    const none = { ...groupedAll, runnable: new Set([...groupedAll.runnable].filter((p) => !p.startsWith("grp."))) };
    const shell = buildShellNav(grouped, none);
    expect(grp(shell)).toEqual([]);
    expect(shell.modules.map((m) => m.id)).not.toContain("grp");
  });
});

describe("a feature's menu items already listed as group children (UX-OD-1, T1)", () => {
  const reg = new Registry();
  loadModules(reg, [kernelModule, core, accounting]);
  const k = shellAccessKeys(reg);
  const shell = buildShellNav(reg, { entitled: new Set(k.entitlements), runnable: new Set(k.processes) });
  const accountingNav = shell.nav.filter((i) => i.id.startsWith("accounting."));

  it("accounting lists the four sections: the six masters under Maestros, Comprobantes, Movimientos and Informes, Períodos and Reglas contables", () => {
    expect(tree(accountingNav)).toEqual([
      ["accounting.maestros", ["core.parties", "accounting.accounts", "accounting.cost_centers", "accounting.open_auxiliaries", "accounting.items", "accounting.business_units", "accounting.journals", "accounting.entry_templates"]],
      ["accounting.documentos", ["accounting.entries"]],
      ["accounting.reportes", ["accounting.movements", "accounting.reports"]],
      ["accounting.parametros", ["accounting.periods", "accounting.posting", "accounting.entity_types", "accounting.state_recipients", "accounting.doc_templates"]],
    ]);
  });

  it("Terceros (core.parties) sits first in Contabilidad's Maestros, not in Núcleo's (ModuleDef.adopts)", () => {
    const maestros = (id: string) => shell.nav.find((i) => i.id === id)?.children?.map((c) => c.id);
    expect(maestros("core.maestros")).toEqual(["core.products", "core.categories"]);
    expect(maestros("accounting.maestros")?.[0]).toBe("core.parties");
  });

  it("every module has a mark for the side menu", () => {
    expect(shell.modules.map((m) => [m.id, m.icon])).toEqual([["core", "database"], ["accounting", "calculator"], ["kernel", "settings"]]);
  });

  it("every item id of the shell appears once, groups and children together", () => {
    const flat = shell.nav.flatMap((i) => [i, ...(i.children ?? [])]).map((i) => i.id);
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe("⌘K create commands (UX-OD-5, T2)", () => {
  const reg = new Registry();
  loadModules(reg, [kernelModule, core, accounting]);
  const k = shellAccessKeys(reg);
  const { creates } = buildShellNav(reg, { entitled: new Set(k.entitlements), runnable: new Set(k.processes) });

  it("only processes named <module>.<noun>.create are offered: never from_template, reverse or the openings", () => {
    expect(creates.map((c) => c.processId).every((id) => /^[a-z_]+\.[a-z_]+\.create$/.test(id))).toBe(true);
    expect(creates.some((c) => /from_template|reverse|opening|seed/.test(c.processId))).toBe(false);
  });

  it("each command has its own label and its own destination, so the palette never shows three 'Crear comprobante'", () => {
    expect(new Set(creates.map((c) => c.labelKey)).size).toBe(creates.length);
    expect(creates.filter((c) => c.labelKey === "nav.create.accounting.entry")).toHaveLength(1);
  });
});

describe("«Cotizaciones» under Ventas, contributed by CRM (plan 2B Task 42, Ruling R42-1)", () => {
  const reg = new Registry();
  loadModules(reg, [kernelModule, core, sales, crm]);
  const k = shellAccessKeys(reg);
  const full = { entitled: new Set(k.entitlements), runnable: new Set(k.processes) };
  const children = (shell: ReturnType<typeof buildShellNav>, id: string) => shell.nav.find((i) => i.id === id)?.children?.map((c) => [c.id, c.href]);

  it("with crm and sales entitled Ventas › Documentos lists Cotizaciones last and CRM keeps its own", () => {
    const shell = buildShellNav(reg, full);
    expect(children(shell, "sales.documentos")?.at(-1)).toEqual(["crm.quotes_shortcut", "/crm/quotes"]);
    expect(children(shell, "crm.documentos")).toContainEqual(["crm.quotes", "/crm/quotes"]);
    const flat = shell.nav.flatMap((i) => [i, ...(i.children ?? [])]).map((i) => i.id);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("without crm entitled, or without its quotes process runnable, Ventas has no such item", () => {
    const noCrm = { ...full, entitled: new Set([...full.entitled].filter((e) => e !== "module:crm")) };
    expect(children(buildShellNav(reg, noCrm), "sales.documentos")?.map((c) => c[0])).not.toContain("crm.quotes_shortcut");
    const noFeature = { ...full, entitled: new Set([...full.entitled].filter((e) => e !== "feature:crm.quotes")) };
    expect(children(buildShellNav(reg, noFeature), "sales.documentos")?.map((c) => c[0])).not.toContain("crm.quotes_shortcut");
    const noProcess = { ...full, runnable: new Set([...full.runnable].filter((p) => !p.startsWith("crm.quote"))) };
    expect(children(buildShellNav(reg, noProcess), "sales.documentos")?.map((c) => c[0])).not.toContain("crm.quotes_shortcut");
  });

  it("without sales entitled nothing is placed and nothing fails", () => {
    const noSales = { ...full, entitled: new Set([...full.entitled].filter((e) => !e.includes("sales"))) };
    const shell = buildShellNav(reg, noSales);
    expect(shell.nav.some((i) => i.id === "sales.documentos")).toBe(false);
    expect(shell.nav.flatMap((i) => i.children ?? []).some((c) => c.id === "crm.quotes_shortcut")).toBe(false);
  });

  it("a company rule hiding Cotizaciones of CRM hides the shortcut too", () => {
    const shell = buildShellNav(reg, { ...full, hidden: new Set(["crm.quotes"]) });
    expect(children(shell, "sales.documentos")?.map((c) => c[0])).not.toContain("crm.quotes_shortcut");
  });
});
