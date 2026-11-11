import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "@erp/kernel";
import { createConfirmation, decideConfirmation } from "../runtime/confirm";
import { buildTools } from "../tools/build";
import { agentHarness, exito, type AgentHarness } from "./harness";

// Confirmation cards (design §6 "Agent", rules 15 and 17, review focus 4 and 5): a write the assistant proposed runs
// only when its user confirms, once however often the card is confirmed, as the user with origin `agent` and the
// conversation in the audit; a step-up process asks for the code; nobody else decides the card.

describe("decideConfirmation", () => {
  let h: AgentHarness;
  let admin: Caller;

  /** A pending card for core.party.create, created the way the assistant does: through the write tool. */
  const createPendingConfirmation = async (documentNumber: string, caller: Caller = admin): Promise<string> => {
    const tools = await buildTools(h.deps, caller, { registry: h.deps.registry });
    const out = (await tools.core__party__create!.execute!({ ...exito, documentNumber, legalName: `Éxito ${documentNumber}` }, { toolCallId: "c", messages: [] } as never)) as {
      confirmationRequired: boolean;
      token: string;
    };
    expect(out.confirmationRequired).toBe(true);
    return out.token;
  };
  const parties = async (documentNumber: string) =>
    (await h.sql<{ n: number }[]>`select count(*)::int as n from core.parties where company_id = ${h.companyId} and document_number = ${documentNumber}`)[0]!.n;
  const card = async (token: string) => (await h.sql`select status, result, decided_at from kernel.agent_confirmations where token = ${token}`)[0]!;

  beforeAll(async () => {
    h = await agentHarness();
    admin = { ...h.admin, conversationId: await h.conversation(h.admin) };
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("resuming a confirmation twice runs the process once", async () => {
    const token = await createPendingConfirmation("900373115");
    const a = await decideConfirmation(h.deps, h.admin, token, "confirm");
    const b = await decideConfirmation(h.deps, h.admin, token, "confirm");
    expect(a).toMatchObject({ status: "executed", result: { id: expect.any(String) } });
    expect(b.result).toEqual(a.result);
    expect(await parties("900373115")).toBe(1);
    const [audit] = await h.sql`select origin, conversation_id, actor_user_id from kernel.audit_log where process_id = 'core.party.create' and company_id = ${h.companyId} and action = 'insert' order by occurred_at desc limit 1`;
    expect(audit).toMatchObject({ origin: "agent", conversation_id: admin.conversationId, actor_user_id: admin.claims.sub });
    expect(await card(token)).toMatchObject({ status: "executed", result: a.result });
  });

  it("two confirmations at the same time (double click) still run it once", async () => {
    const token = await createPendingConfirmation("800111222");
    const [a, b] = await Promise.all([decideConfirmation(h.deps, h.admin, token, "confirm"), decideConfirmation(h.deps, h.admin, token, "confirm")]);
    expect(a.result).toEqual(b.result);
    expect(await parties("800111222")).toBe(1);
  });

  it("five confirmations at once all complete with the one result (no pool exhaustion)", async () => {
    const token = await createPendingConfirmation("800111999");
    const results = await Promise.all(Array.from({ length: 5 }, () => decideConfirmation(h.deps, h.admin, token, "confirm")));
    expect(new Set(results.map((r) => JSON.stringify(r.result))).size).toBe(1);
    expect(results.every((r) => r.status === "executed")).toBe(true);
    expect(await parties("800111999")).toBe(1);
  }, 30_000);

  it("a card whose run committed but whose executed mark was lost answers the stored result, even past its expiry", async () => {
    const token = await createPendingConfirmation("800222111");
    const first = await decideConfirmation(h.deps, h.admin, token, "confirm");
    await h.sql`update kernel.agent_confirmations set status = 'confirmed', result = null, expires_at = now() - interval '1 minute' where token = ${token}`;
    expect(await decideConfirmation(h.deps, h.admin, token, "confirm")).toEqual(first);
    expect(await card(token)).toMatchObject({ status: "executed", result: first.result });
    expect(await parties("800222111")).toBe(1);
  });

  it("a card left confirmed by a crashed decision is taken over after a while, and still runs once", async () => {
    const token = await createPendingConfirmation("800222333");
    await h.sql`update kernel.agent_confirmations set status = 'confirmed', decided_at = now() - interval '10 minutes' where token = ${token}`;
    expect(await decideConfirmation(h.deps, h.admin, token, "confirm")).toMatchObject({ status: "executed" });
    expect(await parties("800222333")).toBe(1);
  });

  it("tells the conversation what was decided, for the next turn", async () => {
    const token = await createPendingConfirmation("800111333");
    await decideConfirmation(h.deps, h.admin, token, "confirm");
    const [event] = await h.sql<{ parts: { type: string; processId: string; status: string }[] }[]>`
      select parts from kernel.agent_messages where conversation_id = ${admin.conversationId!} and role = 'event' order by created_at desc limit 1`;
    expect(event!.parts[0]).toMatchObject({ type: "confirmation", processId: "core.party.create", status: "executed" });
  });

  it("a card belongs to its conversation's user: another user, even an admin of the company, gets not_found", async () => {
    const token = await createPendingConfirmation("800111444");
    await expect(decideConfirmation(h.deps, h.otherAdmin, token, "confirm")).rejects.toMatchObject({ code: "not_found" });
    await expect(decideConfirmation(h.deps, h.cashier, token, "reject")).rejects.toMatchObject({ code: "not_found" });
    await expect(decideConfirmation(h.deps, h.admin, "x".repeat(43), "confirm")).rejects.toMatchObject({ code: "not_found" });
    expect(await parties("800111444")).toBe(0);
    expect(await card(token)).toMatchObject({ status: "pending" });
  });

  it("a rejected card never runs, also when confirmed afterwards", async () => {
    const token = await createPendingConfirmation("800111555");
    expect(await decideConfirmation(h.deps, h.admin, token, "reject")).toEqual({ status: "rejected" });
    expect(await decideConfirmation(h.deps, h.admin, token, "confirm")).toEqual({ status: "rejected" });
    expect(await parties("800111555")).toBe(0);
  });

  it("a card expires after 15 minutes", async () => {
    const token = await createPendingConfirmation("800111666");
    await h.sql`update kernel.agent_confirmations set expires_at = now() - interval '1 second' where token = ${token}`;
    await expect(decideConfirmation(h.deps, h.admin, token, "confirm")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await parties("800111666")).toBe(0);
    // It ends rejected (the expiry is the reason), and says so from then on.
    expect(await card(token)).toMatchObject({ status: "rejected", result: { reason: "confirmation_expired" } });
    expect(await decideConfirmation(h.deps, h.admin, token, "confirm")).toEqual({ status: "rejected", reason: "confirmation_expired" });
  });

  it("rejecting a card left confirmed by a crashed decision answers rejected at once", async () => {
    const token = await createPendingConfirmation("800333111");
    await h.sql`update kernel.agent_confirmations set status = 'confirmed', decided_at = now() - interval '10 minutes' where token = ${token}`;
    const started = Date.now();
    expect(await decideConfirmation(h.deps, h.admin, token, "reject")).toEqual({ status: "rejected" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await parties("800333111")).toBe(0);
  });

  it("a stale confirmed card past its expiry ends rejected instead of answering invalid_input forever", async () => {
    const token = await createPendingConfirmation("800333222");
    await h.sql`update kernel.agent_confirmations set status = 'confirmed', decided_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute' where token = ${token}`;
    await expect(decideConfirmation(h.deps, h.admin, token, "confirm")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await card(token)).toMatchObject({ status: "rejected" });
    expect(await decideConfirmation(h.deps, h.admin, token, "confirm")).toEqual({ status: "rejected", reason: "confirmation_expired" });
    expect(await parties("800333222")).toBe(0);
  });

  it("the owning user may decide a card by its id instead of its token; anyone else gets not_found", async () => {
    const token = await createPendingConfirmation("800333333");
    const [row] = await h.sql<{ id: string }[]>`select id from kernel.agent_confirmations where token = ${token}`;
    await expect(decideConfirmation(h.deps, h.otherAdmin, { cardId: row!.id }, "confirm")).rejects.toMatchObject({ code: "not_found" });
    await expect(decideConfirmation(h.deps, h.cashier, { cardId: row!.id }, "reject")).rejects.toMatchObject({ code: "not_found" });
    const a = await decideConfirmation(h.deps, h.admin, { cardId: row!.id }, "confirm");
    expect(a).toMatchObject({ status: "executed" });
    expect(await decideConfirmation(h.deps, h.admin, token, "confirm")).toEqual(a);
    expect(await parties("800333333")).toBe(1);
  });

  it("a step-up process confirmation without a step-up token returns step_up_required, and runs with a fresh one", async () => {
    await h.sql`insert into kernel.sensitive_processes(company_id, process_id, mode) values (${h.companyId}, 'core.party.create', 'self_2fa')`;
    try {
      const token = await createPendingConfirmation("800111777");
      const [row] = await h.sql`select preview from kernel.agent_confirmations where token = ${token}`;
      expect(row!.preview).toMatchObject({ stepUp: true });
      await expect(decideConfirmation(h.deps, h.admin, token, "confirm")).rejects.toMatchObject({ code: "step_up_required" });
      expect(await card(token)).toMatchObject({ status: "pending" });
      // A verification of another user does not count (review focus 5).
      const foreign = randomUUID();
      await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${h.otherAdmin.claims.sub}, ${h.companyId}, ${foreign})`;
      await expect(decideConfirmation(h.deps, h.admin, token, "confirm", foreign)).rejects.toMatchObject({ code: "step_up_required" });
      const own = randomUUID();
      await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${h.admin.claims.sub}, ${h.companyId}, ${own})`;
      expect(await decideConfirmation(h.deps, h.admin, token, "confirm", own)).toMatchObject({ status: "executed" });
      expect(await parties("800111777")).toBe(1);
    } finally {
      await h.sql`delete from kernel.sensitive_processes where company_id = ${h.companyId}`;
    }
  });

  it("a dry-run denial in the preflight writes no audit row and is counted once; the refusal reaches the model (rule 16, design §22.28)", async () => {
    const cashier: Caller = { ...h.cashier, conversationId: await h.conversation(h.cashier), chainId: randomUUID() };
    const def = h.deps.registry.process("core.party.create");
    const counted = async () =>
      Number((await h.sql`select coalesce(sum(count), 0) as n from kernel.dry_run_denial_counters where company_id = ${h.companyId} and process_id = 'core.party.create' and code = 'forbidden'`)[0]!.n);
    const before = await counted();
    const out = await createConfirmation(h.deps, cashier, def, { ...exito, documentNumber: "700111222", legalName: "Éxito 700111222" });
    expect(out).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await h.sql`select 1 from kernel.audit_log where chain_id = ${cashier.chainId!}`).toHaveLength(0);
    expect(await counted()).toBe(before + 1);
  });
});
