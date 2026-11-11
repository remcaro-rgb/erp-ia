import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, enqueueEvent, setMailer } from "@erp/kernel";
import { accountingHarness, markInvoiceReady, type AccountingHarness } from "./helpers";
import invoiceFixture from "../rules/fixtures/invoice-issued.json" with { type: "json" };

// State e-mails for the comprobantes the module posts outside the lifecycle runner (Phase 2A.5 Task 12, fix round 1, ruling I2): the
// posting engine (post_from_event), Saldos iniciales (opening.post) and the year close move a comprobante to Contabilizado through
// postEntry, which writes `accounting.entry.status_changed` in the posting's transaction with the kernel's emitter. The actor is the
// person who caused the posting: the caller, or, for the engine (the system user acting for an event), the person who started the
// event's chain. A refused posting rolls the event back with it. The kernel's consumer then mails the PDF rendered with that person's
// rights (here to a capturing Mailer; the SMTP path is the kernel's own test).

interface Sent {
  bcc?: string[];
  subject: string;
  attachments?: { filename: string }[];
}

let h: AccountingHarness;
let year: number;
let ccId: string;
let partyId: string;
const sent: Sent[] = [];
const TO = "contabilidad@cafedelnorte.test";

beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  ccId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Tiendas D1 S.A.S.', 'errors') returning id`)[0]!.id;
  await markInvoiceReady(h, partyId, "2");
  const account = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
  await h.runStepUp(h.admin, "accounting.account_role_mapping.update", {
    mappings: [
      { role: "revenue", dimension: "category:bebidas", accountId: await account("413505") },
      { role: "revenue", dimension: "category:comida", accountId: await account("413595") },
    ],
  });
  await h.runStepUp(h.admin, "kernel.state_recipients.update", { entity: "accounting.entry", status: "posted", emails: [TO] });
  setMailer({ transport: "smtp", send: async (message) => (sent.push(message as Sent), { providerId: `capture-${sent.length}` }) });
}, 180_000);
afterAll(async () => {
  setMailer(undefined);
  await h.sql`delete from kernel.state_recipients where company_id = ${h.companyId}`;
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
type Changed = { id: string; event: string; payload: { entity: string; id: string; from: string; to: string; number: string | null; actorId: string }; created_at: Date; chain_id: string };
/** The `accounting.entry.status_changed` rows written for `entryId`. */
const changesOf = (entryId: string) =>
  h.sql<Changed[]>`select id, event, payload, created_at, chain_id from kernel.outbox
    where company_id = ${h.companyId} and event = 'accounting.entry.status_changed' and payload->>'id' = ${entryId} order by created_at, id`;
/** Delivers a row to the consumer `moduleId` registered for it, as the dispatch workflow does. */
const deliver = async (row: { id: string; event: string; payload: unknown; created_at: Date; chain_id: string }, moduleId: string) => {
  const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId);
  expect(consumer).toBeDefined();
  await consumer!.fn(buildConsumerContext(h.sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: h.companyId, chainId: row.chain_id }, h.deps.registry), row.payload);
};
/** Mails the comprobante's state e-mail and answers its mail_log row. */
const mailOf = async (change: Changed) => {
  const before = sent.length;
  await deliver(change, "kernel");
  const [log] = await h.sql<{ status: string; created_by: string; recipients: string[]; error: string | null }[]>`
    select status, created_by, recipients, error from kernel.mail_log where event_id = ${change.id}`;
  return { log, mails: sent.slice(before) };
};
/** An invoicing.invoice.issued outbox row on `chainId`. */
const invoiceEvent = async (chainId: string, date: string) => {
  const payload = { ...invoiceFixture, date, invoiceId: randomUUID(), costCenterId: ccId, customer: { partyId, legalName: "Tiendas D1 S.A.S." } };
  const id = await h.sql.begin((tx) => enqueueEvent(tx, { companyId: h.companyId, event: "invoicing.invoice.issued", payload, chainId }));
  const [row] = await h.sql<{ id: string; event: string; payload: unknown; created_at: Date; chain_id: string }[]>`select id, event, payload, created_at, chain_id from kernel.outbox where id = ${id}`;
  return row!;
};

describe("state e-mails of comprobantes posted by the module (I2)", () => {
  it("post_from_event: the engine's comprobante writes draft → posted on the event's chain, in the name of the person who started it, and is mailed with their rights", async () => {
    // The person behind the chain: the contador runs a process on it (as an invoice issued by them would), then the event follows.
    const chainId = randomUUID();
    await h.run({ ...h.contador, chainId }, "accounting.entry.create", { date: dateIn(3, 2), description: "En la cadena", lines: [{ accountCode: "111005", debit: 1, credit: 0 }, { accountCode: "413595", debit: 0, credit: 1, costCenterId: ccId }] });
    const event = await invoiceEvent(chainId, dateIn(3, 5));
    await deliver(event, "accounting");
    const [entry] = await h.sql<{ id: string; number: string }[]>`select id, number from accounting.entries where company_id = ${h.companyId} and source_event_id = ${event.id}`;
    const changes = await changesOf(entry!.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ chain_id: chainId, payload: { entity: "accounting.entry", id: entry!.id, from: "draft", to: "posted", number: entry!.number, actorId: h.contador.userId } });

    const { log, mails } = await mailOf(changes[0]!);
    expect(log).toMatchObject({ status: "sent", created_by: h.contador.userId, recipients: [TO], error: null });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.bcc).toEqual([TO]);
    expect(mails[0]!.subject).toContain(entry!.number);
  });

  it("post_from_event: a refused posting (a missing mapping) writes no status_changed event", async () => {
    const [mapping] = await h.sql<{ id: string }[]>`select id from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'vat_out' limit 1`;
    await h.sql`delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'vat_out'`;
    expect(mapping).toBeDefined();
    const chainId = randomUUID();
    const event = await invoiceEvent(chainId, dateIn(3, 6));
    await deliver(event, "accounting");
    expect(await h.sql`select 1 from accounting.entries where company_id = ${h.companyId} and source_event_id = ${event.id}`).toHaveLength(0);
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.status_changed' and chain_id = ${chainId}`).toHaveLength(0);
  });

  it("opening.post: Saldos iniciales write draft → posted in the name of the admin who posted them; an unbalanced opening, refused, writes none", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.opening.create", {
      lines: [{ accountCode: "111005", debit: 1_000_000, credit: 0 }, { accountCode: "310505", debit: 0, credit: 1_000_000 }],
    });
    const out = await h.runStepUp<{ number: string }>(h.admin, "accounting.opening.post", { id });
    const changes = await changesOf(id);
    expect(changes.map((c) => c.payload)).toEqual([{ entity: "accounting.entry", id, from: "draft", to: "posted", number: out.number, actorId: h.seed.users.both }]);
    const { log, mails } = await mailOf(changes[0]!);
    expect(log).toMatchObject({ status: "sent", created_by: h.seed.users.both });
    expect(mails).toHaveLength(1);

    const unbalanced = await h.run<{ id: string }>(h.contador, "accounting.opening.create", { lines: [{ accountCode: "510506", costCenterCode: "ADM", debit: 50, credit: 0 }, { accountCode: "111005", debit: 0, credit: 40 }] });
    await expect(h.runStepUp(h.admin, "accounting.opening.post", { id: unbalanced.id })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await changesOf(unbalanced.id)).toHaveLength(0);
  });

  it("year close: each closing comprobante writes draft → posted in the name of the admin who closed the year; a refused close writes none", async () => {
    const fy = (await h.sql<{ id: string }[]>`select id from accounting.fiscal_years where company_id = ${h.companyId} and year = ${year}`)[0]!.id;
    const { id: movement } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(4, 10), description: "Venta del año",
      lines: [{ accountCode: "111005", debit: 1000, credit: 0 }, { accountCode: "413595", debit: 0, credit: 1000, costCenterId: ccId }],
    });
    await h.run(h.contador, "accounting.entry.save", { id: movement });

    // Refused: the periods are still open.
    const before = await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.status_changed'`;
    await expect(h.runStepUp(h.admin, "accounting.year.close", { fiscalYearId: fy })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.status_changed'`).toHaveLength(before.length);

    // The drafts left by the other tests would block nothing here; the close needs every period closed.
    await h.sql`update accounting.periods set status = 'closed' where fiscal_year_id = ${fy}`;
    const out = await h.runStepUp<{ closingEntryIds: string[] }>(h.admin, "accounting.year.close", { fiscalYearId: fy });
    expect(out.closingEntryIds.length).toBeGreaterThan(0);
    for (const entryId of out.closingEntryIds) {
      const [number] = (await h.sql<{ number: string }[]>`select number from accounting.entries where id = ${entryId}`).map((r) => r.number);
      const changes = await changesOf(entryId);
      expect(changes.map((c) => c.payload)).toEqual([{ entity: "accounting.entry", id: entryId, from: "draft", to: "posted", number, actorId: h.seed.users.both }]);
    }
    const { log, mails } = await mailOf((await changesOf(out.closingEntryIds[0]!))[0]!);
    expect(log).toMatchObject({ status: "sent", created_by: h.seed.users.both });
    expect(mails).toHaveLength(1);
  });
});
