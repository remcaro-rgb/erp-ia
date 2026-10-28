import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { countryPack } from "@erp/kernel";
import { installedAgentModelFactory, type ModelFactory } from "./policy-model";
import { catalogueOf, message } from "./preview";

// The assistant's model for the end-to-end tests and for a local stack without a gateway key (Task 22): with
// `AGENT_MODEL=mock` the web app installs this factory (`setAgentModelFactory`, apps/web/src/lib/server/runtime.ts), so
// every turn runs for real (workflow, tools as the caller, confirmation cards, metering) with the AI SDK mock model in
// place of the gateway. The real gateway runs only when AGENT_MODEL is unset (and AI_GATEWAY_API_KEY is set).
//
// It answers like a well-behaved model, from the user's words and the tools the turn offers:
//   «crea el cliente <nombre>, NIT <número>[-DV]»  → core__party__create with the process's input shape;
//   «busca el cliente <nombre>»                    → kernel__data__query over core.party by name;
//   after a tool result                            → the card is ready / what was found / why it could not;
//   a tool the turn does not offer                 → it says the role does not allow it, and calls nothing (rule 17);
//   anything else                                  → what it can do.
// Its words come from the catalogue of the user's language (the system prompt's "Idioma" line). A NIT typed with its
// DV is checked by the company's country pack (the prompt's "País" line, rule 5): a mismatch is refused in the pack's
// words, a match is dropped (the process stores the number without DV).
//
// It is a test double: a production server refuses it unless ALLOW_MOCK_MODEL=1 (the Docker test stack), and the turns
// it answers are metered as `mock/agent` (provider `mock`, no cost), never as the policy's model.

/** The model id the mock's calls are metered under (kernel prices `mock/…` at zero). */
export const MOCK_AGENT_MODEL = "mock/agent";
const MOCK_FACTORY = Symbol.for("erp.agent.mockModelFactory");

const USAGE = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: undefined },
  outputTokens: { total: 12, text: 12, reasoning: undefined },
};

const CREATE = /\b(?:crea|crear|create)\s+(?:(?:el|la|un|una|a|the)\s+)?(cliente|proveedor|tercero|customer|supplier|party)\s+(.+?)\s*,?\s+(?:con\s+|with\s+)?NIT\s+([\d.]+)(?:\s*-\s*(\d+))?\s*[.!]*$/i;
const SEARCH = /\b(?:busca|buscar|consulta|encuentra|find|search)\s+(?:(?:el|la|los|las|the)\s+)?(?:cliente|clientes|proveedor|proveedores|tercero|terceros|customer|customers|supplier|suppliers|party|parties)\s+(.+?)\s*[?.!]*$/i;

const PARTY_CREATE = "core__party__create";
const DATA_QUERY = "kernel__data__query";

type Answer = { text: string } | { tool: string; input: unknown };

function words(locale: string, key: string, params: Record<string, string | number> = {}): string {
  const template = message(catalogueOf(locale), `agent.mock.${key}`) ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("")
      : "";

/** The turn's facts the answer depends on: the user's language, their last words, the tool result after them. */
function read(prompt: LanguageModelV4Prompt) {
  const system = prompt.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const locale = /- Idioma: ([A-Za-z-]+)/.exec(system)?.[1] ?? "es-419";
  const country = /- País: ([A-Z]{2})/.exec(system)?.[1];
  const lastUser = prompt.map((m) => m.role).lastIndexOf("user");
  const said = lastUser >= 0 ? textOf(prompt[lastUser]!.content).trim() : "";
  const after = prompt.slice(lastUser + 1);
  const results = after.flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result") : []));
  return { locale, country, said, result: results.at(-1) };
}

/** A tool result's value: the JSON it carries (text parsed when it is JSON). */
function valueOf(output: { type: string; value?: unknown } | undefined): unknown {
  if (!output) return undefined;
  if (output.type === "json" || output.type === "error-json") return output.value;
  if (typeof output.value === "string") {
    try {
      return JSON.parse(output.value);
    } catch {
      return output.value;
    }
  }
  return output.value;
}

function answer(options: LanguageModelV4CallOptions): Answer {
  const { locale, country, said, result } = read(options.prompt);
  const offered = new Set((options.tools ?? []).flatMap((t) => (t.type === "function" ? [t.name] : [])));

  if (result) {
    const value = valueOf(result.output as { type: string; value?: unknown }) as Record<string, unknown> | undefined;
    if (value && value.confirmationRequired === true) return { text: words(locale, "card_ready") };
    if (value && value.ok === false) {
      const error = value.error as { code?: string; message?: string } | undefined;
      return { text: words(locale, "refused", { reason: error?.message ?? error?.code ?? "" }) };
    }
    if (value && Array.isArray(value.rows)) return { text: words(locale, "found", { total: Number(value.total ?? value.rows.length) }) };
    return { text: words(locale, "card_ready") };
  }

  const create = CREATE.exec(said);
  if (create) {
    if (!offered.has(PARTY_CREATE)) return { text: words(locale, "not_permitted_create") };
    const kind = /proveedor|supplier/i.test(create[1]!) ? "supplier" : "customer";
    let documentNumber = create[3]!.replaceAll(".", "");
    if (create[4] !== undefined && country) {
      // The typed DV goes to the company's pack, which owns the rule (validateTaxId: "number-DV").
      const checked = packOf(country)?.validateTaxId(`${documentNumber}-${create[4]}`, "31");
      if (checked && !checked.ok) return { text: words(locale, "refused", { reason: checked.reason }) };
      if (checked?.ok) documentNumber = checked.normalized;
    }
    return {
      tool: PARTY_CREATE,
      input: {
        kind: [kind],
        personType: "1",
        documentType: "31",
        documentNumber,
        legalName: create[2]!.trim(),
        taxResponsibilities: ["R-99-PN"],
        taxScheme: "ZZ",
        countryCode: "CO",
      },
    };
  }
  const search = SEARCH.exec(said);
  if (search) {
    if (!offered.has(DATA_QUERY)) return { text: words(locale, "not_permitted_query") };
    return { tool: DATA_QUERY, input: { entity: "core.party", filters: [{ field: "legal_name", op: "contains", value: search[1]!.trim() }], limit: 20 } };
  }
  return { text: words(locale, "fallback") };
}

/** The registered pack of `country`, or none (the DV then goes unchecked here; the process derives it). */
function packOf(country: string) {
  try {
    return countryPack(country);
  } catch {
    return undefined;
  }
}

/** The scripted mock answering for `modelId` (the policy's model: it is what the turn meters). */
export function mockAgentModel(modelId: string): LanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doStream: async (options) => {
      const reply = answer(options);
      const id = `mock-${calls++}`;
      const head: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id, modelId, timestamp: new Date() },
      ];
      const body: LanguageModelV4StreamPart[] =
        "text" in reply
          ? [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: reply.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
            ]
          : [
              { type: "tool-call", toolCallId: `${id}-call`, toolName: reply.tool, input: JSON.stringify(reply.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
            ];
      return { stream: convertArrayToReadableStream([...head, ...body]) };
    },
  });
}

/**
 * The model factory the environment asks for: the mock with `AGENT_MODEL=mock`, else none (the AI Gateway, which needs
 * AI_GATEWAY_API_KEY). A production server (NODE_ENV=production) refuses the mock unless ALLOW_MOCK_MODEL=1: a real
 * deployment must never answer its users with a test double.
 */
export function agentModelFactory(env: Record<string, string | undefined>): ModelFactory | undefined {
  if (env.AGENT_MODEL !== "mock") return undefined;
  if (env.NODE_ENV === "production" && env.ALLOW_MOCK_MODEL !== "1") {
    throw new Error("AGENT_MODEL=mock is a test double and this is a production server: unset AGENT_MODEL, or set ALLOW_MOCK_MODEL=1 on a test stack");
  }
  const factory: ModelFactory = (modelId) => mockAgentModel(modelId);
  return Object.assign(factory, { [MOCK_FACTORY]: true });
}

/** Whether the installed model factory is this mock (its turns are metered as MOCK_AGENT_MODEL). */
export function isMockAgentModelInstalled(): boolean {
  const factory = installedAgentModelFactory() as (ModelFactory & { [MOCK_FACTORY]?: boolean }) | undefined;
  return factory?.[MOCK_FACTORY] === true;
}
