import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneDraft, runProcess } from "@erp/kernel";
import { supportHarness, type SupportHarness } from "./helpers";

// "Duplicar" on a ticket (rule 37, design §22.13): the copy is the source's visible data (kind, title, body and the
// captured context, under the same field visibility as any field) without `seq` and `status`, filed through
// support.ticket.create with the source recorded in the audit; the messages stay with the source.

describe("support ticket cloning", () => {
  let h: SupportHarness;

  beforeAll(async () => {
    h = await supportHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("declares seq and status as what a clone clears", () => {
    expect(h.deps.registry.entity("support.ticket").cloneReset).toEqual(["seq", "status"]);
  });

  it("clones an answered ticket into a new open one with its own seq, its context, no messages, and the source in the audit", async () => {
    const context = { route: "/parties", selection: "Almacenes Éxito S.A.", lastAuditIds: [], consoleErrors: ["TypeError: x is undefined"] };
    const { id: sourceId } = (await runProcess(h.deps, h.reporterA, "support.ticket.create", { kind: "bug", title: "El NIT no valida", body: "Sale un error al guardar.", context })) as { id: string };
    await runProcess(h.deps, h.agent, "support.ticket.reply", { ticketId: sourceId, body: "Lo revisamos." });
    const [source] = await h.sql`select seq, status from support.tickets where id = ${sourceId}`;
    expect(source!.status).toBe("answered");

    const seen = (await runProcess(h.deps, h.reporterA, "support.ticket.consult", { id: sourceId })) as Record<string, unknown>;
    const draft = cloneDraft(h.deps.registry, "support.ticket", seen);
    expect(draft).toEqual({ kind: "bug", title: "El NIT no valida", body: "Sale un error al guardar.", context });
    for (const key of ["seq", "status", "id", "reporterUserId", "messages"]) expect(draft).not.toHaveProperty(key);

    const { id } = (await runProcess(h.deps, h.reporterA, "support.ticket.create", draft, { sourceRowId: sourceId })) as { id: string };
    const [clone] = await h.sql`select seq, status, title, context, reporter_user_id from support.tickets where id = ${id}`;
    expect(clone).toMatchObject({ status: "open", title: "El NIT no valida", context, reporter_user_id: h.seed.users.reporterA });
    expect(Number(clone!.seq)).not.toBe(Number(source!.seq));
    expect((await h.sql`select 1 from support.ticket_messages where ticket_id = ${id}`).length).toBe(0);
    const audit = await h.sql<{ source_row_id: string | null }[]>`select source_row_id from kernel.audit_log where row_id = ${id} and action = 'insert'`;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.source_row_id === sourceId)).toBe(true);
  });
});
