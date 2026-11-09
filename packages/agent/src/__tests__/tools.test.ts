import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineEntity, defineProcess, kernelModule, loadModules, registerCountryPack, Registry } from "@erp/kernel";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { BUILTIN_TOOLS, runBuiltin } from "../tools/builtin";
import { toolSet } from "../tools/build";
import { capResult, MAX_RESULT_BYTES, scrubTokens } from "../tools/cap";
import { EXCLUDED_PROCESSES, inputJsonSchema, processIdOfTool, processToolDescriptors, toolName } from "../tools/from-registry";
import { buildPreview } from "../runtime/preview";
import type { ToolDescriptor } from "../tools/descriptor";

// Tool generation from the registry (design §5.4, §7.1, rule 1): names, schemas, the processes the assistant is never
// offered and the confirmation card's preview. The suites against the database (who gets which tool, what a write
// tool does) are tools.integration.test.ts.

const registry = new Registry();
loadModules(registry, [kernelModule, core, support]);
registerCountryPack(co);

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

describe("ui__open_record", () => {
  const deps = { registry, sql: undefined as never };
  const id = "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";

  it("opens a record where every link to it leads (rule 21): a user under Administración › Usuarios, a party in its frame", async () => {
    expect(await runBuiltin(deps, "ui__open_record", { entity: "kernel.user", id })).toEqual({ action: "open_record", href: `/admin/users/${id}` });
    expect(await runBuiltin(deps, "ui__open_record", { entity: "core.party", id })).toEqual({ action: "open_record", href: `/r/core.party/${id}` });
    expect(await runBuiltin(deps, "ui__open_record", { entity: "support.ticket", id })).toEqual({ action: "open_record", href: `/r/support.ticket/${id}` });
  });

  it("refuses an entity whose records have no page of their own", async () => {
    expect(await runBuiltin(deps, "ui__open_record", { entity: "core.price_list", id })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
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
  it("leaves out what needs a file, a job or a sign-out the chat cannot handle, each with its reason", () => {
    expect([...EXCLUDED_PROCESSES.keys()].sort()).toEqual([
      "accounting.posting_mode.set",
      "invoicing.dian_checklist.tick",
      "invoicing.dian_defaults.confirm",
      "kernel.admin.nested_run.depth.set",
      "kernel.admin.nested_run.pair.set",
      "kernel.admin.user.mfa.set",
      "kernel.admin.user.password.reset",
      "kernel.attachment.add",
      "kernel.export.run",
      "kernel.import.preview",
      "kernel.import.run",
      "kernel.nested_failure.dismiss",
      "kernel.nested_failure.retry",
      "kernel.user.mfa.disable",
      "kernel.user.password.change",
      "payments.payment.open_invoices",
    ]);
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
      country: "CO",
    });
    expect(preview.title).toBe(def.description);
    expect(preview.permission).toBe("core.party.create");
    expect(preview.stepUp).toBe(false);
    expect(preview.effects).toEqual(
      expect.arrayContaining([
        { label: "Razón social", value: "Éxito" },
        { label: "Número de documento", value: "900373115" },
        { label: "Responsabilidades fiscales", value: "R-99-PN · No responsable · no aplica" },
      ]),
    );
  });

  it("shows values by their labels, never the raw codes: enums from the catalogue, fiscal codes from the country pack (code kept)", () => {
    const def = registry.process("core.party.create");
    const input = def.input.parse({
      kind: ["customer", "supplier"],
      personType: "1",
      documentType: "31",
      documentNumber: "900373115",
      legalName: "Éxito",
      taxResponsibilities: ["O-13", "R-99-PN"],
      taxScheme: "ZZ",
      countryCode: "CO",
      departmentCode: "05",
      municipalityCode: "05001",
    });
    const preview = buildPreview(registry, def, input, { locale: "es-419", stepUp: false, country: "CO" });
    const value = (label: string) => preview.effects.find((e) => e.label === label)?.value;
    expect(value("Tipo de tercero")).toBe("Cliente, Proveedor");
    expect(value("Tipo de persona")).toBe("Jurídica");
    expect(value("Tipo de documento")).toBe("31 · NIT");
    expect(value("Régimen tributario")).toBe("ZZ · No aplica");
    expect(value("País")).toBe("Colombia");
    expect(value("Departamento")).toBe("Antioquia");
    expect(value("Municipio")).toBe("Medellín");
    expect(value("Responsabilidades fiscales")).toBe("O-13 · Gran contribuyente, R-99-PN · No responsable · no aplica");
    // Free text and numbers stay as typed.
    expect(value("Número de documento")).toBe("900373115");
    // A code the pack does not know stays as it is; in English the catalogue's words.
    const en = buildPreview(registry, def, { ...(input as Record<string, unknown>), municipalityCode: "99999" }, { locale: "en", stepUp: false, country: "CO" });
    expect(en.effects.find((e) => e.value.startsWith("Customer"))?.value).toBe("Customer, Supplier");
    expect(en.effects.map((e) => e.value)).toContain("99999");
    expect(en.effects.map((e) => e.value)).toContain("Legal entity");
  });

  it("reads a date and time in the company's zone and money as $ 1.234.567,00 (the shared label helper)", () => {
    const local = new Registry();
    local.registerEntity(
      defineEntity({
        entityType: "maestro", id: "test.visit",
        module: "test",
        schema: "test",
        table: "visits",
        label: "entity.test.visit",
        displayField: "at",
        defaultSort: { field: "at", dir: "asc" },
        fields: [
          { name: "at", type: "datetime", label: "field.test.visit.at" },
          { name: "fee", type: "money", label: "field.test.visit.fee" },
        ],
      }),
    );
    const def = defineProcess({ id: "test.visit.create", module: "test", kind: "create", description: "Agenda una visita", input: z.object({ at: z.string(), fee: z.number() }), output: z.object({}), handler: async () => ({}) });
    local.registerProcess(def);
    const preview = buildPreview(local, def, { at: "2026-10-29T15:30:00Z", fee: 1234567 }, { locale: "es-419", stepUp: false, timeZone: "America/Bogota" });
    expect(preview.effects).toEqual([
      { label: "at", value: "2026/10/29 10:30" },
      { label: "fee", value: "$ 1.234.567,00" },
    ]);
  });

  it("prints money in the input's currency: USD 12.500,00, not $ (task 34.2, item 129)", () => {
    const local = new Registry();
    local.registerEntity(
      defineEntity({
        entityType: "maestro", id: "test.charge",
        module: "test",
        schema: "test",
        table: "charges",
        label: "entity.test.charge",
        displayField: "fee",
        defaultSort: { field: "fee", dir: "asc" },
        fields: [
          { name: "fee", type: "money", label: "field.test.charge.fee" },
          { name: "currency", type: "text", label: "field.test.charge.currency" },
        ],
      }),
    );
    const def = defineProcess({ id: "test.charge.create", module: "test", kind: "create", description: "Cobra", input: z.object({ fee: z.number(), currency: z.string() }), output: z.object({}), handler: async () => ({}) });
    local.registerProcess(def);
    const usd = buildPreview(local, def, { fee: 12500, currency: "USD" }, { locale: "es-419", stepUp: false });
    expect(usd.effects).toContainEqual({ label: "fee", value: "USD 12.500,00" });
    expect(usd.effects.map((e) => e.value).join(" ")).not.toContain("$");
    const cop = buildPreview(local, def, { fee: 12500, currency: "COP" }, { locale: "es-419", stepUp: false });
    expect(cop.effects).toContainEqual({ label: "fee", value: "$ 12.500,00" });
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

describe("process origins", () => {
  it("agent tool descriptors omit processes with origins", async () => {
    const only = new Registry();
    only.registerProcess(
      defineProcess({
        id: "test.event.only",
        module: "test",
        kind: "update",
        description: "solo desde eventos",
        origins: ["event"],
        input: z.object({}),
        output: z.object({}),
        handler: async () => ({}),
      }),
    );
    // No process is left to ask the database about: a process with origins never reaches the role check.
    const caller = { claims: {} as never, origin: "agent" } as const;
    expect(await processToolDescriptors({ sql: {} as never, registry: only }, caller, only)).toEqual([]);
  });
});
