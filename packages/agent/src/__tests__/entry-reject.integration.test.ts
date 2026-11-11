import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "../../../modules/accounting/src/__tests__/helpers";
import { buildTools } from "../tools/build";

// No Aprobar (`accounting.entry.reject`, which replaced Devolver a borrador in Phase 2A.5 Task 8b) is a write: the assistant gets the
// tool, answers with a confirmation card and runs nothing before the accept (rule 17).

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness();
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.agent_confirmations where company_id = ${h.companyId}`;
  await h.sql`delete from kernel.agent_conversations where company_id = ${h.companyId}`;
  await h.cleanup();
});

describe("accounting.entry.reject", () => {
  it("No Aprobar is a write the assistant confirms (tool present, confirmation card, no run before accept); Devolver a borrador is gone", async () => {
    const [journal] = await h.sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind) values (${h.companyId}, 'NC', 'Nota', 'general') returning id`;
    const [entry] = await h.sql<{ id: string }[]>`
      insert into accounting.entries (company_id, journal_id, date, description, origin, status, requires_approval, created_by, submitted_by, submitted_at)
      values (${h.companyId}, ${journal!.id}, current_date, 'Pendiente', 'manual', 'pending', true, ${h.auxiliar.userId}, ${h.auxiliar.userId}, now()) returning id`;
    const caller = { ...h.contador, conversationId: (await h.sql<{ id: string }[]>`
      insert into kernel.agent_conversations (company_id, user_id, title) values (${h.companyId}, ${h.contador.userId}, 'Prueba') returning id`)[0]!.id };
    const tools = await buildTools(h.deps, caller, { registry: h.deps.registry });
    expect(tools.accounting__entry__return_to_draft).toBeUndefined();
    const tool = tools.accounting__entry__reject;
    expect(tool).toBeDefined();
    const out = (await tool!.execute!({ id: entry!.id, reason: "Falta soporte" }, { toolCallId: "c", messages: [] } as never)) as { confirmationRequired: boolean; token: string };
    expect(out.confirmationRequired).toBe(true);
    const [row] = await h.sql`select status from accounting.entries where id = ${entry!.id}`;
    expect(row!.status).toBe("pending");
  });
});
