import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "../../../modules/accounting/src/__tests__/helpers";
import { buildTools } from "../tools/build";

// The generic lifecycle through the assistant (Phase 2A.5 Task 17, rules 1, 15 and 17, entity types spec §9.1 D11). Aprobar and Anular
// are writes: the tool answers a confirmation card and nothing runs before the accept. A document the caller reads but cannot modify (a
// record access rule narrows them) is refused before any card is stored, with the same refusal the process itself gives; one they cannot
// read is refused as one that does not exist. Notificar is a write behind a card; Imprimir is a consult tool.

let h: AccountingHarness;
let journal: string;
let conversation: string;

const pendingEntry = async (description: string) =>
  (await h.sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, description, origin, status, requires_approval, created_by, submitted_by, submitted_at)
    values (${h.companyId}, ${journal}, current_date, ${description}, 'manual', 'pending', true, ${h.contador.userId}, ${h.contador.userId}, now()) returning id`)[0]!.id;
const approvedEntry = async (description: string) =>
  (await h.sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, description, origin, status, requires_approval, created_by)
    values (${h.companyId}, ${journal}, current_date, ${description}, 'manual', 'approved', false, ${h.contador.userId}) returning id`)[0]!.id;
const cards = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from kernel.agent_confirmations where company_id = ${h.companyId}`)[0]!.n;
const statusOf = async (id: string) => (await h.sql<{ status: string }[]>`select status from accounting.entries where id = ${id}`)[0]!.status;
const tools = () => buildTools(h.deps, { ...h.contador, conversationId: conversation }, { registry: h.deps.registry });
const call = async (name: string, input: unknown) => {
  const tool = (await tools())[name];
  expect(tool, `${name} is a tool`).toBeDefined();
  return (await tool!.execute!(input, { toolCallId: "c", messages: [] } as never)) as Record<string, unknown>;
};
const narrow = (recordId: string, rights: { read: boolean; modify: boolean }) =>
  h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read, can_use, can_modify)
        values (${h.companyId}, 'accounting.entry', ${recordId}, ${h.contador.roleId}, ${rights.read}, ${rights.read}, ${rights.modify})`;
/** A rule for another role only: the contador's role has none, so the record is hidden from them. */
const hide = (recordId: string) =>
  h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read, can_use, can_modify)
        values (${h.companyId}, 'accounting.entry', ${recordId}, ${h.auxiliar.roleId}, true, true, true)`;

/**
 * A comprobante that Aprobar would really post (plan 2B Task 25: the card is offered only for a run the process would accept, tried in a
 * dry run): two balanced lines in an open period, created and sent to approval by the auxiliar, so the contador may approve it.
 */
const submittedEntry = async (description: string) => {
  const [year] = await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`;
  const { id } = await h.run<{ id: string }>(h.auxiliar, "accounting.entry.create", {
    date: `${year!.year}-02-15`, description, lines: [{ accountCode: "510506", debit: 100, credit: 0, costCenterId: costCenter }, { accountCode: "111005", debit: 0, credit: 100 }],
  });
  await h.run(h.auxiliar, "accounting.entry.save", { id });
  await h.run(h.auxiliar, "accounting.entry.submit", { id });
  return id;
};
let costCenter: string;

beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: true });
  costCenter = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  journal = (await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`)[0]!.id;
  await h.grantAll(h.companyId, h.contador.roleId, ["kernel.record.notify", "kernel.doc_template.print"]);
  conversation = (await h.sql<{ id: string }[]>`insert into kernel.agent_conversations (company_id, user_id, title) values (${h.companyId}, ${h.contador.userId}, 'Prueba') returning id`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.record_access where company_id = ${h.companyId}`;
  await h.sql`delete from kernel.agent_confirmations where company_id = ${h.companyId}`;
  await h.sql`delete from kernel.agent_conversations where company_id = ${h.companyId}`;
  await h.cleanup();
});

describe("typed processes through the assistant", () => {
  it("Aprobar asks for confirmation: a card, and the comprobante stays Pendiente de Aprobación", async () => {
    const id = await submittedEntry("Por aprobar");
    const out = await call("accounting__entry__approve", { id });
    expect(out.confirmationRequired).toBe(true);
    expect(await statusOf(id)).toBe("pending");
  });

  it("Anular asks for confirmation: a card, and the comprobante is not voided", async () => {
    const id = await approvedEntry("Por anular");
    const out = await call("accounting__entry__void", { id, reason: "Quedó duplicado" });
    expect(out.confirmationRequired).toBe(true);
    expect(await statusOf(id)).toBe("approved");
  });

  it("no card for a run the process would refuse (tried in a dry run, nothing written): the contador's own comprobante, without lines", async () => {
    const id = await pendingEntry("Sin líneas");
    const before = await cards();
    const out = await call("accounting__entry__approve", { id });
    expect(out).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringMatching(/^same_user_approval: /) } });
    expect(await cards()).toBe(before);
    expect(await statusOf(id)).toBe("pending");
  });

  it("refuses a comprobante the caller reads but cannot modify: no card, record_forbidden", async () => {
    const id = await pendingEntry("Solo lectura");
    await narrow(id, { read: true, modify: false });
    const before = await cards();
    const out = await call("accounting__entry__approve", { id });
    expect(out.confirmationRequired).toBeUndefined();
    expect(out).toMatchObject({ ok: false, error: { code: "record_forbidden" } });
    expect(await cards()).toBe(before);
    expect(await statusOf(id)).toBe("pending");
  });

  it("refuses a comprobante the caller cannot read as one that does not exist: no card, not_found without details", async () => {
    const id = await approvedEntry("Oculto");
    await hide(id);
    const before = await cards();
    const out = await call("accounting__entry__void", { id, reason: "Error" });
    expect(out).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((out.error as { details?: unknown }).details).toBeUndefined();
    expect(await cards()).toBe(before);
  });

  it("Notificar is a write behind a card; Imprimir is a consult tool", async () => {
    const id = await approvedEntry("Para enviar");
    const out = await call("kernel__record__notify", { entity: "accounting.entry", recordId: id, to: ["contabilidad@example.com"] });
    expect(out.confirmationRequired).toBe(true);
    expect(await h.sql`select 1 from kernel.mail_log where record_id = ${id}`).toHaveLength(0);
    expect((await tools()).kernel__doc_template__print).toBeDefined();
  });
});
