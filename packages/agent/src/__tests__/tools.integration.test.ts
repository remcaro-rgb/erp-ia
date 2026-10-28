import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "@erp/kernel";
import { buildTools } from "../tools/build";
import { agentHarness, exito, type AgentHarness } from "./harness";

// The tools a caller gets (design §5.4, §7.1, rules 1, 13, 14, 17): one per registered process the caller may run and
// the company is entitled to, none for the rest; consult tools run as the caller; write tools never run, they store a
// confirmation card; data.query reads through the masked views and refuses hidden fields.

type ToolOut = Record<string, unknown>;
const ctx = { toolCallId: "call-1", messages: [] } as never;

describe("buildTools", () => {
  let h: AgentHarness;
  let admin: Caller;
  let cashier: Caller;

  beforeAll(async () => {
    // Entitled to core only: the support module is loaded but the company does not have it.
    h = await agentHarness({ entitlements: ["module:core"] });
    admin = { ...h.admin, conversationId: await h.conversation(h.admin) };
    cashier = { ...h.cashier, conversationId: await h.conversation(h.cashier) };
    await h.sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values
      (${h.companyId}, ${h.cashierRoleId}, 'core.party', 'credit_limit', 'hidden'),
      (${h.companyId}, ${h.cashierRoleId}, 'core.party', 'document_number', 'masked')`;
    for (let i = 1; i <= 3; i++) {
      await h.sql`insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, credit_limit, dian_status)
                  values (${h.companyId}, ${["customer"]}, '1', '31', ${String(800000000 + i)}, ${`Cliente ${i}`}, ${i * 1000}, 'complete')`;
    }
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const run = async (caller: Caller, name: string, input: unknown): Promise<ToolOut> => {
    const tools = await buildTools(h.deps, caller, { registry: h.deps.registry });
    const tool = tools[name];
    if (!tool?.execute) throw new Error(`no tool ${name}`);
    return (await tool.execute(input, ctx)) as ToolOut;
  };

  it("generates one tool per permitted process and none for forbidden or unentitled ones", async () => {
    const cashierTools = Object.keys(await buildTools(h.deps, cashier, { registry: h.deps.registry }));
    expect(cashierTools).toContain("core__party__consult");
    expect(cashierTools).not.toContain("core__party__create");
    expect(cashierTools).not.toContain("kernel__help__search");

    const adminTools = Object.keys(await buildTools(h.deps, admin, { registry: h.deps.registry }));
    expect(adminTools).toEqual(expect.arrayContaining(["core__party__create", "core__party__consult", "kernel__help__search", "kernel__data__query", "ui__navigate", "ui__open_record"]));
    expect(adminTools).not.toContain("data__query");
    // Permitted but not entitled: the support module is not the company's.
    expect(adminTools).not.toContain("support__ticket__create");
    // Permitted and entitled, but never offered in a chat: they need a file or a job only the screen starts.
    expect(adminTools).not.toContain("kernel__export__run");
    expect(adminTools).not.toContain("kernel__import__run");
  });

  it("a write-kind tool returns a confirmation instead of executing", async () => {
    const r = await run(admin, "core__party__create", exito);
    expect(r).toMatchObject({ confirmationRequired: true, preview: { title: expect.any(String), permission: "core.party.create", stepUp: false } });
    expect(typeof r.token).toBe("string");
    expect(typeof r.cardId).toBe("string");
    expect((r.token as string).length).toBeGreaterThanOrEqual(43);
    expect((await h.sql`select count(*)::int as n from core.parties where legal_name = 'Éxito' and company_id = ${h.companyId}`)[0]!.n).toBe(0);
    const [card] = await h.sql`select status, process_id, user_id, conversation_id, input from kernel.agent_confirmations where token = ${r.token as string}`;
    expect(card).toMatchObject({ status: "pending", process_id: "core.party.create", user_id: admin.claims.sub, conversation_id: admin.conversationId, input: exito });
  });

  it("a write tool with invalid input answers invalid_input and stores no card", async () => {
    const before = (await h.sql`select count(*)::int as n from kernel.agent_confirmations where conversation_id = ${admin.conversationId!}`)[0]!.n;
    const r = await run(admin, "core__party__create", { ...exito, documentType: "NIT" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect((await h.sql`select count(*)::int as n from kernel.agent_confirmations where conversation_id = ${admin.conversationId!}`)[0]!.n).toBe(before);
  });

  it("a consult tool runs the process as the caller, audited with origin agent and the conversation", async () => {
    const [party] = await h.sql<{ id: string }[]>`select id from core.parties where company_id = ${h.companyId} and legal_name = 'Cliente 1'`;
    const r = await run(cashier, "core__party__consult", { id: party!.id });
    expect(r).toMatchObject({ id: party!.id, legal_name: "Cliente 1", document_number: null, credit_limit: null });
    const [audit] = await h.sql`select origin, conversation_id, actor_user_id from kernel.audit_log where process_id = 'core.party.consult' and row_id = ${party!.id} order by occurred_at desc limit 1`;
    expect(audit).toMatchObject({ origin: "agent", conversation_id: cashier.conversationId, actor_user_id: cashier.claims.sub });
  });

  it("data.query applies field masks and refuses hidden fields", async () => {
    const r = await run(cashier, "kernel__data__query", { entity: "core.party", sort: [{ field: "legal_name", dir: "asc" }], columns: ["legal_name", "document_number", "credit_limit"] });
    expect(r).toMatchObject({ entity: "core.party", total: 3 });
    const rows = r.rows as Record<string, unknown>[];
    expect(rows.map((row) => row.legal_name)).toEqual(["Cliente 1", "Cliente 2", "Cliente 3"]);
    expect(rows.every((row) => row.document_number === null && row.credit_limit === null)).toBe(true);

    expect(await run(cashier, "kernel__data__query", { entity: "core.party", filters: [{ field: "credit_limit", op: "gt", value: 0 }] })).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "field_hidden", field: "credit_limit" } },
    });
    expect(await run(cashier, "kernel__data__query", { entity: "core.party", sort: [{ field: "document_number", dir: "asc" }] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("data.query without `columns` returns a masked and a hidden field as null (the key stays): the result table decides by the caller's field mode", async () => {
    const r = await run(cashier, "kernel__data__query", { entity: "core.party", limit: 1 });
    const [row] = r.rows as Record<string, unknown>[];
    expect(row).toHaveProperty("document_number", null);
    expect(row).toHaveProperty("credit_limit", null);
    expect(row).toHaveProperty("legal_name", expect.stringMatching(/^Cliente /));
    // The same fields for the admin carry values.
    const [adminRow] = (await run(admin, "kernel__data__query", { entity: "core.party", limit: 1 })).rows as Record<string, unknown>[];
    expect(adminRow!.document_number).not.toBeNull();
  });

  it("data.query is the registered process kernel.data.query: audited with the conversation, behind the role matrix", async () => {
    await run(cashier, "kernel__data__query", { entity: "core.party", limit: 1 });
    const [audit] = await h.sql`select origin, conversation_id, action from kernel.audit_log where process_id = 'kernel.data.query' and actor_user_id = ${cashier.claims.sub} order by occurred_at desc limit 1`;
    expect(audit).toMatchObject({ origin: "agent", conversation_id: cashier.conversationId, action: "consult" });
    await h.sql`delete from kernel.process_permissions where role_id = ${h.cashierRoleId} and process_id = 'kernel.data.query'`;
    try {
      expect(Object.keys(await buildTools(h.deps, cashier, { registry: h.deps.registry }))).not.toContain("kernel__data__query");
    } finally {
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${h.cashierRoleId}, 'kernel.data.query')`;
    }
  });

  it("data.query's tool names the entities the caller may consult, so the model does not guess", async () => {
    const cashierTools = await buildTools(h.deps, cashier, { registry: h.deps.registry });
    expect(cashierTools.kernel__data__query!.description).toContain("core.party");
    expect(cashierTools.kernel__data__query!.description).not.toContain("core.product");
    const adminTools = await buildTools(h.deps, admin, { registry: h.deps.registry });
    expect(adminTools.kernel__data__query!.description).toContain("core.product");
  });

  it("data.query caps the rows it returns and refuses an entity the caller may not consult", async () => {
    const r = await run(admin, "kernel__data__query", { entity: "core.party", limit: 2 });
    expect((r.rows as unknown[]).length).toBe(2);
    expect(r).toMatchObject({ total: 3, truncated: true });
    expect(await run(admin, "kernel__data__query", { entity: "core.party", limit: 51 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await run(cashier, "kernel__data__query", { entity: "core.product" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("ui tools only point at the app's own screens", async () => {
    expect(await run(admin, "ui__navigate", { href: "/parties" })).toEqual({ action: "navigate", href: "/parties" });
    expect(await run(admin, "ui__navigate", { href: "https://evil.example" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const id = "0190d8b2-1c1e-7000-8000-000000000000";
    expect(await run(admin, "ui__open_record", { entity: "core.party", id })).toEqual({ action: "open_record", href: `/r/core.party/${id}` });
  });
});
