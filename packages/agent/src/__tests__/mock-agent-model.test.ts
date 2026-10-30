import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerCountryPack } from "@erp/kernel";
import { co } from "@erp/loc-co";
import { agentModelFactory, isMockAgentModelInstalled, MOCK_AGENT_MODEL, mockAgentModel } from "../runtime/mock-agent-model";
import { setAgentModelFactory } from "../runtime/policy-model";

// `AGENT_MODEL=mock` (Task 22): the model the app uses for the end-to-end tests and a local stack without a gateway key.
// It is the AI SDK mock model with a scripted answer chosen from the user's words and the tools the turn offers: it
// calls a tool only when the turn offers it (rule 17: the caller's tools are exactly what their roles allow), and says
// so in the user's language when it is not offered.

const SYSTEM = "Eres el asistente del ERP de Café del Norte S.A.S.\n\n## Empresa\n- País: CO · Moneda: COP · Zona horaria: America/Bogota\n\n## Usuario\n- Nombre: Laura\n- Idioma: es-419";
const tool = (name: string) => ({ type: "function" as const, name, description: name, inputSchema: { type: "object" as const, properties: {} } });

function options(prompt: LanguageModelV4Prompt, tools: string[]): LanguageModelV4CallOptions {
  return { prompt, tools: tools.map(tool) } as LanguageModelV4CallOptions;
}
const user = (text: string): LanguageModelV4Prompt => [
  { role: "system", content: SYSTEM },
  { role: "user", content: [{ type: "text", text }] },
];

async function parts(call: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamPart[]> {
  const { stream } = await mockAgentModel("mock/agent").doStream(call);
  const out: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}
const textOf = (out: LanguageModelV4StreamPart[]) => out.flatMap((p) => (p.type === "text-delta" ? [p.delta] : [])).join("");
const callOf = (out: LanguageModelV4StreamPart[]) => out.find((p) => p.type === "tool-call") as { toolName: string; input: string } | undefined;

beforeAll(() => registerCountryPack(co));
afterEach(() => setAgentModelFactory(undefined));

describe("the mock agent model", () => {
  it("creates a party with the core.party.create input shape when the turn offers the tool", async () => {
    const out = await parts(options(user("crea el cliente Panadería La Espiga, NIT 800197268-4"), ["core__party__create", "kernel__data__query"]));
    const call = callOf(out);
    expect(call?.toolName).toBe("core__party__create");
    expect(JSON.parse(call!.input)).toEqual({
      kind: ["customer"],
      personType: "1",
      documentType: "31",
      documentNumber: "800197268",
      legalName: "Panadería La Espiga",
      taxResponsibilities: ["R-99-PN"],
      taxScheme: "ZZ",
      countryCode: "CO",
    });
    expect(out.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });
  });

  it("answers «gastos de octubre por centro de costo» with a grouped query over the ledger lines, and only when the turn offers the tool", async () => {
    const out = await parts(options(user("gastos de octubre por centro de costo"), ["kernel__data__query"]));
    const call = callOf(out);
    expect(call?.toolName).toBe("kernel__data__query");
    const year = new Date().getFullYear();
    expect(JSON.parse(call!.input)).toMatchObject({
      entity: "accounting.ledger_line",
      filters: [{ field: "account_class", op: "eq", value: "5" }, { field: "date", op: "between", value: `${year}-10-01`, value2: `${year}-10-31` }],
      groupBy: ["cost_center_code"],
      aggregates: [{ field: "net", fn: "sum" }],
    });
    expect(callOf(await parts(options(user("gastos de octubre por centro de costo"), [])))).toBeUndefined();
  });

  it("refuses in the user's language when the tool is not offered, and calls nothing", async () => {
    const out = await parts(options(user("crea el proveedor Tostadora Andina, NIT 860002964-4"), ["kernel__data__query"]));
    expect(callOf(out)).toBeUndefined();
    expect(textOf(out)).toMatch(/^Tu rol no te permite crear terceros/);
    const english = await parts(options([{ role: "system", content: SYSTEM.replace("es-419", "en") }, user("crea el cliente X, NIT 800197268")[1]!], []));
    expect(textOf(english)).toMatch(/^Your role does not allow creating parties/);
  });

  it("looks parties up through kernel.data.query by name", async () => {
    const out = await parts(options(user("busca el cliente Éxito"), ["kernel__data__query"]));
    expect(callOf(out)?.toolName).toBe("kernel__data__query");
    expect(JSON.parse(callOf(out)!.input)).toEqual({ entity: "core.party", filters: [{ field: "legal_name", op: "contains", value: "Éxito" }], limit: 20 });
    expect(textOf(await parts(options(user("busca el cliente Éxito"), [])))).toMatch(/^Tu rol no te permite consultar terceros/);
  });

  it("answers after the tool result: the card, the rows found or the refusal", async () => {
    const after = (output: unknown): LanguageModelV4Prompt => [
      ...user("crea el cliente Panadería La Espiga, NIT 800197268-4"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c0", toolName: "core__party__create", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c0", toolName: "core__party__create", output: { type: "json", value: output as never } }] },
    ];
    expect(textOf(await parts(options(after({ confirmationRequired: true, cardId: "x" }), ["core__party__create"])))).toMatch(/pulsa Confirmar/);
    expect(textOf(await parts(options(after({ entity: "core.party", rows: [{}], total: 1 }), [])))).toBe("Encontré 1 resultado(s).");
    expect(textOf(await parts(options(after({ ok: false, error: { code: "forbidden", message: "no" } }), [])))).toBe("No pude hacerlo: no");
  });

  it("explains itself for anything else, and the factory it installs builds it for any model id", async () => {
    expect(textOf(await parts(options(user("hola"), [])))).toMatch(/AGENT_MODEL=mock/);
    expect(agentModelFactory({ AGENT_MODEL: "mock" })?.("anthropic/claude-opus-5.5").provider).toBe("mock");
    expect(agentModelFactory({ AGENT_MODEL: "mock", AI_GATEWAY_API_KEY: "key" })).toBeDefined();
    expect(agentModelFactory({ AI_GATEWAY_API_KEY: "key" })).toBeUndefined();
    expect(agentModelFactory({})).toBeUndefined();
  });

  it("checks a typed DV with the company's country pack: a mismatch is refused in its words, a match is dropped", async () => {
    const wrong = await parts(options(user("crea el cliente Panadería La Espiga, NIT 800197268-9"), ["core__party__create"]));
    expect(callOf(wrong)).toBeUndefined();
    expect(textOf(wrong)).toMatch(/El dígito de verificación no coincide \(para 800197268 es 4\)/);
    const right = await parts(options(user("crea el cliente Panadería La Espiga, NIT 800.197.268-4"), ["core__party__create"]));
    expect(JSON.parse(callOf(right)!.input)).toMatchObject({ documentNumber: "800197268" });
  });

  it("is refused in production unless ALLOW_MOCK_MODEL=1 says so", () => {
    expect(() => agentModelFactory({ AGENT_MODEL: "mock", NODE_ENV: "production" })).toThrow(/ALLOW_MOCK_MODEL=1/);
    expect(agentModelFactory({ AGENT_MODEL: "mock", NODE_ENV: "production", ALLOW_MOCK_MODEL: "1" })).toBeDefined();
    expect(agentModelFactory({ AGENT_MODEL: "mock", NODE_ENV: "development" })).toBeDefined();
    expect(agentModelFactory({ NODE_ENV: "production" })).toBeUndefined();
  });

  it("says when it is the installed model, so its calls are metered as the free mock model", () => {
    expect(MOCK_AGENT_MODEL).toBe("mock/agent");
    expect(isMockAgentModelInstalled()).toBe(false);
    setAgentModelFactory(agentModelFactory({ AGENT_MODEL: "mock" }));
    expect(isMockAgentModelInstalled()).toBe(true);
    setAgentModelFactory((id) => mockAgentModel(id));
    expect(isMockAgentModelInstalled()).toBe(false);
  });
});
