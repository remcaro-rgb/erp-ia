import { describe, expect, it } from "vitest";
import { defineEntity } from "../../registry/entities";
import { defineProcess } from "../../process/define";
import { loadModules } from "../../module/loader";
import { defineModule } from "../../module/define";
import { Registry } from "../../registry";
import { z } from "zod";
import { consultProcessesOf } from "../access";

// A `query` entity (accounting design §4.16) is read through `<entity>.list`: no create process, no table of its own.

const consult = (id: string) =>
  defineProcess({ id, module: "probe", kind: "consult", input: z.object({}), output: z.object({}), description: "x", handler: async () => ({}) });

describe("query entities", () => {
  it("defineEntity keeps kind and a query entity's grid consult is <entity>.list", () => {
    const entity = { id: "probe.line", module: "probe", schema: "probe", table: "lines", label: "entity.probe.line", displayField: "number", defaultSort: { field: "number", dir: "asc" as const }, kind: "query" as const, fields: [{ name: "number", type: "text" as const, label: "field.probe.line.number" }] };
    expect(defineEntity(entity).kind).toBe("query");
    const registry = new Registry();
    loadModules(registry, [defineModule({ id: "probe", version: "0", dependsOn: [], entities: [entity], processes: [consult("probe.line.list"), consult("probe.line.consult")], features: [], events: { emits: [], consumes: {} }, navigation: [] })]);
    expect(consultProcessesOf(registry, registry.entity("probe.line"))).toEqual(["probe.line.list", "probe.line.consult"]);
  });

  it("a table entity still resolves <entity>.consult", () => {
    const entity = { id: "probe.row", module: "probe", schema: "probe", table: "rows", label: "entity.probe.row", entityType: "maestro" as const, displayField: "name", defaultSort: { field: "name", dir: "asc" as const }, fields: [{ name: "name", type: "text" as const, label: "field.probe.row.name" }] };
    const registry = new Registry();
    loadModules(registry, [defineModule({ id: "probe", version: "0", dependsOn: [], entities: [entity], processes: [consult("probe.row.consult"), consult("probe.row.list")], features: [], events: { emits: [], consumes: {} }, navigation: [] })]);
    expect(consultProcessesOf(registry, registry.entity("probe.row"))).toEqual(["probe.row.consult"]);
  });
});
