import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineEntity } from "../registry";
import { Registry } from "../registry";
import { defineProcess } from "../process/define";
import { defineModule, type ModuleDef } from "../module/define";
import { loadModules } from "../module/loader";
import { ConsumerRegistry } from "../events/consumers";
import { matrixProcesses } from "../admin/matrix";
import { GENERIC_VERBS } from "../typed/processes";
import { KERNEL_PARAMETER_PAGES, MENU_SECTIONS, menuItemsOf, menuSections, uncoveredMenuProcesses, withMenuSections, type ParameterPage } from "../module/menu";
import type { NavItem } from "../registry/types";

const entity = (module: string, name: string) =>
  defineEntity({
    entityType: "maestro", id: `${module}.${name}`,
    module,
    schema: module,
    table: `${name}s`,
    label: `entity.${module}.${name}`,
    displayField: "name",
    defaultSort: { field: "name", dir: "asc" },
    fields: [{ name: "name", type: "text", label: "field.name" }],
  });

const proc = (module: string, name: string, verb: string) =>
  defineProcess({
    id: `${module}.${name}.${verb}`,
    module,
    kind: "consult",
    description: "prueba",
    input: z.object({}),
    output: z.object({}),
    handler: async () => ({}),
  });

/** A small valid manifest: one entity, one process and one feature grouping them. */
const manifest = (id: string, dependsOn: string[] = [], overrides: Partial<ModuleDef> = {}): ModuleDef => ({
  id,
  version: "1",
  dependsOn,
  entities: [entity(id, "thing")],
  processes: [proc(id, "thing", "list")],
  features: [{ id: `${id}.things`, label: "feature.things", processes: [`${id}.thing.list`], entities: [`${id}.thing`] }],
  events: { emits: [], consumes: {} },
  navigation: [...menuSections(id), { id: `${id}.home`, label: "nav.home", href: `/${id}`, icon: "box" }],
  ...overrides,
});

describe("defineModule", () => {
  it("returns a valid manifest unchanged", () => {
    const def = manifest("core");
    expect(defineModule(def)).toBe(def);
  });

  it("card effects (plan 2B Task 25): keyed by an event or one of the module's processes, each a key of the module's own namespace", () => {
    const ok = manifest("stock", [], { effects: { "sales.order.confirmed": ["stock.effects.reserve"], "stock.thing.list": ["stock.effects.list"] } });
    expect(defineModule(ok)).toBe(ok);
    expect(() => defineModule(manifest("stock", [], { effects: { "sales.order.confirmed": ["sales.effects.reserve"] } }))).toThrow(/stock\.effects\.<name>/);
    expect(() => defineModule(manifest("stock", [], { effects: { "stock.thing.unknown": ["stock.effects.x"] } }))).toThrow(/none of its processes or events/);
    expect(() => defineModule(manifest("stock", [], { effects: { confirmed: ["stock.effects.x"] } }))).toThrow(/neither an event nor a process/);
    expect(() => defineModule(manifest("stock", [], { effects: { "sales.order.confirmed": [] } }))).toThrow(/lists no effect/);
  });

  it("rejects a process declared for another module", () => {
    expect(() => defineModule(manifest("core", [], { processes: [proc("sales", "order", "create")] }))).toThrow(
      /process sales\.order\.create.*module "sales".*"core"/,
    );
  });

  it("rejects a feature that lists a process or entity the module does not declare", () => {
    const feature = { id: "core.things", label: "feature.things", processes: [], entities: [] };
    expect(() => defineModule(manifest("core", [], { features: [{ ...feature, processes: ["core.thing.nope"] }] }))).toThrow(
      /feature core\.things.*process core\.thing\.nope/,
    );
    expect(() => defineModule(manifest("core", [], { features: [{ ...feature, entities: ["core.nope"] }] }))).toThrow(
      /feature core\.things.*entity core\.nope/,
    );
  });

  it("rejects duplicate feature ids and a module that depends on itself", () => {
    const feature = { id: "core.things", label: "feature.things", processes: [], entities: [] };
    expect(() => defineModule(manifest("core", [], { features: [feature, feature] }))).toThrow(/duplicate feature core\.things/);
    expect(() => defineModule(manifest("core", ["core"]))).toThrow(/depends on itself/);
  });

  it("accepts a navigation group of one level and rejects a child that has children", () => {
    const leaf = { id: "core.leaf", label: "nav.leaf", href: "/leaf", icon: "list" };
    const group = { id: "core.group", label: "nav.group", href: "#", icon: "list", children: [leaf] };
    expect(() => defineModule(manifest("core", [], { navigation: [group] }))).not.toThrow();
    const nested = { ...group, children: [{ ...leaf, children: [{ ...leaf, id: "core.deep" }] }] };
    expect(() => defineModule(manifest("core", [], { navigation: [nested] }))).toThrow(/core\.leaf.*children/);
    expect(() => defineModule(manifest("core", [], { features: [{ id: "core.things", label: "f", processes: [], entities: [], nav: [nested] }] }))).toThrow(/children/);
  });

  it("rejects a feature menu item that is neither a top-level item nor a group child of the navigation", () => {
    const leaf = { id: "core.leaf", label: "nav.leaf", href: "/leaf", icon: "list" };
    const group = { id: "core.group", label: "nav.group", href: "#", icon: "list", children: [leaf] };
    const feature = { id: "core.things", label: "f", processes: [], entities: [] };
    expect(() => defineModule(manifest("core", [], { navigation: [group], features: [{ ...feature, nav: [leaf] }] }))).not.toThrow();
    expect(() => defineModule(manifest("core", [], { navigation: [group], features: [{ ...feature, nav: [{ ...leaf, id: "core.stray" }] }] }))).toThrow(
      /core\.stray.*neither a top-level item nor a group child/,
    );
  });

  it("rejects a malformed id and a feature outside the module's namespace", () => {
    expect(() => defineModule({ ...manifest("core"), id: "Core" })).toThrow(/invalid module id/);
    const foreign = { id: "sales.things", label: "feature.things", processes: [], entities: [] };
    expect(() => defineModule(manifest("core", [], { features: [foreign] }))).toThrow(/feature sales\.things.*core\./);
  });
});

describe("loadModules", () => {
  it("loads modules in dependency order and rejects cycles", () => {
    const a = defineModule(manifest("a"));
    const b = defineModule(manifest("b", ["a"]));
    const registry = new Registry();
    expect(() => loadModules(registry, [b, a])).not.toThrow();
    expect(registry.modules().map((m) => m.id)).toEqual(["a", "b"]);
    expect(() => loadModules(new Registry(), [{ ...a, dependsOn: ["b"] }, b])).toThrow(/cycle/);
  });

  it("a card effect keyed by a loaded module's event or process must name one it emits or declares (plan 2B Task 25)", () => {
    const sales = manifest("sales", [], { events: { emits: ["sales.order.confirmed"], consumes: {} } });
    const stock = (key: string) => defineModule(manifest("stock", [], { effects: { [key]: ["stock.effects.reserve"] } }));
    expect(() => loadModules(new Registry(), [sales, stock("sales.order.confirmed")])).not.toThrow();
    expect(() => loadModules(new Registry(), [sales, stock("sales.thing.list")])).not.toThrow();
    expect(() => loadModules(new Registry(), [sales, stock("sales.order.confirmd")])).toThrow(/"sales\.order\.confirmd" is no event or process of module sales/);
    // A neighbour that is not loaded is optional: its keys are not checked.
    expect(() => loadModules(new Registry(), [stock("crm.deal.won")])).not.toThrow();
  });

  it("registers each module's entities and processes", () => {
    const registry = new Registry();
    loadModules(registry, [manifest("b", ["a"]), manifest("a")]);
    expect(registry.entities().map((e) => e.id)).toEqual(["a.thing", "b.thing"]);
    // b.thing is a maestro: the loader adds the generic lifecycle processes after the module's own.
    expect(registry.processes({ module: "b" }).map((p) => p.id)).toEqual(["b.thing.list", ...GENERIC_VERBS.map((v) => `b.thing.${v}`)]);
  });

  describe("generic lifecycle processes (entity types spec §5)", () => {
    const typedEntity = (name: string, entityType: "maestro" | "documento" | "lines" | "parametro", typed?: object) =>
      defineEntity({ ...entity("a", name), id: `a.${name}`, table: `${name}s`, entityType, ...(typed ? { typed } : {}) });

    it("registers save/submit/approve/reject/void/delete for each maestro and documento, in the feature listing the entity", () => {
      const registry = new Registry();
      const doc = typedEntity("doc", "documento");
      const line = typedEntity("line", "lines");
      const par = typedEntity("par", "parametro");
      loadModules(registry, [manifest("a", [], { entities: [entity("a", "thing"), doc, line, par], features: [{ id: "a.things", label: "f", processes: ["a.thing.list"], entities: ["a.thing", "a.doc"] }] })]);
      const ids = registry.processes({ module: "a" }).map((p) => p.id);
      for (const e of ["a.thing", "a.doc"]) for (const v of GENERIC_VERBS) expect(ids).toContain(`${e}.${v}`);
      expect(ids.filter((id) => id.startsWith("a.line.") || id.startsWith("a.par."))).toEqual([]);
      const feature = registry.module("a").features[0]!;
      expect(feature.processes).toEqual(["a.thing.list", ...GENERIC_VERBS.map((v) => `a.thing.${v}`), ...GENERIC_VERBS.map((v) => `a.doc.${v}`)]);
      expect(registry.process("a.doc.approve")).toMatchObject({ module: "a", kind: "update", feature: "a.things" });
      expect(registry.process("a.doc.delete").kind).toBe("delete");
      expect(() => defineModule(registry.module("a"))).not.toThrow();
    });

    it("keeps a process the module declares itself under a generic id", () => {
      const own = defineProcess({ id: "a.thing.void", module: "a", kind: "update", description: "propio", input: z.object({}), output: z.object({}), handler: async () => ({}) });
      const registry = new Registry();
      loadModules(registry, [manifest("a", [], { processes: [proc("a", "thing", "list"), own] })]);
      expect(registry.process("a.thing.void").description).toBe("propio");
      expect(registry.processes({ module: "a" }).filter((p) => p.id === "a.thing.void")).toHaveLength(1);
    });

    it("refuses typedHooks for an entity that is not a typed entity of the module, and on_save numbering without a number hook", () => {
      expect(() => loadModules(new Registry(), [manifest("a", [], { typedHooks: { "a.nope": {} } })])).toThrow(/typedHooks names a\.nope/);
      const numbered = typedEntity("doc", "documento", { numbering: "on_save" });
      expect(() => loadModules(new Registry(), [manifest("a", [], { entities: [numbered] })])).toThrow(/a\.doc numbers on_save/);
      expect(() => loadModules(new Registry(), [manifest("a", [], { entities: [numbered], typedHooks: { "a.doc": { number: async () => "1" } } })])).not.toThrow();
    });

    // Task 5 review (fail closed): the generic Grabar writes the columns itself, so a module that validates its own updates must
    // plug that validation into the lifecycle, or the generic save would bypass it.
    it("refuses a typed entity whose module declares its own update process but registers no validate hook", () => {
      const update = (id: string) =>
        defineProcess({ id, module: "a", kind: "update", description: "propio", input: z.object({}), output: z.object({}), handler: async () => ({}) });
      const list = proc("a", "thing", "list");
      expect(() => loadModules(new Registry(), [manifest("a", [], { processes: [list, update("a.thing.update")] })])).toThrow(
        "module a: typed entity a.thing needs a validate hook",
      );
      // A hook without validate is no better.
      expect(() => loadModules(new Registry(), [manifest("a", [], { processes: [list, update("a.thing.update")], typedHooks: { "a.thing": {} } })])).toThrow(
        /a\.thing needs a validate hook/,
      );
      expect(() =>
        loadModules(new Registry(), [manifest("a", [], { processes: [list, update("a.thing.update")], typedHooks: { "a.thing": { validate: async () => {} } } })]),
      ).not.toThrow();
      // The update named after the entity's declared create process (`processIds.create`, e.g. core.category.*) counts too.
      const widget = defineEntity({ ...entity("a", "widget"), processIds: { create: "a.gadget.create" } });
      expect(() => loadModules(new Registry(), [manifest("a", [], { entities: [entity("a", "thing"), widget], processes: [list, update("a.gadget.update")] })])).toThrow(
        "module a: typed entity a.widget needs a validate hook",
      );
      // Without an update process of its own the generic save is the only write path: nothing to plug in.
      expect(() => loadModules(new Registry(), [manifest("a", [], { processes: [list] })])).not.toThrow();
      // Lines and parametro entities carry no lifecycle, so their update processes need no hook.
      const par = defineEntity({ ...entity("a", "par"), entityType: "parametro" });
      expect(() => loadModules(new Registry(), [manifest("a", [], { entities: [entity("a", "thing"), par], processes: [list, update("a.par.update")] })])).not.toThrow();
    });
  });

  it("throws on a missing dependency, naming it", () => {
    expect(() => loadModules(new Registry(), [manifest("b", ["a"])])).toThrow("missing dependency: a");
  });

  it("registers nothing when loading fails", () => {
    const registry = new Registry();
    expect(() => loadModules(registry, [manifest("c", ["b"]), manifest("b", ["a"])])).toThrow(/missing dependency: a/);
    expect(registry.modules()).toEqual([]);
    expect(registry.entities()).toEqual([]);
  });

  it("rejects a duplicate module id", () => {
    expect(() => loadModules(new Registry(), [manifest("a"), manifest("a")])).toThrow(/duplicate module a/);
  });

  it("rejects an entity whose declared create or attach process no module declares, registering nothing", () => {
    const withIds = (processIds: { create?: string; attach?: string }) =>
      manifest("a", [], { entities: [{ ...entity("a", "thing"), processIds }] });
    const registry = new Registry();
    expect(() => loadModules(registry, [withIds({ create: "a.thing.add" })])).toThrow("entity a.thing: unknown create process a.thing.add");
    expect(() => loadModules(registry, [withIds({ attach: "b.thing.run" })])).toThrow("entity a.thing: unknown attach process b.thing.run");
    expect(registry.modules()).toEqual([]);
    loadModules(registry, [withIds({ create: "a.thing.list" })]);
    expect(registry.entity("a.thing").processIds).toEqual({ create: "a.thing.list" });
  });

  describe("home KPI providers", () => {
    const provider = (id: string, feature: string) => ({ id, feature, compute: async () => [] });

    it("registers each module's providers in the registry, in load order", () => {
      const registry = new Registry();
      loadModules(registry, [
        manifest("b", ["a"], { homeKpis: [provider("b.count", "b.things")] }),
        manifest("a", [], { homeKpis: [provider("a.first", "a.things"), provider("a.second", "a.things")] }),
      ]);
      expect(registry.kpiProviders().map((p) => p.id)).toEqual(["a.first", "a.second", "b.count"]);
    });

    it("rejects a provider id outside the module's namespace, or a feature the module does not declare", () => {
      expect(() => defineModule(manifest("a", [], { homeKpis: [provider("b.count", "a.things")] }))).toThrow(/KPI provider b\.count.*"a\.<name>"/);
      expect(() => defineModule(manifest("a", [], { homeKpis: [provider("a.count", "a.nope")] }))).toThrow(/KPI provider a\.count.*feature a\.nope/);
      expect(() => defineModule(manifest("a", [], { homeKpis: [provider("a.count", "a.things"), provider("a.count", "a.things")] }))).toThrow(/duplicate KPI provider a\.count/);
    });

    it("rejects a provider whose consult process no module registers, or that is not a consult, registering nothing", () => {
      const registry = new Registry();
      const typo = manifest("a", [], { homeKpis: [{ ...provider("a.count", "a.things"), consult: "a.thing.lst" }] });
      expect(() => loadModules(registry, [typo])).toThrow(/KPI provider a\.count.*consult process a\.thing\.lst/);
      const notConsult = manifest("a", [], {
        processes: [{ ...proc("a", "thing", "list"), kind: "update" }],
        homeKpis: [{ ...provider("a.count", "a.things"), consult: "a.thing.list" }],
      });
      expect(() => loadModules(registry, [notConsult])).toThrow(/KPI provider a\.count.*not a consult/);
      expect(registry.modules()).toEqual([]);
      expect(registry.kpiProviders()).toEqual([]);
      // A consult of this module, or of one already in the registry, resolves.
      loadModules(registry, [manifest("a", [], { homeKpis: [{ ...provider("a.count", "a.things"), consult: "a.thing.list" }] })]);
      expect(() => loadModules(registry, [manifest("b", ["a"], { homeKpis: [{ ...provider("b.count", "b.things"), consult: "a.thing.list" }] })])).not.toThrow();
    });

    it("refuses two providers with the same id in one registry", () => {
      const registry = new Registry();
      registry.registerKpiProvider(provider("a.count", "a.things"));
      expect(() => registry.registerKpiProvider(provider("a.count", "a.things"))).toThrow(/already registered/);
    });
  });

  describe("origins and wildcard consumers", () => {
    it("sensitive process list omits processes with origins", () => {
      const eventOnly = defineProcess({
        id: "a.thing.event_only",
        module: "a",
        kind: "update",
        description: "prueba",
        origins: ["event"],
        input: z.object({}),
        output: z.object({}),
        handler: async () => ({}),
      });
      const registry = new Registry();
      loadModules(registry, [manifest("a", [], { processes: [proc("a", "thing", "list"), eventOnly] })]);
      expect(matrixProcesses(registry).map((p) => p.id).sort()).toEqual(["a.thing.list", ...GENERIC_VERBS.map((v) => `a.thing.${v}`)].sort());
    });

    it("consumers.for returns the event's consumers first, then the wildcard ones, one per module", () => {
      const consumers = new ConsumerRegistry();
      const noop = async () => {};
      consumers.register("w", "*", noop);
      consumers.register("a", "x.happened", noop);
      consumers.register("b", "*", noop);
      consumers.register("b", "x.happened", noop);
      expect(consumers.for("x.happened").map((c) => c.moduleId)).toEqual(["a", "b", "w"]);
      expect(consumers.for("y.other").map((c) => c.moduleId)).toEqual(["w", "b"]);
      expect(consumers.pairs()).toContainEqual({ event: "*", module_id: "w" });
    });

    it("defineModule accepts '*' as a consumed event", () => {
      expect(() => defineModule(manifest("a", [], { events: { emits: [], consumes: { "*": async () => {} } } }))).not.toThrow();
    });
  });

  describe("recordTabs", () => {
    const grid = { id: "a.entries", label: "tab.entries", forEntities: "*" as const, kind: "grid" as const, feature: "a.things", source: "a.entry_source" };
    const mapping = {
      id: "a.revenue",
      label: "tab.revenue",
      forEntities: ["a.category"],
      kind: "mapping" as const,
      feature: "a.things",
      dimension: "category:{id}",
      roles: ["revenue"],
      lookupEntity: "a.account",
      saveProcess: "a.mapping.update",
    };

    it("registers recordTabs and resolves them for '*' and for named entities", () => {
      const registry = new Registry();
      loadModules(registry, [manifest("a", [], { recordTabs: [grid, mapping] })]);
      expect(registry.recordTabsFor("a.category").map((c) => c.id)).toEqual(["a.entries", "a.revenue"]);
      expect(registry.recordTabsFor("core.party").map((c) => c.id)).toEqual(["a.entries"]);
      expect(new Registry().recordTabsFor("core.party")).toEqual([]);
    });

    it("refuses a mapping contribution without roles or saveProcess", () => {
      const bad = (override: object) => manifest("a", [], { recordTabs: [{ ...mapping, ...override }] });
      expect(() => defineModule(bad({ roles: undefined }))).toThrow(/mapping contribution a\.revenue/);
      expect(() => defineModule(bad({ roles: [] }))).toThrow(/mapping contribution a\.revenue/);
      expect(() => defineModule(bad({ saveProcess: undefined }))).toThrow(/mapping contribution a\.revenue/);
      expect(() => defineModule(bad({ lookupEntity: undefined }))).toThrow(/mapping contribution a\.revenue/);
      expect(() => defineModule(bad({ dimension: undefined }))).toThrow(/mapping contribution a\.revenue/);
      expect(() => defineModule(manifest("a", [], { recordTabs: [mapping] }))).not.toThrow();
    });

    it("refuses a grid contribution without a source, and ids or features outside the module", () => {
      expect(() => defineModule(manifest("a", [], { recordTabs: [{ ...grid, source: undefined }] }))).toThrow(/grid contribution a\.entries/);
      expect(() => defineModule(manifest("a", [], { recordTabs: [{ ...grid, id: "b.entries" }] }))).toThrow(/record tab b\.entries.*"a\.<name>"/);
      expect(() => defineModule(manifest("a", [], { recordTabs: [{ ...grid, feature: "a.nope" }] }))).toThrow(/record tab a\.entries.*feature a\.nope/);
      expect(() => defineModule(manifest("a", [], { recordTabs: [grid, grid] }))).toThrow(/duplicate record tab a\.entries/);
    });
  });
});

// Module menu sections (entity types spec 2026-11-02 §2.4, §9.2; Phase 2A.5 Task 10): every module with a menu has the level-1 groups
// Maestros, Documentos, Reportes and Parámetros (`<module>.maestros|documentos|reportes|parametros`); the list page of a maestro,
// documento or parametro places itself in its section; an empty section stays (the shell shows its empty state).
describe("menu sections", () => {
  const leaf = (id: string, extra: Partial<NavItem> = {}): NavItem => ({ id, label: `nav.${id}`, href: `/${id.replace(".", "/")}`, icon: "list", ...extra });
  const typed = (name: string, entityType: "maestro" | "documento" | "parametro" | "lines" | "sistema") =>
    defineEntity({ ...entity("a", name), id: `a.${name}`, table: `${name}s`, entityType });
  const sectionIds = (def: ModuleDef) => def.navigation.filter((i) => i.section).map((i) => i.id);
  const childrenOf = (def: ModuleDef, section: string) => def.navigation.find((i) => i.id === `${def.id}.${section}`)?.children?.map((c) => c.id);

  it("menuSections builds the four groups with their kernel labels, in order", () => {
    expect(MENU_SECTIONS).toEqual(["maestros", "documentos", "reportes", "parametros"]);
    const groups = menuSections("a", { reportes: [leaf("a.balance")] });
    expect(groups.map((g) => [g.id, g.label, g.href, g.section])).toEqual([
      ["a.maestros", "nav.section.maestros", "#", "maestros"],
      ["a.documentos", "nav.section.documentos", "#", "documentos"],
      ["a.reportes", "nav.section.reportes", "#", "reportes"],
      ["a.parametros", "nav.section.parametros", "#", "parametros"],
    ]);
    expect(groups.map((g) => g.children?.map((c) => c.id))).toEqual([[], [], ["a.balance"], []]);
  });

  it("the loader throws for a module with a menu that misses a section, naming it", () => {
    const without = (missing: string) => manifest("x", [], { navigation: [...menuSections("x").filter((g) => g.section !== missing), leaf("x.home")] });
    for (const s of MENU_SECTIONS) expect(() => loadModules(new Registry(), [without(s)])).toThrow(`module x: missing menu section ${s}`);
    expect(() => loadModules(new Registry(), [manifest("x", [], { navigation: [leaf("x.home")] })])).toThrow("module x: missing menu section maestros");
    expect(() => loadModules(new Registry(), [manifest("x")])).not.toThrow();
  });

  it("refuses a section group that is not named <module>.<section> or is not a group", () => {
    const groups = menuSections("x");
    const renamed = groups.map((g) => (g.section === "reportes" ? { ...g, id: "x.informes" } : g));
    expect(() => loadModules(new Registry(), [manifest("x", [], { navigation: renamed })])).toThrow("module x: menu section reportes must be the group x.reportes");
    const leafSection = groups.map((g) => (g.section === "reportes" ? { ...g, children: undefined } : g));
    expect(() => loadModules(new Registry(), [manifest("x", [], { navigation: leafSection })])).toThrow("module x: menu section reportes must be the group x.reportes");
  });

  it("a module without any menu item and the platform itself carry no sections", () => {
    expect(() => loadModules(new Registry(), [manifest("x", [], { navigation: [] })])).not.toThrow();
    const kernelLike = manifest("kernel", [], { navigation: [leaf("kernel.admin")] });
    expect(() => loadModules(new Registry(), [kernelLike])).not.toThrow();
  });

  it("places the list page of a maestro, documento or parametro in its section; lines, sistema and other items stay where they are", () => {
    const entities = [typed("thing", "maestro"), typed("doc", "documento"), typed("par", "parametro"), typed("log", "sistema"), typed("line", "lines")];
    const navigation = [
      ...menuSections("a", { maestros: [leaf("a.declared")] }),
      leaf("a.things", { entity: "a.thing" }),
      leaf("a.docs", { entity: "a.doc" }),
      leaf("a.pars", { entity: "a.par" }),
      leaf("a.logs", { entity: "a.log" }),
      leaf("a.tool"),
      leaf("a.summary", { section: "reportes" }),
    ];
    const registry = new Registry();
    loadModules(registry, [manifest("a", [], { entities, navigation, features: [] })]);
    const def = registry.module("a");
    expect(def.navigation.map((i) => i.id)).toEqual(["a.maestros", "a.documentos", "a.reportes", "a.parametros", "a.logs", "a.tool"]);
    expect(childrenOf(def, "maestros")).toEqual(["a.declared", "a.things"]);
    expect(childrenOf(def, "documentos")).toEqual(["a.docs"]);
    expect(childrenOf(def, "reportes")).toEqual(["a.summary"]);
    // The module's own parametro list, then the kernel's Parámetros screens (KERNEL_PARAMETER_PAGES, Task 16).
    expect(childrenOf(def, "parametros")).toEqual(["a.pars", "a.entity_types", "a.state_recipients", "a.doc_templates"]);
    expect(sectionIds(def)).toEqual(["a.maestros", "a.documentos", "a.reportes", "a.parametros"]);
  });

  it("refuses a menu item placed under the wrong section for its entity, or naming an entity of another module", () => {
    const entities = [typed("thing", "maestro"), typed("doc", "documento")];
    const wrong = manifest("a", [], { entities, features: [], navigation: menuSections("a", { documentos: [leaf("a.things", { entity: "a.thing" })] }) });
    expect(() => loadModules(new Registry(), [wrong])).toThrow("module a: menu item a.things lists a.thing (maestro) under documentos, not maestros");
    const foreign = manifest("a", [], { entities, features: [], navigation: [...menuSections("a"), leaf("a.others", { entity: "b.thing" })] });
    expect(() => loadModules(new Registry(), [foreign])).toThrow("module a: menu item a.others names entity b.thing, which the module does not declare");
  });

  it("adds the kernel's Parámetros pages to every module with a maestro or documento (extension point, Task 16)", () => {
    const page: ParameterPage = { name: "entity_types", label: "nav.section.page.entity_types", icon: "settings", process: "kernel.entity_type_settings.update", path: "tipos" };
    const typedModule = manifest("a", [], { entities: [typed("thing", "maestro")] });
    const placed = withMenuSections(typedModule, [page]);
    expect(placed.navigation.find((i) => i.id === "a.parametros")?.children).toEqual([
      { id: "a.entity_types", label: "nav.section.page.entity_types", href: "/a/parametros/tipos", icon: "settings", process: "kernel.entity_type_settings.update" },
    ]);
    const untyped = manifest("b", [], { entities: [typed("par", "parametro")] });
    expect(withMenuSections(untyped, [page]).navigation.find((i) => i.id === "b.parametros")?.children).toEqual([]);
    // The kernel's own screens: types, recipients and templates, each shown to whoever may run its admin process.
    expect(KERNEL_PARAMETER_PAGES.map((p) => [p.path, p.process])).toEqual([
      ["tipos", "kernel.entity_type_settings.update"],
      ["destinatarios", "kernel.state_recipients.update"],
      ["plantillas", "kernel.doc_template.save"],
    ]);
  });

  it("menuItemsOf lists every item with the processes it guards: its entity's (and its lines'), its process and its runs", () => {
    const thing = defineEntity({ ...entity("a", "thing"), typed: { lines: { entity: "a.thing_line", parentField: "thing_id" } } });
    const line = defineEntity({ ...entity("a", "thing_line"), id: "a.thing_line", table: "thing_lines", entityType: "lines" });
    const processes = [proc("a", "thing", "list"), proc("a", "thing_line", "list"), proc("a", "report", "balance"), proc("a", "report", "aging"), proc("a", "other", "list")];
    const navigation = [
      ...menuSections("a", { reportes: [leaf("a.reports", { runs: ["a.report."] })] }),
      leaf("a.things", { entity: "a.thing" }),
      leaf("a.import", { process: "kernel.import.run" }),
    ];
    const registry = new Registry();
    loadModules(registry, [manifest("a", [], { entities: [thing, line], processes, navigation, features: [{ id: "a.things", label: "f", processes: processes.map((p) => p.id), entities: ["a.thing", "a.thing_line"] }] })]);
    const rows = menuItemsOf(registry.module("a"));
    const byKey = new Map(rows.map((r) => [r.navKey, r]));
    expect(rows.map((r) => r.navKey)).toEqual(["a.maestros", "a.things", "a.documentos", "a.reportes", "a.reports", "a.parametros", "a.entity_types", "a.state_recipients", "a.doc_templates", "a.import"]);
    expect(byKey.get("a.maestros")).toEqual({ navKey: "a.maestros", moduleId: "a", parentKey: null, href: null, entity: null, processIds: [] });
    expect(byKey.get("a.things")).toMatchObject({ parentKey: "a.maestros", href: "/a/things", entity: "a.thing" });
    expect(byKey.get("a.things")!.processIds).toEqual(["a.thing.list", "a.thing_line.list", ...GENERIC_VERBS.map((v) => `a.thing.${v}`)].sort());
    expect(byKey.get("a.reports")).toMatchObject({ parentKey: "a.reportes", processIds: ["a.report.aging", "a.report.balance"] });
    // A process of another module (the kernel's import) is shared: hiding the item hides its page only (controller ruling, m3).
    expect(byKey.get("a.import")).toMatchObject({ parentKey: null, processIds: [] });
  });

  it("menuItemsOf also lists the module's processes bound to the item's entity (or its lines') by recordAccess", () => {
    const thing = defineEntity({ ...entity("a", "thing"), typed: { lines: { entity: "a.thing_line", parentField: "thing_id" } } });
    const line = defineEntity({ ...entity("a", "thing_line"), id: "a.thing_line", table: "thing_lines", entityType: "lines" });
    const bound = (id: string, target: string) => ({ ...proc("a", id.split(".")[0]!, id.split(".")[1]!), kind: "update" as const, recordAccess: { entity: target, idField: "id", right: "modify" as const } });
    const processes = [proc("a", "thing", "list"), bound("thing_permission.update", "a.thing"), bound("line_note.update", "a.thing_line"), bound("other_note.update", "a.other")];
    const navigation = [...menuSections("a"), leaf("a.things", { entity: "a.thing" })];
    const registry = new Registry();
    loadModules(registry, [manifest("a", [], { entities: [thing, line], processes, navigation, features: [{ id: "a.things", label: "f", processes: processes.map((p) => p.id), entities: ["a.thing", "a.thing_line"] }] })]);
    const things = menuItemsOf(registry.module("a")).find((r) => r.navKey === "a.things")!;
    expect(things.processIds).toContain("a.thing_permission.update");
    expect(things.processIds).toContain("a.line_note.update");
    expect(things.processIds).not.toContain("a.other_note.update");
  });

  it("uncoveredMenuProcesses lists the processes under no menu item and not declared shared (ids or prefixes ending in '.')", () => {
    const processes = [proc("a", "thing", "list"), proc("a", "report", "balance"), proc("a", "uom", "consult"), proc("a", "sequence", "next"), proc("a", "stray", "list")];
    const navigation = [...menuSections("a", { reportes: [leaf("a.reports", { runs: ["a.report."] })] }), leaf("a.things", { entity: "a.thing" })];
    const def = manifest("a", [], { entities: [entity("a", "thing")], processes, navigation, features: [{ id: "a.f", label: "f", processes: processes.map((p) => p.id), entities: ["a.thing"] }], menuShared: ["a.uom.consult", "a.sequence."] });
    const registry = new Registry();
    loadModules(registry, [def]);
    expect(uncoveredMenuProcesses(registry.module("a"))).toEqual(["a.stray.list"]);
    // A module without a menu has nothing to cover.
    expect(uncoveredMenuProcesses(manifest("b", [], { processes: [proc("b", "x", "list")], navigation: [] }))).toEqual([]);
  });
});

