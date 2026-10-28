import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown, started: [] as { args: unknown[] }[] }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
// The workflow runtime is not under test here (packages/agent runs the turn under @workflow/vitest): `start` records
// what the route started and hands back a run whose stream holds one text part.
vi.mock("workflow/api", () => ({
  start: vi.fn(async (_workflow: unknown, args: unknown[]) => {
    state.started.push({ args });
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", text: "Hola" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.close();
      },
    });
    return { runId: "wrun_test", readable };
  }),
}));

import { loginWithPassword } from "@/lib/auth/login";
import { POST as confirm } from "../confirm/route";
import { POST as turn } from "../turn/route";

// POST /api/agent/turn and POST /api/agent/confirm (design §7.1, rules 12 and 17) against the real stack: the session's
// user starts a turn in their own conversation only, and decides only their own confirmation cards.

let fixture: AuthFixture;
let other: AuthFixture;

const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "member" });
  other = await seedAuthUser({ role: "member" });
  const companyId = fixture.companyIds[0]!;
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
  const [{ id: roleId }] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId!}, 'core.party.create')`;
  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
});

afterAll(async () => {
  const { sql } = fixture;
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from core.parties where company_id = any(${fixture.companyIds}::uuid[])`;
  });
  await sql`delete from core.entity_sequences where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.agent_conversations where company_id = any(${[...fixture.companyIds, ...other.companyIds]}::uuid[])`;
  await sql`delete from kernel.process_idempotency where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.outbox where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
  await fixture.cleanup();
  await other.cleanup();
});

describe("POST /api/agent/turn", () => {
  it("creates the conversation, starts the turn as the session's user and streams UI message chunks with the run id", async () => {
    const response = await post(turn, "/api/agent/turn", { text: "¿Cuántos clientes hay?", screen: { route: "/parties" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-workflow-run-id")).toBe("wrun_test");
    const conversationId = response.headers.get("x-conversation-id")!;
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.text()).toContain('"delta":"Hola"');

    const [args] = state.started.at(-1)!.args as [{ conversationId: string; caller: { claims: { sub: string; active_company_id: string } }; userText: string; screen: unknown }];
    expect(args).toMatchObject({ conversationId, userText: "¿Cuántos clientes hay?", screen: { route: "/parties" } });
    expect(args.caller.claims).toMatchObject({ sub: fixture.userId, active_company_id: fixture.companyIds[0] });
    const [row] = await fixture.sql`select user_id, company_id, title from kernel.agent_conversations where id = ${conversationId}`;
    expect(row).toMatchObject({ user_id: fixture.userId, company_id: fixture.companyIds[0], title: "¿Cuántos clientes hay?" });
  });

  it("refuses another user's conversation, a bad body and a request without a session", async () => {
    const [foreign] = await other.sql<{ id: string }[]>`
      insert into kernel.agent_conversations(company_id, user_id) values (${other.companyIds[0]!}, ${other.userId}) returning id`;
    const started = state.started.length;
    expect((await post(turn, "/api/agent/turn", { conversationId: foreign!.id, text: "hola" })).status).toBe(404);
    expect((await post(turn, "/api/agent/turn", { text: "" })).status).toBe(400);
    expect(state.started.length).toBe(started);
    const jar = state.jar;
    state.jar = new MemoryJar();
    try {
      expect((await post(turn, "/api/agent/turn", { text: "hola" })).status).toBe(401);
    } finally {
      state.jar = jar;
    }
  });
});

describe("POST /api/agent/confirm", () => {
  const card = async (owner: AuthFixture, input: unknown) => {
    const [conversation] = await owner.sql<{ id: string }[]>`
      insert into kernel.agent_conversations(company_id, user_id) values (${owner.companyIds[0]!}, ${owner.userId}) returning id`;
    const token = randomBytes(32).toString("base64url");
    await owner.sql`insert into kernel.agent_confirmations(company_id, conversation_id, user_id, process_id, input, token)
                    values (${owner.companyIds[0]!}, ${conversation!.id}, ${owner.userId}, 'core.party.create', ${owner.sql.json(input as never)}, ${token})`;
    return token;
  };
  const exito = { kind: ["customer"], personType: "1", documentType: "31", documentNumber: "900373115", legalName: "Éxito", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "CO" };

  it("the user's own card can be decided by its id (the drawer's card has no token)", async () => {
    const token = await card(fixture, { ...exito, documentNumber: "800111333" });
    const [row] = await fixture.sql<{ id: string }[]>`select id from kernel.agent_confirmations where token = ${token}`;
    const response = await post(confirm, "/api/agent/confirm", { cardId: row!.id, decision: "reject" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "rejected" });
    expect((await post(confirm, "/api/agent/confirm", { cardId: row!.id, token, decision: "reject" })).status).toBe(400);
  });

  it("confirming the user's own card runs the process once and answers its result", async () => {
    const token = await card(fixture, exito);
    const first = await post(confirm, "/api/agent/confirm", { token, decision: "confirm" });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { status: string; result: { id: string } };
    expect(body).toMatchObject({ status: "executed", result: { id: expect.any(String) } });
    const again = (await (await post(confirm, "/api/agent/confirm", { token, decision: "confirm" })).json()) as { result: unknown };
    expect(again.result).toEqual(body.result);
    expect((await fixture.sql`select count(*)::int as n from core.parties where company_id = ${fixture.companyIds[0]!}`)[0]!.n).toBe(1);
  });

  it("another user's card is not found; a bad body is invalid_input; rejecting answers rejected", async () => {
    const foreign = await card(other, exito);
    const response = await post(confirm, "/api/agent/confirm", { token: foreign, decision: "confirm" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect((await post(confirm, "/api/agent/confirm", { token: foreign, decision: "maybe" })).status).toBe(400);
    const [foreignCard] = await other.sql<{ id: string }[]>`select id from kernel.agent_confirmations where token = ${foreign}`;
    expect((await post(confirm, "/api/agent/confirm", { cardId: foreignCard!.id, decision: "confirm" })).status).toBe(404);
    const own = await card(fixture, { ...exito, documentNumber: "800111222" });
    expect(await (await post(confirm, "/api/agent/confirm", { token: own, decision: "reject" })).json()).toEqual({ status: "rejected" });
  });
});
