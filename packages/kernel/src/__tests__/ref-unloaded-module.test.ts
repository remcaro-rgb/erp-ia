import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEntity, Registry, type EntityDef, type FieldDef } from "../registry";
import { defineProcess } from "../process/define";
import type { ModuleDef } from "../module/define";
import { loadModules } from "../module/loader";
import { menuSections } from "../module/menu";
import { assertReferencesUsable, type TypedRecord } from "../typed/runner";
import type { ProcessContext } from "../process/context";
import { resolveReferences } from "../import/validate";
import type { ImportColumn } from "../import/columns";
import type { ImportRecord } from "../import/map";
import type { Caller } from "../process/context";
import type { RunProcessDeps } from "../process/run";

// Plan 2B Task 53.2 (items 105, 67): a `ref` to an entity of a module that is not loaded is an optional neighbour's. The maestro
// usability gate and the import's name → id resolution skip it (the raw id stays usable, the cell keeps its text); a ref to an entity
// of a loaded module that the registry does not know still fails closed, and loadModules refuses it at startup.

const ref = (name: string, entity: string, display = "name"): FieldDef => ({ name, type: "ref", label: `field.${name}`, ref: { entity, display } });

const maestro = (module: string, name: string, fields: FieldDef[] = []): EntityDef => ({
  entityType: "maestro",
  id: `${module}.${name}`,
  module,
  schema: module,
  table: `${name}s`,
  label: `entity.${module}.${name}`,
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [{ name: "name", type: "text", label: "field.name" }, ...fields],
});

const manifest = (id: string, entities: EntityDef[], dependsOn: string[] = []): ModuleDef => ({
  id,
  version: "1",
  dependsOn,
  entities,
  processes: [defineProcess({ id: `${id}.thing.list`, module: id, kind: "consult", description: "prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) })],
  features: [{ id: `${id}.things`, label: "feature.things", processes: [`${id}.thing.list`], entities: entities.map((e) => e.id) }],
  events: { emits: [], consumes: {} },
  navigation: [...menuSections(id), { id: `${id}.home`, label: "nav.home", href: `/${id}`, icon: "box" }],
});

/** A transaction stand-in that records each query's text and answers every one with `rows`. */
const fakeTx = (rows: unknown[] = []) => {
  const queries: string[] = [];
  const tx = ((first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first) && "raw" in first) {
      queries.push((first as string[]).join("?"));
      const answer = Promise.resolve((first as string[]).join("").includes("set_config") ? [] : rows);
      return Object.assign(answer, { execute: () => answer });
    }
    return { identifier: first, values };
  }) as unknown as ProcessContext["tx"];
  return { tx, queries };
};

describe("maestro usability gate: refs to an unloaded module (Task 53.2)", () => {
  const registry = new Registry();
  loadModules(registry, [manifest("a", [maestro("a", "thing"), maestro("a", "doc", [ref("thing_id", "a.thing"), ref("ghost_id", "ghost.thing")])])]);
  const doc = registry.entity("a.doc");
  const record = { id: "00000000-0000-7000-8000-000000000001", status: "draft", ghost_id: "00000000-0000-7000-8000-0000000000aa" } as TypedRecord;

  it("skips a ref whose target module is not loaded: no throw and no usability query", async () => {
    const { tx, queries } = fakeTx();
    await expect(assertReferencesUsable({ registry, tx } as unknown as ProcessContext, doc, record)).resolves.toBeUndefined();
    expect(queries).toHaveLength(0);
  });

  it("still gates a ref to a maestro of a loaded module", async () => {
    const { tx, queries } = fakeTx([{ readable: true, usable: false, allowed: true }]);
    const withThing = { ...record, thing_id: "00000000-0000-7000-8000-0000000000bb" } as TypedRecord;
    await expect(assertReferencesUsable({ registry, tx } as unknown as ProcessContext, doc, withThing)).rejects.toMatchObject({ code: "maestro_not_usable", details: { field: "thing_id", entity: "a.thing" } });
    expect(queries).toHaveLength(1);
  });

  it("still throws for a ref to an entity a loaded module does not declare (fail closed)", async () => {
    const loose = new Registry();
    loadModules(loose, [manifest("a", [maestro("a", "thing")])]);
    // Registered behind loadModules' back, so the load-time check does not stop it first.
    loose.registerEntity(defineEntity(maestro("b", "doc", [ref("typo_id", "a.thng")])));
    const { tx } = fakeTx();
    await expect(assertReferencesUsable({ registry: loose, tx } as unknown as ProcessContext, loose.entity("b.doc"), { ...record, typo_id: record.id } as TypedRecord)).rejects.toThrow(/unknown entity: a\.thng/);
  });
});

describe("loadModules: the target of every ref of a loaded module must exist (Task 53.2)", () => {
  it("throws when a ref names an entity its loaded module does not declare", () => {
    const a = manifest("a", [maestro("a", "thing")]);
    const b = manifest("b", [maestro("b", "doc", [ref("thing_id", "a.thng")])], ["a"]);
    expect(() => loadModules(new Registry(), [a, b])).toThrow("entity b.doc, field thing_id: ref a.thng is not an entity of module a");
  });

  it("checks a target module already in the registry, and registers nothing when it throws", () => {
    const registry = new Registry();
    loadModules(registry, [manifest("a", [maestro("a", "thing")])]);
    expect(() => loadModules(registry, [manifest("b", [maestro("b", "doc", [ref("thing_id", "a.gone")])], ["a"])])).toThrow(/ref a\.gone is not an entity of module a/);
    expect(registry.hasModule("b")).toBe(false);
    expect(() => registry.entity("b.doc")).toThrow(/unknown entity/);
  });

  it("checks a ref within the module itself", () => {
    expect(() => loadModules(new Registry(), [manifest("a", [maestro("a", "thing", [ref("parent_id", "a.parent")])])])).toThrow(/entity a\.thing, field parent_id: ref a\.parent is not an entity of module a/);
  });

  it("loads a ref to an entity of a module that is not loaded (an optional neighbour), and one to an existing entity", () => {
    const registry = new Registry();
    const a = manifest("a", [maestro("a", "thing")]);
    const b = manifest("b", [maestro("b", "doc", [ref("thing_id", "a.thing"), ref("quote_id", "ghost.quote", "number")])], ["a"]);
    expect(() => loadModules(registry, [a, b])).not.toThrow();
    expect(registry.entity("b.doc").fields.find((f) => f.name === "quote_id")?.ref).toEqual({ entity: "ghost.quote", display: "number" });
  });
});

describe("import name → id resolution: ref columns to an unloaded module (Task 53.2)", () => {
  const registry = new Registry();
  loadModules(registry, [manifest("a", [maestro("a", "thing")])]);
  const caller = { claims: { sub: "00000000-0000-7000-8000-00000000c0de", company_id: "00000000-0000-7000-8000-00000000c0c0" }, origin: "ui" } as unknown as Caller;
  const column = (key: string, entity: string, display = "name"): ImportColumn => ({ key, field: key, label: `field.${key}`, type: "ref", required: false, ref: { entity, display } });
  const row = (input: Record<string, unknown>): ImportRecord => ({ rowNo: 2, raw: {}, input, errors: [] });

  it("skips a column whose target module is not loaded: the cell keeps its text, no lookup, no error", async () => {
    const sql = { begin: async () => { throw new Error("no lookup expected"); } } as unknown as RunProcessDeps["sql"];
    const record = row({ quoteId: "COT-0001" });
    await resolveReferences({ sql, registry }, caller, [column("quoteId", "ghost.quote", "number")], [record]);
    expect(record.input.quoteId).toBe("COT-0001");
    expect(record.errors).toEqual([]);
  });

  it("still resolves a column of a loaded module by name and reports an unknown name", async () => {
    const { tx, queries } = fakeTx([{ id: "00000000-0000-7000-8000-0000000000bb", display: "Café" }]);
    const sql = { begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as RunProcessDeps["sql"];
    const known = row({ thingId: "café", quoteId: "COT-0001" });
    const unknown = row({ thingId: "Té" });
    await resolveReferences({ sql, registry }, caller, [column("thingId", "a.thing"), column("quoteId", "ghost.quote", "number")], [known, unknown]);
    expect(known.input).toEqual({ thingId: "00000000-0000-7000-8000-0000000000bb", quoteId: "COT-0001" });
    expect(known.errors).toEqual([]);
    expect(unknown.errors).toEqual(["thingId: «Té» no existe"]);
    expect(queries.filter((q) => !q.includes("set_config"))).toHaveLength(1);
  });

  it("still throws for a column naming an entity a loaded module does not declare", async () => {
    const { tx } = fakeTx();
    const sql = { begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as RunProcessDeps["sql"];
    await expect(resolveReferences({ sql, registry }, caller, [column("thingId", "a.thng")], [row({ thingId: "Café" })])).rejects.toThrow(/unknown entity: a\.thng/);
  });
});
