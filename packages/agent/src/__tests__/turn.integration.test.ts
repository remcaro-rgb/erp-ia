import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import type { UIMessageChunk } from "ai";
import { FakeEmbedder, setHelpEmbedder, type Caller } from "@erp/kernel";
import { messages } from "@erp/i18n";
import { checkTokenBudget } from "../runtime/limits";
import { setAgentModelFactory } from "../runtime/policy-model";
import { toUIMessageStream } from "../runtime/stream";
import { agentTurn } from "../runtime/turn.workflow";
import { agentHarness, exito, type AgentHarness } from "./harness";
import { scriptedModel, systemOf, type ScriptedModel } from "./mock-model";

// A turn of the assistant under the Workflow runtime (@workflow/vitest runs `start(agentTurn, …)` in-process), with
// the AI SDK mock model in place of the gateway: what the turn route starts (design §7.1, rules 17, 26, 27).

const budgetText = ((messages("es-419").errors as Record<string, string>).ai_budget_exceeded)!;

async function uiChunks(run: { getReadable: () => ReadableStream<unknown> }): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = toUIMessageStream(run.getReadable() as never).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}
const textOf = (chunks: UIMessageChunk[]) => chunks.flatMap((c) => (c.type === "text-delta" ? [c.delta] : [])).join("");

describe("agentTurn", () => {
  let h: AgentHarness;
  let admin: Caller;
  let mock: ScriptedModel;
  const models: string[] = [];

  const use = (script: Parameters<typeof scriptedModel>[0]) => {
    mock = scriptedModel(script);
    setAgentModelFactory((modelId) => {
      models.push(modelId);
      return mock.model;
    });
  };

  beforeAll(async () => {
    h = await agentHarness();
    admin = h.admin;
    setHelpEmbedder(new FakeEmbedder());
    for (let i = 1; i <= 3; i++) {
      await h.sql`insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
                  values (${h.companyId}, ${["customer"]}, '1', '31', ${String(700000000 + i)}, ${`Cliente ${i}`}, 'complete')`;
    }
    // A company help note the turn's help search finds for a question about returns.
    const [vector] = await new FakeEmbedder().embed(["política de devoluciones de mercancía"]);
    await h.sql`insert into kernel.help_chunks (scope, company_id, source, title, body, embedding, locale)
                values ('company', ${h.companyId}, 'company:devoluciones', 'Devoluciones de mercancía', 'Política de devoluciones de mercancía: 30 días con factura.',
                        ${`[${vector!.join(",")}]`}::extensions.vector, 'es-419')`;
  });
  afterEach(() => setAgentModelFactory(undefined));
  afterAll(async () => {
    setHelpEmbedder(undefined);
    await h.cleanup();
  });

  it("a turn streams text, persists messages and logs usage", async () => {
    use([{ tool: "data__query", input: { entity: "core.party" } }, { text: "Hay 3 clientes." }]);
    const conversationId = await h.conversation(admin);
    const run = await start(agentTurn, [{ conversationId, caller: admin, userText: "¿cuántos clientes hay?" }]);
    await run.returnValue;

    expect(textOf(await uiChunks(run))).toContain("Hay 3 clientes.");
    expect((await h.sql`select count(*)::int as n from kernel.agent_messages where conversation_id = ${conversationId}`)[0]!.n).toBe(2);
    const [assistant] = await h.sql<{ parts: { role: string; content: unknown }[] }[]>`
      select parts from kernel.agent_messages where conversation_id = ${conversationId} and role = 'assistant'`;
    expect(JSON.stringify(assistant!.parts)).toContain("Cliente 1");
    expect((await h.sql`select sum(input_tokens)::int as t from kernel.llm_usage where conversation_id = ${conversationId}`)[0]!.t).toBeGreaterThan(0);
    const chat = await h.sql`select task, model, provider, input_tokens, output_tokens, cached_tokens, user_id from kernel.llm_usage where conversation_id = ${conversationId} and task = 'chat' order by step_number`;
    expect(chat).toHaveLength(2);
    // Metered under the model that answered (after a gateway fallback, the fallback): here the mock.
    expect(chat[0]).toMatchObject({ model: "mock/model", provider: "mock", input_tokens: 50, output_tokens: 12, cached_tokens: 10, user_id: admin.claims.sub });
    // The model comes from the policy table (rule 26): the factory was asked for the chat policy's primary.
    expect(models.at(-1)).toBe("anthropic/claude-opus-5.5");
  });

  it("the system prompt carries the company, the user and the help chunks for the question; the help embedding is metered", async () => {
    use([{ text: "30 días con factura." }]);
    const conversationId = await h.conversation(admin);
    const run = await start(agentTurn, [{ conversationId, caller: admin, userText: "¿cuál es la política de devoluciones de mercancía?", screen: { route: "/parties" } }]);
    await run.returnValue;
    const system = systemOf(mock.calls[0]!);
    expect(system).toContain("Café del Norte S.A.S.");
    expect(system).toContain("Ana Gómez");
    expect(system).toContain("Devoluciones de mercancía");
    expect(system).toContain("/parties");
    const [usage] = await h.sql`select count(*)::int as n from kernel.llm_usage where conversation_id = ${conversationId} and task = 'embeddings'`;
    expect(usage!.n).toBe(1);
    // The tools the model saw are the caller's: registry-generated plus the built-ins.
    const names = (mock.calls[0]!.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["core__party__create", "data__query", "kernel__help__search"]));
  });

  it("a write the model asks for becomes a confirmation card; nothing is created", async () => {
    use([{ tool: "core__party__create", input: { ...exito, documentNumber: "811222333" } }, { text: "Te dejé la tarjeta para confirmar." }]);
    const conversationId = await h.conversation(admin);
    const run = await start(agentTurn, [{ conversationId, caller: admin, userText: "crea el cliente Éxito" }]);
    await run.returnValue;
    const chunks = await uiChunks(run);
    const output = chunks.find((c) => c.type === "tool-output-available") as { output: { confirmationRequired: boolean; token: string } } | undefined;
    expect(output?.output).toMatchObject({ confirmationRequired: true });
    const [card] = await h.sql`select status, conversation_id from kernel.agent_confirmations where token = ${output!.output.token}`;
    expect(card).toMatchObject({ status: "pending", conversation_id: conversationId });
    expect((await h.sql`select count(*)::int as n from core.parties where company_id = ${h.companyId} and document_number = '811222333'`)[0]!.n).toBe(0);
  });

  it("a turn on another user's conversation does nothing", async () => {
    use([{ text: "no debería responder" }]);
    const conversationId = await h.conversation(admin);
    const run = await start(agentTurn, [{ conversationId, caller: h.cashier, userText: "hola" }]);
    await run.returnValue;
    expect(mock.calls).toHaveLength(0);
    expect((await h.sql`select count(*)::int as n from kernel.agent_messages where conversation_id = ${conversationId}`)[0]!.n).toBe(0);
  });

  it("checkTokenBudget counts this calendar month's tokens in the company's time zone", async () => {
    const before = await checkTokenBudget(h.sql, h.companyId);
    expect(before.limit).toBeNull();
    // One row the minute before this month began in Bogotá (last month there), one the minute after.
    await h.sql`insert into kernel.llm_usage(company_id, task, provider, model, input_tokens, output_tokens, created_at) values
      (${h.companyId}, 'chat', 'mock', 'mock/model', 1000, 0, (date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota') - interval '1 minute'),
      (${h.companyId}, 'chat', 'mock', 'mock/model', 7, 3, (date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota') + interval '1 minute')`;
    expect((await checkTokenBudget(h.sql, h.companyId)).used).toBe(before.used + 10);
  });

  it("over the monthly token limit the turn makes no model call", async () => {
    use([{ text: "no debería responder" }]);
    await h.sql`insert into kernel.tenant_entitlements(tenant_id, company_id, key, limit_value, source) values (${h.tenantId}, ${h.companyId}, 'limit:ai_tokens_month', 10, 'manual')`;
    try {
      await h.sql`insert into kernel.llm_usage(company_id, task, provider, model, input_tokens, output_tokens) values (${h.companyId}, 'chat', 'mock', 'mock/model', 11, 0)`;
      expect(await checkTokenBudget(h.sql, h.companyId)).toMatchObject({ allowed: false, limit: 10 });
      const conversationId = await h.conversation(admin);
      const run = await start(agentTurn, [{ conversationId, caller: admin, userText: "¿cuántos clientes hay?" }]);
      await run.returnValue;
      expect(mock.calls).toHaveLength(0);
      expect(textOf(await uiChunks(run))).toBe(budgetText);
      const rows = await h.sql<{ role: string; parts: unknown }[]>`select role, parts from kernel.agent_messages where conversation_id = ${conversationId} order by created_at`;
      expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(rows[1]!.parts)).toContain(budgetText);
      expect((await h.sql`select count(*)::int as n from kernel.llm_usage where conversation_id = ${conversationId}`)[0]!.n).toBe(0);
    } finally {
      await h.sql`delete from kernel.tenant_entitlements where tenant_id = ${h.tenantId} and key = 'limit:ai_tokens_month'`;
    }
  });
});
