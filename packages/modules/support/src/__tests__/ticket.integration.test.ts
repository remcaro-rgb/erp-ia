import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { supportHarness, type SupportHarness } from "./helpers";

const context = {
  route: "/parties",
  selection: "Almacenes Éxito S.A.",
  lastAuditIds: ["0198a5a0-0000-7000-8000-000000000001"],
  consoleErrors: ["TypeError: x is undefined"],
};

describe("support tickets", () => {
  let h: SupportHarness;
  let ticketA: string;
  let ticketB: string;

  const create = (caller: SupportHarness["reporterA"], input: Record<string, unknown>) =>
    runProcess(h.deps, caller, "support.ticket.create", input) as Promise<{ id: string }>;

  beforeAll(async () => {
    h = await supportHarness();
    ticketA = (await create(h.reporterA, { kind: "bug", title: "El NIT no valida", body: "Al guardar el tercero sale un error.", context })).id;
    ticketB = (await create(h.reporterB, { kind: "question", title: "¿Cómo importo productos?", body: "No encuentro la plantilla." })).id;
  });
  afterAll(async () => {
    await h.cleanup();
  });

  describe("create", () => {
    it("stores the captured context, the reporter and the defaults, and emits support.ticket.created", async () => {
      const [row] = await h.sql`select * from support.tickets where id = ${ticketA}`;
      expect(row).toMatchObject({
        company_id: h.companyId,
        reporter_user_id: h.seed.users.reporterA,
        kind: "bug",
        title: "El NIT no valida",
        status: "open",
        priority: "normal",
        created_by: h.seed.users.reporterA,
        context,
      });
      expect(Number(row!.seq)).toBeGreaterThan(0);
      expect(row!.extra).toEqual({});
      expect(row!.extra_free).toEqual([]);
      const events = await h.sql`select payload from kernel.outbox where event = 'support.ticket.created' and payload->>'id' = ${ticketA}`;
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ id: ticketA, kind: "bug" });
      const audit = await h.sql`select action, origin from kernel.audit_log where process_id = 'support.ticket.create' and row_id = ${ticketA}`;
      expect(audit.map((a) => a.action)).toContain("insert");
    });

    it("gives consecutive record numbers and an empty context when none was captured", async () => {
      const [a, b] = await h.sql`select seq, context from support.tickets where id in (${ticketA}, ${ticketB}) order by seq`;
      expect(Number(b!.seq)).toBe(Number(a!.seq) + 1);
      expect(b!.context).toEqual({});
    });

    it("refuses an unknown kind, an empty title or body and an oversized context with invalid_input", async () => {
      const ok = { kind: "bug", title: "T", body: "B" };
      await expect(create(h.reporterA, { ...ok, kind: "complaint" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(create(h.reporterA, { ...ok, title: "   " })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(create(h.reporterA, { ...ok, body: "" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(create(h.reporterA, { ...ok, context: { consoleErrors: Array.from({ length: 21 }, (_, i) => `e${i}`) } })).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(create(h.reporterA, { ...ok, context: { selection: "x".repeat(2001) } })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(create(h.reporterA, { ...ok, context: { lastAuditIds: ["not-a-uuid"] } })).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("needs the create permission", async () => {
      await expect(create(h.agent, { kind: "bug", title: "T", body: "B" })).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("visibility (ownership row policy)", () => {
    const titles = (h2: SupportHarness, caller: SupportHarness["reporterA"]) =>
      withClaims(h2.sql, caller.claims, (tx) => tx<{ title: string }[]>`select title from support.v_tickets order by seq`).then((rows) => rows.map((r) => r.title));

    it("a reporter reads only their own tickets", async () => {
      expect(await titles(h, h.reporterA)).toEqual(["El NIT no valida"]);
      expect(await titles(h, h.reporterB)).toEqual(["¿Cómo importo productos?"]);
      expect(await titles(h, h.plain)).toEqual([]);
    });

    it("an agent reads every ticket of the company and none of another company", async () => {
      expect(await titles(h, h.agent)).toEqual(["El NIT no valida", "¿Cómo importo productos?"]);
      expect(await titles(h, h.agentOther)).toEqual([]);
    });

    it("the base table obeys the same policy", async () => {
      const own = await withClaims(h.sql, h.reporterA.claims, (tx) => tx`select id from support.tickets`);
      expect(own.map((r) => r.id)).toEqual([ticketA]);
      const none = await withClaims(h.sql, h.reporterA.claims, (tx) => tx`select id from support.tickets where id = ${ticketB}`);
      expect(none).toHaveLength(0);
    });

    it("consult returns the caller's own ticket and hides the others as not_found", async () => {
      const own = (await runProcess(h.deps, h.reporterA, "support.ticket.consult", { id: ticketA })) as Record<string, unknown>;
      expect(own).toMatchObject({ id: ticketA, title: "El NIT no valida", status: "open", context });
      await expect(runProcess(h.deps, h.reporterA, "support.ticket.consult", { id: ticketB })).rejects.toMatchObject({ code: "not_found" });
      await expect(runProcess(h.deps, h.agentOther, "support.ticket.consult", { id: ticketA })).rejects.toMatchObject({ code: "not_found" });
      const any = (await runProcess(h.deps, h.agent, "support.ticket.consult", { id: ticketB })) as Record<string, unknown>;
      expect(any).toMatchObject({ id: ticketB, title: "¿Cómo importo productos?" });
    });

    it("a hidden context never leaves the view", async () => {
      await h.sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${h.companyId}, ${h.roles.reporter}, 'support.ticket', 'context', 'hidden')`;
      try {
        const rows = await withClaims(h.sql, h.reporterA.claims, (tx) => tx`select context, title from support.v_tickets`);
        expect(rows[0]).toMatchObject({ context: null, title: "El NIT no valida" });
        const consulted = (await runProcess(h.deps, h.reporterA, "support.ticket.consult", { id: ticketA })) as Record<string, unknown>;
        expect(consulted.context).toBeNull();
      } finally {
        await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and entity = 'support.ticket'`;
      }
    });
  });

  describe("reply", () => {
    const reply = (caller: SupportHarness["reporterA"], input: Record<string, unknown>) =>
      runProcess(h.deps, caller, "support.ticket.reply", input) as Promise<{ id: string; status: string }>;
    const status = async (id: string) => (await h.sql<{ status: string }[]>`select status from support.tickets where id = ${id}`)[0]!.status;
    const bodies = (caller: SupportHarness["reporterA"], id: string) =>
      withClaims(h.sql, caller.claims, (tx) => tx<{ body: string }[]>`select body from support.v_ticket_messages where ticket_id = ${id} order by seq`).then((rows) =>
        rows.map((r) => r.body),
      );

    it("an agent's answer moves the ticket to answered and the reporter sees it", async () => {
      const out = await reply(h.agent, { ticketId: ticketA, body: "Ya lo corregimos, prueba de nuevo." });
      expect(out.status).toBe("answered");
      expect(await status(ticketA)).toBe("answered");
      const [message] = await h.sql`select author_user_id, is_internal, company_id, ticket_id from support.ticket_messages where id = ${out.id}`;
      expect(message).toMatchObject({ author_user_id: h.seed.users.agent, is_internal: false, company_id: h.companyId, ticket_id: ticketA });
      expect(await bodies(h.reporterA, ticketA)).toEqual(["Ya lo corregimos, prueba de nuevo."]);
      expect(await bodies(h.reporterB, ticketA)).toEqual([]);
    });

    it("the reporter's follow-up reopens the conversation for the agents", async () => {
      const out = await reply(h.reporterA, { ticketId: ticketA, body: "Sigue fallando con otro NIT." });
      expect(out.status).toBe("open");
      expect(await status(ticketA)).toBe("open");
      expect(await bodies(h.agent, ticketA)).toEqual(["Ya lo corregimos, prueba de nuevo.", "Sigue fallando con otro NIT."]);
    });

    it("an internal note is visible to agents only and leaves the status alone", async () => {
      await reply(h.agent, { ticketId: ticketA, body: "Nota: reproducido, es el dígito de verificación.", isInternal: true });
      expect(await status(ticketA)).toBe("open");
      expect(await bodies(h.agent, ticketA)).toContain("Nota: reproducido, es el dígito de verificación.");
      expect(await bodies(h.reporterA, ticketA)).not.toContain("Nota: reproducido, es el dígito de verificación.");
      const consulted = (await runProcess(h.deps, h.reporterA, "support.ticket.consult", { id: ticketA })) as { messages: { body: string }[] };
      expect(consulted.messages.map((m) => m.body)).toEqual(["Ya lo corregimos, prueba de nuevo.", "Sigue fallando con otro NIT."]);
      const asAgent = (await runProcess(h.deps, h.agent, "support.ticket.consult", { id: ticketA })) as { messages: { body: string }[] };
      expect(asAgent.messages).toHaveLength(3);
    });

    it("a reporter cannot write an internal note", async () => {
      await expect(reply(h.reporterA, { ticketId: ticketA, body: "nota", isInternal: true })).rejects.toMatchObject({ code: "forbidden" });
    });

    it("a reporter cannot reply to, or even find, another reporter's ticket", async () => {
      await expect(reply(h.reporterA, { ticketId: ticketB, body: "intruso" })).rejects.toMatchObject({ code: "not_found" });
      expect(await bodies(h.agent, ticketB)).toEqual([]);
    });

    it("refuses an empty reply with invalid_input, and a reply needs its permission", async () => {
      await expect(reply(h.agent, { ticketId: ticketA, body: "  " })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(reply(h.plain, { ticketId: ticketA, body: "hola" })).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("close", () => {
    const close = (caller: SupportHarness["reporterA"], id: string) => runProcess(h.deps, caller, "support.ticket.close", { id }) as Promise<{ id: string }>;

    it("only an agent closes; a closed ticket takes no more replies and cannot be closed twice", async () => {
      await expect(close(h.reporterB, ticketB)).rejects.toMatchObject({ code: "forbidden" });
      await close(h.agent, ticketB);
      const [row] = await h.sql`select status, updated_by from support.tickets where id = ${ticketB}`;
      expect(row).toMatchObject({ status: "closed", updated_by: h.seed.users.agent });
      await expect(runProcess(h.deps, h.reporterB, "support.ticket.reply", { ticketId: ticketB, body: "¿sigue ahí?" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(runProcess(h.deps, h.agent, "support.ticket.reply", { ticketId: ticketB, body: "cerrado" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(close(h.agent, ticketB)).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("a closed ticket cannot be reopened by a direct update", async () => {
      await withClaims(h.sql, h.reporterB.claims, (tx) => tx`update support.tickets set status = 'open' where id = ${ticketB}`);
      await withClaims(h.sql, h.agent.claims, (tx) => tx`update support.tickets set status = 'open' where id = ${ticketB}`);
      expect((await h.sql`select status from support.tickets where id = ${ticketB}`)[0]!.status).toBe("closed");
    });

    it("another company's agent cannot close it", async () => {
      await expect(close(h.agentOther, ticketA)).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("attachments", () => {
    const attach = (caller: SupportHarness["reporterA"], recordId: string) =>
      runProcess(h.deps, caller, "kernel.attachment.add", {
        entity: "support.ticket",
        recordId,
        tag: "Captura",
        fileName: "captura.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        storagePath: `${h.seed.tenantId}/${h.companyId}/support.ticket/${recordId}/0192a1b2-captura.png`,
      });

    it("whoever may reply attaches files to a ticket they can see, and only to that one", async () => {
      for (const role of [h.roles.reporter, h.roles.plain, h.roles.agent]) {
        await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${role}, 'kernel.attachment.add')`;
      }
      await expect(attach(h.reporterA, ticketA)).resolves.toMatchObject({ entity: "support.ticket", recordId: ticketA, fileName: "captura.png" });
      await expect(attach(h.reporterA, ticketB)).rejects.toMatchObject({ code: "not_found" });
      await expect(attach(h.plain, ticketA)).rejects.toMatchObject({ code: "forbidden" });
    });

    it("a reporter cannot list the files of another reporter's ticket", async () => {
      for (const role of [h.roles.reporter, h.roles.agent]) {
        await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${role}, 'kernel.attachment.list')`;
      }
      await expect(runProcess(h.deps, h.reporterA, "kernel.attachment.list", { entity: "support.ticket", recordId: ticketB })).rejects.toMatchObject({ code: "not_found" });
      const own = (await runProcess(h.deps, h.reporterA, "kernel.attachment.list", { entity: "support.ticket", recordId: ticketA })) as unknown[];
      expect(own).toHaveLength(1);
    });

    it("a closed ticket takes no new files and loses none: the files hook refuses the change", async () => {
      const add = runProcess(h.deps, h.reporterB, "kernel.attachment.add", {
        entity: "support.ticket",
        recordId: ticketB,
        tag: "Captura",
        fileName: "tarde.png",
        mimeType: "image/png",
        sizeBytes: 100,
        storagePath: `${h.seed.tenantId}/${h.companyId}/support.ticket/${ticketB}/0192a1b2-tarde.png`,
      });
      // The hook raises inside the kernel's handler, which reports an untyped failure (a typed invalid_input needs a kernel change).
      await expect(add).rejects.toMatchObject({ code: "handler_failed" });
      expect(await h.sql`select 1 from kernel.attachments where record_id = ${ticketB}`).toHaveLength(0);
    });

    it("a reporter holding the message consult gets not_found for an internal note", async () => {
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${h.roles.reporter}, 'support.ticket_message.consult')`;
      const [note] = await h.sql<{ id: string }[]>`select id from support.ticket_messages where ticket_id = ${ticketA} and is_internal`;
      const [pub] = await h.sql<{ id: string }[]>`select id from support.ticket_messages where ticket_id = ${ticketA} and not is_internal limit 1`;
      await expect(runProcess(h.deps, h.reporterA, "support.ticket_message.consult", { id: note!.id })).rejects.toMatchObject({ code: "not_found" });
      await expect(runProcess(h.deps, h.reporterA, "support.ticket_message.consult", { id: pub!.id })).resolves.toMatchObject({ id: pub!.id });
      await expect(runProcess(h.deps, h.agent, "support.ticket_message.consult", { id: note!.id })).resolves.toMatchObject({ id: note!.id });
    });
  });

  describe("writes only through the processes", () => {
    const asReporter = <T,>(caller: SupportHarness["reporterA"], fn: (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) => Promise<T>) =>
      withClaims(h.sql, caller.claims, fn);
    const asProcess = async (tx: Parameters<Parameters<typeof withClaims>[2]>[0], id: string) => {
      await tx`select set_config('erp.audit_process_id', ${id}, true)`;
    };

    it("a user cannot insert tickets or messages directly", async () => {
      await expect(
        asReporter(h.reporterA, (tx) => tx`insert into support.tickets(company_id, kind, title, body) values (${h.companyId}, 'bug', 'directo', 'x')`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asReporter(h.reporterA, (tx) => tx`insert into support.ticket_messages(company_id, ticket_id, body) values (${h.companyId}, ${ticketA}, 'directo')`),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("a user cannot change a ticket directly: status, title and priority stay as the processes left them", async () => {
      const [before] = await h.sql`select status, title, priority from support.tickets where id = ${ticketB}`;
      await asReporter(h.reporterB, (tx) => tx`update support.tickets set status = 'open', title = 'cambiado', priority = 'high' where id = ${ticketB}`);
      expect((await h.sql`select status, title, priority from support.tickets where id = ${ticketB}`)[0]).toEqual(before);
    });

    it("even inside a support process a message cannot be written under another author", async () => {
      await expect(
        asReporter(h.reporterA, async (tx) => {
          await asProcess(tx, "support.ticket.reply");
          await tx`insert into support.ticket_messages(company_id, ticket_id, author_user_id, body) values (${h.companyId}, ${ticketA}, ${h.seed.users.agent!}, 'suplantado')`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      // Under the process pipeline and as themselves, the same insert is allowed.
      await asReporter(h.reporterA, async (tx) => {
        await asProcess(tx, "support.ticket.reply");
        await tx`insert into support.ticket_messages(company_id, ticket_id, author_user_id, body) values (${h.companyId}, ${ticketA}, ${h.seed.users.reporterA!}, 'propio')`;
      });
      expect(await h.sql`select 1 from support.ticket_messages where body = 'propio'`).toHaveLength(1);
      await h.sql`delete from support.ticket_messages where body = 'propio'`;
    });
  });

  describe("module hooks", () => {
    it("defines the readiness hooks the kernel calls for an entity of the module", async () => {
      await h.sql`select support.attachments_changed('support.ticket', ${h.companyId}::uuid, ${ticketA}::uuid)`;
      await h.sql`select support.custom_field_changed('support.ticket', ${h.companyId}::uuid)`;
      const [open] = await h.sql<{ c: string }[]>`select count(*)::text as c from kernel.required_attachments where company_id = ${h.companyId} and entity = 'support.ticket'`;
      expect(open!.c).toBe("0");
      // The kernel raises when a module defines no hook; with them, an admin-defined field on a ticket is accepted.
      await h.sql.begin(async (tx) => {
        await tx`insert into kernel.custom_fields(company_id, entity, key, label, type, required) values (${h.companyId}, 'support.ticket', 'modulo', 'Módulo', 'text', true)`;
        await tx`delete from kernel.custom_fields where company_id = ${h.companyId} and entity = 'support.ticket'`;
      });
    });
  });
});
