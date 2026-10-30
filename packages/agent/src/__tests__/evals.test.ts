import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GridState, kernelModule, loadModules, Registry, type ProcessDef } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { EXCLUDED_PROCESSES, inputJsonSchema, toolName } from "../tools/from-registry";

// The evaluation set (rule 30, design §7.1): Spanish prompts → the tool call the assistant must make. The model is not
// called here (no network in CI); this suite keeps the set honest against the registry the tools are generated from: the
// expected process exists and the assistant is offered it, a write expects a confirmation card, and the expected input only
// names fields, enum values and entities the process and the registry really have. A renamed process, field or enum value
// fails here before it silently breaks the assistant.

interface EvalCase {
  id: string;
  prompt: string;
  expect: { process: string; confirmation?: boolean; input?: Record<string, unknown> };
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "evals");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const cases: EvalCase[] = files.flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { cases: EvalCase[] }).cases);

const registry = new Registry();
loadModules(registry, [kernelModule, core, support, accounting]);

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; additionalProperties?: unknown };

/** Problems of `value` against `schema`, as a subset: every key named must exist; required keys need not be given. */
function problems(value: unknown, schema: Schema | undefined, path: string): string[] {
  if (schema === undefined) return [];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`];
  if (Array.isArray(value)) return schema.items ? value.flatMap((v, i) => problems(v, schema.items, `${path}[${i}]`)) : [];
  if (value !== null && typeof value === "object") {
    const properties = schema.properties;
    if (!properties) return [];
    return Object.entries(value).flatMap(([key, v]) =>
      key in properties ? problems(v, properties[key], `${path}.${key}`) : schema.additionalProperties === false || schema.additionalProperties === undefined ? [`${path}.${key}: unknown input`] : [],
    );
  }
  const type = typeof value === "number" && schema.type === "integer" ? "integer" : typeof value;
  if (schema.type && !["object", "array"].includes(schema.type) && schema.type !== type && !(schema.type === "number" && type === "integer")) return [`${path}: expected ${schema.type}, got ${type}`];
  return [];
}

describe("evaluation set", () => {
  it("has the five accounting prompts of the plan, in Spanish, with unique ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.prompt)).size).toBe(cases.length);
    for (const c of cases) expect(c.prompt, c.id).toMatch(/[a-záéíóúñ]/i);
    expect(cases.map((c) => c.prompt)).toEqual(
      expect.arrayContaining([
        "¿cuánto vendimos en septiembre por centro de costo?",
        "registra la provisión de arriendo de octubre por $ 2.500.000",
        "¿qué pasó contablemente con la factura FE-1234?",
        "¿quién me debe más de 90 días?",
        "gastos de octubre por centro de costo",
      ]),
    );
  });

  describe.each(cases)("$id", (c) => {
    const process: ProcessDef | undefined = registry.processes().find((p) => p.id === c.expect.process);

    it("expects a registered process the assistant is offered, under a provider-safe tool name", () => {
      expect(process, `${c.expect.process} is not registered`).toBeDefined();
      expect(process!.origins, "event-only processes are never tools").toBeUndefined();
      expect(EXCLUDED_PROCESSES.has(process!.id)).toBe(false);
      expect(toolName(process!.id)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    });

    it("a write expects a confirmation card and a consult does not (rule 17)", () => {
      expect(Boolean(c.expect.confirmation)).toBe(process!.kind !== "consult");
    });

    it("names only inputs, enum values and types the process accepts", () => {
      expect(problems(c.expect.input ?? {}, inputJsonSchema(process!.input) as Schema, "input")).toEqual([]);
    });

    if (c.expect.process === "kernel.data.query") {
      it("queries an entity with fields, operators and grouping the grid really has", () => {
        const input = c.expect.input as { entity: string; filters?: { field: string }[]; sort?: { field: string }[]; groupBy?: string[]; aggregates?: { field: string }[] };
        const entity = registry.entities().find((e) => e.id === input.entity);
        expect(entity, `${input.entity} is not an entity`).toBeDefined();
        const fields = new Map(entity!.fields.map((f) => [f.name, f]));
        const named = [...(input.filters ?? []), ...(input.sort ?? []), ...(input.aggregates ?? [])].map((x) => x.field).concat(input.groupBy ?? []);
        expect(named.filter((n) => !fields.has(n))).toEqual([]);
        for (const a of input.aggregates ?? []) expect(["money", "number"], a.field).toContain(fields.get(a.field)!.type);
        expect((input.groupBy ?? []).length).toBeLessThanOrEqual(3);
        expect(process!.input.safeParse(input).success).toBe(true);
        expect(GridState.safeParse({ filters: input.filters ?? [], sort: input.sort ?? [], page: 1, pageSize: 20, groupBy: input.groupBy, aggregates: input.aggregates }).success).toBe(true);
      });
    }
  });
});
