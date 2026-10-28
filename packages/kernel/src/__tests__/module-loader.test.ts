import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineEntity } from "../registry";
import { Registry } from "../registry";
import { defineProcess } from "../process/define";
import { defineModule, type ModuleDef } from "../module/define";
import { loadModules } from "../module/loader";

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
});
