import { describe, expect, it, vi } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { BUILTIN_TOOLS } from "../tools/builtin";
import { toolSet } from "../tools/build";
import { capResult, MAX_RESULT_BYTES, scrubTokens } from "../tools/cap";
import { EXCLUDED_PROCESSES, inputJsonSchema, processIdOfTool, toolName } from "../tools/from-registry";
import { buildPreview } from "../runtime/preview";
import type { ToolDescriptor } from "../tools/descriptor";

// Tool generation from the registry (design §5.4, §7.1, rule 1): names, schemas, the processes the assistant is never
// offered and the confirmation card's preview. The suites against the database (who gets which tool, what a write
// tool does) are tools.integration.test.ts.

const registry = new Registry();
loadModules(registry, [kernelModule, core, support]);

describe("tool names", () => {
  it("a process id becomes a provider-safe tool name and back", () => {
    expect(toolName("core.party.create")).toBe("core__party__create");
    expect(toolName("kernel.help.search")).toBe("kernel__help__search");
    expect(processIdOfTool("core__party__create")).toBe("core.party.create");
    for (const process of registry.processes()) {
      expect(toolName(process.id)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(processIdOfTool(toolName(process.id))).toBe(process.id);
    }
  });

  it("built-in tools have names no process can take", () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    // data.query is the registered process kernel.data.query (rule 1); only the navigation tools are built in.
    expect(names).toEqual(["ui__navigate", "ui__open_record"]);
    expect(registry.process("kernel.data.query")).toMatchObject({ kind: "consult", module: "kernel", feature: "kernel.data" });
    for (const process of registry.processes()) expect(names).not.toContain(toolName(process.id));
  });
});

describe("input schemas", () => {
  it("every process input becomes a plain JSON schema object, without the draft marker", () => {
    for (const process of registry.processes()) {
      const schema = inputJsonSchema(process.input);
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("$schema");
    }
  });

  it("keeps the Zod constraints the model needs to call core.party.create right", () => {
    const schema = inputJsonSchema(registry.process("core.party.create").input);
    expect(schema.required).toEqual(expect.arrayContaining(["kind", "personType", "documentType", "documentNumber"]));
    expect((schema.properties as Record<string, { enum?: string[] }>).documentType!.enum).toContain("31");
  });
});

describe("excluded processes", () => {
  it("leaves out what needs a file or a job the chat cannot start, each with its reason", () => {
    expect([...EXCLUDED_PROCESSES.keys()].sort()).toEqual(["kernel.attachment.add", "kernel.export.run", "kernel.import.preview", "kernel.import.run"]);
    for (const reason of EXCLUDED_PROCESSES.values()) expect(reason.length).toBeGreaterThan(10);
  });
});

describe("toolSet", () => {
  const descriptors: ToolDescriptor[] = [
    { name: "core__party__consult", description: "Consulta un tercero", inputSchema: { type: "object", properties: { id: { type: "string" } } }, source: { type: "process", processId: "core.party.consult", kind: "consult" } },
    { name: "ui__navigate", description: "Abre una pantalla", inputSchema: { type: "object", properties: { href: { type: "string" } } }, source: { type: "builtin" } },
  ];

  it("one tool per descriptor, with its description, executing through the runner by name", async () => {
    const run = vi.fn(async (name: string, input: unknown) => ({ name, input }));
    const tools = toolSet(descriptors, run);
    expect(Object.keys(tools)).toEqual(["core__party__consult", "ui__navigate"]);
    expect(tools.core__party__consult!.description).toBe("Consulta un tercero");
    const out = await tools.ui__navigate!.execute!({ href: "/parties" }, { toolCallId: "t1", messages: [] } as never);
    expect(out).toEqual({ name: "ui__navigate", input: { href: "/parties" } });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("confirmation preview", () => {
  it("titles the card with the process description and lists the input with the field labels in Spanish", () => {
    const def = registry.process("core.party.create");
    const preview = buildPreview(registry, def, def.input.parse({ kind: ["customer"], personType: "1", documentType: "31", documentNumber: "900373115", legalName: "Éxito", taxResponsibilities: ["R-99-PN"] }), {
      locale: "es-419",
      stepUp: false,
    });
    expect(preview.title).toBe(def.description);
    expect(preview.permission).toBe("core.party.create");
    expect(preview.stepUp).toBe(false);
    expect(preview.effects).toEqual(
      expect.arrayContaining([
        { label: "Razón social", value: "Éxito" },
        { label: "Número de documento", value: "900373115" },
        { label: "Responsabilidades fiscales", value: "R-99-PN" },
      ]),
    );
  });

  it("falls back to the input key when no field label exists, and renders booleans in Spanish", () => {
    const def = registry.process("support.ticket.close");
    const preview = buildPreview(registry, def, { id: "0190d8b2-1c1e-7000-8000-000000000000", urgent: true }, { locale: "es-419", stepUp: true });
    expect(preview.stepUp).toBe(true);
    expect(preview.effects).toContainEqual({ label: "urgent", value: "Sí" });
  });
});

describe("capResult (rule 17: consult results are capped)", () => {
  it("keeps a small result as it is", () => {
    expect(capResult({ id: "x", legal_name: "Éxito" })).toEqual({ id: "x", legal_name: "Éxito" });
  });

  it("cuts a rows result to 50 rows and to the byte budget, marking it truncated", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ i, text: "x".repeat(500) }));
    const out = capResult({ entity: "core.party", rows, total: 80 }) as { rows: unknown[]; total: number; truncated: boolean };
    expect(out.rows.length).toBeLessThanOrEqual(50);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(80);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it("cuts any other large value to the byte budget with a marker", () => {
    const out = capResult({ blob: "y".repeat(40_000) }) as { truncated: boolean; preview: string };
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RESULT_BYTES + 200);
    const list = capResult(Array.from({ length: 120 }, (_, i) => i)) as { truncated: boolean; items: number[] };
    expect(list).toMatchObject({ truncated: true });
    expect(list.items).toHaveLength(50);
  });
});

describe("scrubTokens", () => {
  it("removes the confirmation token from stored tool results, keeping the card id", () => {
    const messages = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "core__party__create", output: { type: "json", value: { confirmationRequired: true, token: "secret-token", cardId: "card-1", preview: {} } } }] },
    ];
    const clean = scrubTokens(messages);
    expect(JSON.stringify(clean)).not.toContain("secret-token");
    expect(JSON.stringify(clean)).toContain("card-1");
  });
});
