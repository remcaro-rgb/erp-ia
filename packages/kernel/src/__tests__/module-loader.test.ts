import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineEntity } from "../registry";
import { Registry } from "../registry";
import { defineProcess } from "../process/define";
import { defineModule, type ModuleDef } from "../module/define";
import { loadModules } from "../module/loader";
import { ConsumerRegistry } from "../events/consumers";
import { matrixProcesses } from "../admin/matrix";

const entity = (module: string, name: string) =>
  defineEntity({
    id: `${module}.${name}`,
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
  navigation: [{ id: `${id}.home`, label: "nav.home", href: `/${id}`, icon: "box" }],
  ...overrides,
});

describe("defineModule", () => {
  it("returns a valid manifest unchanged", () => {
    const def = manifest("core");
    expect(defineModule(def)).toBe(def);
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

  it("registers each module's entities and processes", () => {
    const registry = new Registry();
    loadModules(registry, [manifest("b", ["a"]), manifest("a")]);
    expect(registry.entities().map((e) => e.id)).toEqual(["a.thing", "b.thing"]);
    expect(registry.processes({ module: "b" }).map((p) => p.id)).toEqual(["b.thing.list"]);
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
      expect(matrixProcesses(registry).map((p) => p.id)).toEqual(["a.thing.list"]);
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
