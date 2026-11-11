import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, type ModuleDef } from "../module/define";
import { loadModules } from "../module/loader";
import { defineProcess } from "../process/define";
import { defineReport } from "../reports";
import { defineEntity, Registry } from "../registry";

// Report definitions (design §9, accounting design §10a.5): a report is kernel infrastructure; a module declares it
// and the kernel runs its consult. A definition that cannot work is refused when the module loads.

const consult = (id: string, kind: "consult" | "create" = "consult") =>
  defineProcess({
    id,
    module: "probe",
    kind,
    feature: "probe.reports",
    description: "prueba",
    input: z.object({ params: z.object({}), state: z.object({}) }),
    output: z.object({ rows: z.array(z.unknown()), total: z.number() }),
    handler: async () => ({ rows: [], total: 0 }),
  });

const report = (overrides: Record<string, unknown> = {}) =>
  defineReport({
    id: "probe.trial",
    module: "probe",
    feature: "probe.reports",
    label: "report.probe.trial",
    params: z.object({ to: z.string() }),
    consult: "probe.trial.consult",
    columns: [
      { field: "code", label: "Código", type: "text", mono: true },
      { field: "balance", label: "Saldo", type: "money", total: "sum" },
    ],
    totals: ["balance"],
    ...overrides,
  } as never);

const manifest = (processes = [consult("probe.trial.consult")], reports = [report()]): ModuleDef => ({
  id: "probe",
  version: "1",
  dependsOn: [],
  entities: [
    defineEntity({ entityType: "maestro", id: "probe.thing", module: "probe", schema: "probe", table: "things", label: "entity.probe.thing", displayField: "name", defaultSort: { field: "name", dir: "asc" }, fields: [{ name: "name", type: "text", label: "field.name" }] }),
  ],
  processes,
  features: [{ id: "probe.reports", label: "feature.reports", processes: processes.map((p) => p.id), entities: ["probe.thing"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  reports,
});

describe("reports", () => {
  it("defineReport refuses a consult that is not a consult process and a totals field that is not a column", () => {
    // A totals field that is not a column fails the definition itself.
    expect(() => report({ totals: ["missing"] })).toThrow(/totals.*missing/);
    expect(() => report({ columns: [] })).toThrow(/column/);
    expect(() => report({ id: "other.trial" })).toThrow(/probe\./);
    expect(() => report({ columns: [{ field: "a", label: "A", type: "text" }, { field: "a", label: "B", type: "text" }], totals: [] })).toThrow(/duplicate/);
    expect(() => report({ totals: ["code"] })).toThrow(/money|number/);

    // The consult is resolved when modules load: it must exist and be a consult process.
    expect(() => loadModules(new Registry(), [manifest([consult("probe.trial.consult", "create")])])).toThrow(/probe\.trial.*not a consult process/);
    expect(() => loadModules(new Registry(), [manifest([consult("probe.other.consult")])])).toThrow(/probe\.trial.*unknown consult process/);
    expect(() => defineModule(manifest([consult("probe.trial.consult")], [report({ feature: "probe.none" })]))).toThrow(/feature probe\.none/);

    const registry = new Registry();
    loadModules(registry, [manifest()]);
    expect(registry.report("probe.trial").consult).toBe("probe.trial.consult");
    expect(registry.reports("probe").map((r) => r.id)).toEqual(["probe.trial"]);
    expect(registry.reports("core")).toEqual([]);
    expect(() => registry.report("probe.nope")).toThrow(/unknown report/);
  });
  it("defineReport refuses a file action whose process is missing, not a consult or of another feature", () => {
    const action = (overrides: Record<string, unknown> = {}) => ({ id: "xml", label: "report.file.probe", process: "probe.trial.file", contentType: "application/xml", contentField: "xml", ...overrides });
    const withAction = (a: Record<string, unknown>) => report({ fileActions: [a] });
    // Shape: a duplicate id is refused by the definition itself.
    expect(() => report({ fileActions: [action(), action()] })).toThrow(/duplicate file action xml/);
    expect(() => withAction(action({ id: "Bad Id" }))).toThrow(/file action/);
    // The process is resolved when modules load: it must exist, be a consult and belong to the report's feature.
    const file = (id: string, kind: "consult" | "create" = "consult", feature = "probe.reports") => ({ ...consult(id, kind), feature });
    expect(() => loadModules(new Registry(), [manifest([consult("probe.trial.consult")], [withAction(action())])])).toThrow(/probe\.trial.*file action xml.*unknown process probe\.trial\.file/);
    expect(() => loadModules(new Registry(), [manifest([consult("probe.trial.consult"), file("probe.trial.file", "create")], [withAction(action())])])).toThrow(/file action xml.*not a consult process/);
    const other = manifest([consult("probe.trial.consult"), file("probe.trial.file", "consult", "probe.other")], [withAction(action())]);
    other.features = [...other.features, { id: "probe.other", label: "feature.other", processes: ["probe.trial.file"], entities: [] }];
    expect(() => loadModules(new Registry(), [other])).toThrow(/file action xml.*feature probe\.other/);
    const registry = new Registry();
    loadModules(registry, [manifest([consult("probe.trial.consult"), file("probe.trial.file")], [withAction(action())])]);
    expect(registry.report("probe.trial").fileActions?.map((a) => a.id)).toEqual(["xml"]);
  });
});
