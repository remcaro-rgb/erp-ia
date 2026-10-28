import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { resolveModel } from "../runtime/model-policy";
import { agentHarness, type AgentHarness } from "./harness";

// Migration 0019_kernel_agent (rule 34): the model policy table and its defaults, and who reads the assistant's rows
// (rules 12, 17, 27): a conversation, its messages and its confirmation cards are their user's (and a company
// admin's); usage rows are readable by their user and the admins; nobody signed in writes any of them directly.

describe("0019_kernel_agent", () => {
  let h: AgentHarness;
  let adminConversation: string;
  let cashierConversation: string;

  beforeAll(async () => {
    h = await agentHarness();
    adminConversation = await h.conversation(h.admin);
    cashierConversation = await h.conversation(h.cashier);
    for (const [conversation, caller] of [[adminConversation, h.admin], [cashierConversation, h.cashier]] as const) {
      await h.sql`insert into kernel.agent_messages(company_id, conversation_id, role, parts) values (${h.companyId}, ${conversation}, 'user', ${h.sql.json([{ type: "text", text: "hola" }])})`;
      await h.sql`insert into kernel.agent_confirmations(company_id, conversation_id, user_id, process_id, input, token)
                  values (${h.companyId}, ${conversation}, ${caller.claims.sub}, 'core.party.create', '{}'::jsonb, ${randomBytes(32).toString("base64url")})`;
      await h.sql`insert into kernel.llm_usage(company_id, user_id, conversation_id, task, provider, model, input_tokens, output_tokens)
                  values (${h.companyId}, ${caller.claims.sub}, ${conversation}, 'chat', 'anthropic', 'anthropic/claude-opus-5.5', 10, 5)`;
    }
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const as = <T>(caller: AgentHarness["admin"], fn: Parameters<typeof withClaims<T>>[2]) => withClaims(h.sql, caller.claims, fn);
  const count = (caller: AgentHarness["admin"], view: string) =>
    as(caller, async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from ${tx(`kernel.${view}`)}`)[0]!.n);

  it("seeds a platform policy with a fallback for chat, planning, classification, summaries and embeddings", async () => {
    const rows = await h.sql<{ task: string; primary_model: string; fallbacks: string[] }[]>`
      select task, primary_model, fallbacks from kernel.model_policies where tenant_id is null order by task`;
    expect(Object.fromEntries(rows.map((r) => [r.task, r.primary_model]))).toMatchObject({
      chat: "anthropic/claude-opus-5.5",
      planning: "anthropic/claude-opus-5.5",
      classification: "anthropic/claude-haiku-5.5",
      summarization: "anthropic/claude-haiku-5.5",
      embeddings: "openai/text-embedding-3-small",
    });
    expect(rows.every((r) => r.fallbacks.length >= 1)).toBe(true);
    await expect(h.sql`insert into kernel.model_policies(task, primary_model, fallbacks) values ('chat', 'x/y', '{}')`).rejects.toThrow();
  });

  it("resolveModel takes the tenant's own row over the platform row", async () => {
    expect(await resolveModel(h.sql, h.tenantId, "chat")).toEqual({ primary: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"] });
    await h.sql`insert into kernel.model_policies(tenant_id, task, primary_model, fallbacks) values (${h.tenantId}, 'chat', 'anthropic/claude-sonnet-5.5', array['anthropic/claude-haiku-5.5'])`;
    expect(await resolveModel(h.sql, h.tenantId, "chat")).toEqual({ primary: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-haiku-5.5"] });
    expect(await resolveModel(h.sql, null, "chat")).toEqual({ primary: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"] });
    expect(await resolveModel(h.sql, h.tenantId, "embeddings")).toMatchObject({ primary: "openai/text-embedding-3-small" });
  });

  it("policies are readable by every signed-in user and written only by the service role", async () => {
    expect(await count(h.cashier, "v_model_policies")).toBeGreaterThanOrEqual(5);
    await expect(as(h.admin, (tx) => tx`update kernel.model_policies set primary_model = 'x/y'`)).rejects.toThrow();
    await expect(as(h.admin, (tx) => tx`insert into kernel.model_policies(task, primary_model, fallbacks) values ('extraction', 'x/y', array['x/z'])`)).rejects.toThrow();
  });

  it("a member sees only their own conversations, messages, cards and usage; the company admin sees all of them", async () => {
    for (const view of ["v_agent_conversations", "v_agent_messages", "v_agent_confirmations", "v_llm_usage"]) {
      expect(await count(h.cashier, view)).toBe(1);
      expect(await count(h.admin, view)).toBe(2);
    }
    // The base tables answer the same: the policies, not only the views, decide.
    expect(await as(h.cashier, async (tx) => (await tx<{ id: string }[]>`select id from kernel.agent_conversations`).map((r) => r.id))).toEqual([cashierConversation]);
    expect(await as(h.cashier, async (tx) => (await tx`select id from kernel.agent_messages where conversation_id = ${adminConversation}`).length)).toBe(0);
  });

  it("the confirmation token is not published in the read view", async () => {
    const [row] = await as(h.admin, (tx) => tx`select * from kernel.v_agent_confirmations limit 1`);
    expect(row).not.toHaveProperty("token");
  });

  it("nobody signed in writes conversations, messages or cards, nor usage outside a process", async () => {
    await expect(as(h.cashier, (tx) => tx`insert into kernel.agent_conversations(company_id, user_id) values (${h.companyId}, ${h.cashier.claims.sub})`)).rejects.toThrow();
    await expect(as(h.cashier, (tx) => tx`insert into kernel.agent_messages(company_id, conversation_id, role) values (${h.companyId}, ${cashierConversation}, 'user')`)).rejects.toThrow();
    await expect(as(h.cashier, (tx) => tx`update kernel.agent_confirmations set status = 'executed'`)).rejects.toThrow();
    await expect(
      as(h.cashier, (tx) => tx`insert into kernel.llm_usage(company_id, user_id, task, provider, model) values (${h.companyId}, ${h.cashier.claims.sub}, 'chat', 'x', 'x/y')`),
    ).rejects.toThrow();
  });

  it("a usage row is either a company's or the platform's", async () => {
    await expect(h.sql`insert into kernel.llm_usage(scope, task, provider, model) values ('company', 'chat', 'x', 'x/y')`).rejects.toThrow();
    await expect(h.sql`insert into kernel.llm_usage(scope, company_id, task, provider, model) values ('platform', ${h.companyId}, 'chat', 'x', 'x/y')`).rejects.toThrow();
  });
});
