import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, enqueueEvent, matrixProcesses } from "@erp/kernel";
import { accountingHarness, installVoidedTestRule, newId, type AccountingHarness, markInvoiceReady } from "./helpers";
import invoiceFixture from "../rules/fixtures/invoice-issued.json" with { type: "json" };
import voidedFixture from "../rules/fixtures/invoice-voided.json" with { type: "json" };
import paymentFixture from "../rules/fixtures/payment-received.json" with { type: "json" };

// The engine over the accounting provider with real outbox rows: the consumer the loader registered for "*" is invoked the way
// the dispatch workflow invokes it (a consumer context on the event's chain, processes run as the system user with origin event).

let h: AccountingHarness;
let year: number;
let ccId: string;
let partyId: string;
beforeAll(async () => {
  h = await accountingHarness({ companies: 2 });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  await installVoidedTestRule(h);
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
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const invoice = (date: string, overrides: Record<string, unknown> = {}) => ({
  ...invoiceFixture, date, invoiceId: randomUUID(), costCenterId: ccId, customer: { partyId, legalName: "Tiendas D1 S.A.S." }, ...overrides,
});

const emit = async (event: string, payload: Record<string, unknown>) => {
  const chainId = randomUUID();
  const id = await h.sql.begin((tx) => enqueueEvent(tx, { companyId: h.companyId, event, payload, chainId }));
  return { id, chainId };
};
/** Delivers the row to the accounting consumer, as the dispatch workflow does. */
const deliver = async (outboxId: string) => {
  const [row] = await h.sql<{ id: string; event: string; payload: unknown; created_at: Date; chain_id: string }[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where id = ${outboxId}`;
  const ctx = buildConsumerContext(h.sql, { id: row!.id, event: row!.event, createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, h.deps.registry);
  const consumer = consumers.for(row!.event).find((c) => c.moduleId === "accounting");
  await consumer!.fn(ctx, row!.payload);
};
const entriesOf = (outboxId: string) => h.sql`select * from accounting.entries where company_id = ${h.companyId} and source_event_id = ${outboxId} order by seq`;
const failuresOf = (outboxId: string) => h.sql`select * from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${outboxId} order by seq`;
const ruleOf = async (event: string) => (await h.sql<{ id: string; journal_id: string }[]>`select id, journal_id from accounting.posting_rules where company_id = ${h.companyId} and event = ${event} order by seq limit 1`)[0]!;

describe("posting", () => {
  it("chart.seed installs the default rules of the module for every event of design §5.4", async () => {
    const rules = await h.sql<{ event: string; module: string; is_default: boolean }[]>`select event, module, is_default from accounting.posting_rules where company_id = ${h.companyId} and is_default order by event`;
    expect(rules.map((r) => r.event)).toEqual([
      // cogs-posted and inventory-adjustment are the manifests of costing and inventory (Task 50.14), not accounting's own.
      "invoicing.invoice.issued",
      // invoice-voided was retired (Task 52.5, migration 0142); the voids below run on a test-owned copy (installVoidedTestRule).
      // The note's rule is three, one per kind of note (plan 2B Task 18 fix round 1).
      "invoicing.note.issued", "invoicing.note.issued", "invoicing.note.issued", "payments.advance.applied", "payments.advance.unapplied", "payments.payment.voided", "payments.received",
    ]);
    expect(rules.every((r) => r.module === "accounting" && r.is_default)).toBe(true);
  });

  it("an invoicing.invoice.issued outbox row posts the Ventas entry with receivable, revenue per category mapping and vat_out per tax, on the event's chain, origin auto", async () => {
    const { id, chainId } = await emit("invoicing.invoice.issued", invoice(dateIn(3, 5)));
    await deliver(id);
    const [entry] = await entriesOf(id);
    expect(entry).toMatchObject({ status: "posted", origin: "auto", number: "VT-1", source_entity: "invoicing.invoice", chain_id: chainId, total_debit: "1190000.0000", total_credit: "1190000.0000" });
    const [journal] = await h.sql`select code from accounting.journals where id = ${entry!.journal_id}`;
    expect(journal!.code).toBe("VT");
    const lines = await h.sql`
      select a.code, l.debit, l.credit, l.party_id, l.cost_center_id, l.tax_code, l.tax_base, l.due_date::text as due_date
      from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entry!.id} order by l.line_no`;
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["130505", "1190000.0000", "0.0000"], ["413505", "0.0000", "600000.0000"], ["413595", "0.0000", "400000.0000"], ["240801", "0.0000", "190000.0000"],
    ]);
    expect(lines[0]).toMatchObject({ party_id: partyId, due_date: "2026-11-29" });
    expect(lines[3]).toMatchObject({ tax_code: "IVA19", tax_base: "1000000.0000" });
    expect(lines.every((l) => l.cost_center_id === ccId)).toBe(true);
    const [audit] = await h.sql`select origin from kernel.audit_log where company_id = ${h.companyId} and process_id = 'accounting.entry.post_from_event' and chain_id = ${chainId} limit 1`;
    expect(audit!.origin).toBe("event");
    const posted = await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.posted' and chain_id = ${chainId}`;
    expect(posted).toHaveLength(1);
  });

  it("post_from_event: redelivered event answers the first entry (one row for the event and rule); two rules on one event make two entries, one each", async () => {
    const { id } = await emit("invoicing.invoice.issued", invoice(dateIn(3, 6)));
    await deliver(id);
    await deliver(id);
    expect(await entriesOf(id)).toHaveLength(1);
    // A second rule on the same event.
    const first = await ruleOf("invoicing.invoice.issued");
    const [rule] = await h.sql<{ template: unknown }[]>`select template from accounting.posting_rules where id = ${first.id}`;
    const second = await h.runStepUp<{ id: string }>(h.admin, "accounting.posting_rule.create", { event: "invoicing.invoice.issued", name: "Copia de la factura", journalId: first.journal_id, template: rule!.template, priority: 200 });
    const again = await emit("invoicing.invoice.issued", invoice(dateIn(3, 7)));
    await deliver(again.id);
    await deliver(again.id);
    const entries = await entriesOf(again.id);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.posting_rule_id))).toEqual(new Set([first.id, second.id]));
    await h.runStepUp(h.admin, "accounting.posting_rule.disable", { id: second.id });
  });

  it("a missing mapping records a posting_failure missing_account_mapping, emits accounting.posting.failed and acknowledges the row; posting.retry after mapping resolves it with the same idempotency key", async () => {
    await h.sql`delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'vat_out'`;
    const { id, chainId } = await emit("invoicing.invoice.issued", invoice(dateIn(3, 8)));
    await deliver(id); // does not throw: configuration problems are acknowledged
    expect(await entriesOf(id)).toHaveLength(0);
    const [failure] = await failuresOf(id);
    expect(failure).toMatchObject({ error_code: "missing_account_mapping", status: "pending", attempts: 1, event: "invoicing.invoice.issued" });
    expect(failure!.error_detail).toContain("vat_out");
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.posting.failed' and chain_id = ${chainId}`).toHaveLength(1);
    // Redelivering the same event updates the same pending row instead of adding one.
    await deliver(id);
    expect(await failuresOf(id)).toHaveLength(1);
    expect((await failuresOf(id))[0]).toMatchObject({ attempts: 2 });

    // Retrying while the mapping is still missing keeps it pending and records the attempt.
    const still = await h.run<{ resolved: boolean; code: string }>(h.admin, "accounting.posting.retry", { failureId: failure!.id as string });
    expect(still).toMatchObject({ resolved: false, code: "missing_account_mapping" });
    expect(await entriesOf(id)).toHaveLength(0);

    const vat = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '240801'`)[0]!.id;
    await h.runStepUp(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "vat_out", accountId: vat }] });
    const done = await h.run<{ resolved: boolean; entryId: string; number: string }>(h.admin, "accounting.posting.retry", { failureId: failure!.id as string });
    expect(done.resolved).toBe(true);
    const [entry] = await entriesOf(id);
    expect(entry).toMatchObject({ id: done.entryId, status: "posted", source_event_id: id });
    expect((await failuresOf(id))[0]).toMatchObject({ status: "resolved", resolved_entry_id: done.entryId });
    await expect(h.run(h.admin, "accounting.posting.retry", { failureId: failure!.id as string })).rejects.toMatchObject({ code: "invalid_input" });
    // The engine still answers the same entry for the same event.
    await deliver(id);
    expect(await entriesOf(id)).toHaveLength(1);
  });

  it("an event dated in a closed period is a closed_period pending; dismiss closes it with a reason", async () => {
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    const { id } = await emit("invoicing.invoice.issued", invoice(dateIn(2, 10)));
    await deliver(id);
    expect(await entriesOf(id)).toHaveLength(0);
    const [failure] = await failuresOf(id);
    expect(failure).toMatchObject({ error_code: "closed_period", status: "pending" });
    const listed = await h.run<{ failures: { id: string; status: string }[] }>(h.admin, "accounting.posting_failure.consult", { status: "pending" });
    expect(listed.failures.map((f) => f.id)).toContain(failure!.id);
    await h.run(h.admin, "accounting.posting_failure.dismiss", { failureId: failure!.id as string, reason: "Duplicado del cliente" });
    expect((await failuresOf(id))[0]).toMatchObject({ status: "dismissed" });
    await expect(h.run(h.admin, "accounting.posting_failure.dismiss", { failureId: failure!.id as string, reason: "x" })).rejects.toMatchObject({ code: "not_found" });
    await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
  });

  it("an event dated before ledger_starts_on is counted in skipped_events and posts nothing", async () => {
    const { id } = await emit("invoicing.invoice.issued", invoice(`${year - 1}-12-20`));
    await deliver(id);
    await deliver(id);
    expect(await entriesOf(id)).toHaveLength(0);
    expect(await failuresOf(id)).toHaveLength(0);
    const skipped = await h.sql`select event, event_date::text as event_date from accounting.skipped_events where company_id = ${h.companyId} and outbox_id = ${id}`;
    expect(skipped).toEqual([{ event: "invoicing.invoice.issued", event_date: `${year - 1}-12-20` }]);
  });

  it("reverseOf rule posts in the note's own period: invoice in a closed March, void dated in open April → reversal dated in April, March untouched", async () => {
    const payload = invoice(dateIn(3, 20));
    const issued = await emit("invoicing.invoice.issued", payload);
    await deliver(issued.id);
    const [original] = await entriesOf(issued.id);
    expect(original!.status).toBe("posted");
    const [march] = await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and number = 3`;
    await h.sql`update accounting.periods set status = 'closed' where id = ${march!.id}`;
    const before = await h.sql`select count(*)::int as n from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id where e.period_id = ${march!.id}`;

    const voided = await emit("invoicing.invoice.voided", { ...voidedFixture, date: dateIn(4, 2), invoiceId: payload.invoiceId });
    await deliver(voided.id);
    const [reversal] = await h.sql`select * from accounting.entries where company_id = ${h.companyId} and reversal_of_id = ${original!.id}`;
    expect(reversal).toMatchObject({ status: "posted", origin: "auto", chain_id: voided.chainId });
    expect(reversal!.date.toISOString().slice(0, 10)).toBe(dateIn(4, 2));
    const [april] = await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and number = 4`;
    expect(reversal!.period_id).toBe(april!.id);
    expect((await h.sql`select status, extra from accounting.entries where id = ${original!.id}`)[0]).toMatchObject({ status: "posted", extra: expect.objectContaining({ reversed: true }) });
    const after = await h.sql`select count(*)::int as n from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id where e.period_id = ${march!.id}`;
    expect(after).toEqual(before);
    expect((await h.sql`select status from accounting.periods where id = ${march!.id}`)[0]).toMatchObject({ status: "closed" });
    // A void for a document with nothing posted is acknowledged without a pending.
    const none = await emit("invoicing.invoice.voided", { ...voidedFixture, date: dateIn(4, 3), invoiceId: randomUUID() });
    await deliver(none.id);
    expect(await failuresOf(none.id)).toHaveLength(0);
    // A void whose date falls in a closed period is a closed_period pending, not an exception.
    const late = await emit("invoicing.invoice.issued", invoice(dateIn(4, 10)));
    await deliver(late.id);
    await h.sql`update accounting.periods set status = 'closed' where id = ${april!.id}`;
    const lateVoid = await emit("invoicing.invoice.voided", { ...voidedFixture, date: dateIn(4, 12), invoiceId: (await h.sql`select source_record_id from accounting.entries where source_event_id = ${late.id}`)[0]!.source_record_id });
    await deliver(lateVoid.id);
    expect((await failuresOf(lateVoid.id))[0]).toMatchObject({ error_code: "closed_period", status: "pending" });
    await h.sql`update accounting.periods set status = 'open' where id in (${april!.id}, ${march!.id})`;
  });

  it("a payment received posts cash, the withholdings suffered with code, rate and base, and the receivable", async () => {
    const { id } = await emit("payments.received", { ...paymentFixture, date: dateIn(5, 5), paymentId: randomUUID(), customer: { partyId, legalName: "Tiendas D1 S.A.S." } });
    await deliver(id);
    const [entry] = await entriesOf(id);
    expect(entry).toMatchObject({ status: "posted", total_debit: "1190000.0000" });
    const lines = await h.sql`
      select a.code, l.debit, l.credit, l.tax_code, l.tax_rate, l.tax_base from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
      where l.entry_id = ${entry!.id} order by l.line_no`;
    // The fixture's method is a transfer: the pack maps payment_method:transfer to the bank (plan 2B Task 21; before it, the cash role's 110505).
    expect(lines.map((l) => [l.code, l.debit, l.credit, l.tax_code])).toEqual([
      ["111005", "1155340.0000", "0.0000", null], ["135515", "25000.0000", "0.0000", "RTEFTE_COMPRAS_2_5"],
      ["135518", "9660.0000", "0.0000", "RTEICA_BOGOTA_0_966"], ["130505", "0.0000", "1190000.0000", null],
    ]);
    expect(lines[1]).toMatchObject({ tax_rate: "2.5000", tax_base: "1000000.0000" });
  });

  it("post_from_event and posting_failure.record are event-only: a user is forbidden and neither is in the sensitive processes list", async () => {
    await expect(h.run(h.admin, "accounting.entry.post_from_event", { entry: {}, ruleId: newId(), eventId: newId() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.run(h.admin, "accounting.posting_failure.record", { eventId: newId(), event: "x", eventDate: "2026-01-01", code: "unbalanced", detail: "x" })).rejects.toMatchObject({ code: "forbidden" });
    const listed = matrixProcesses(h.deps.registry).map((p) => p.id);
    expect(listed).not.toContain("accounting.entry.post_from_event");
    expect(listed).not.toContain("accounting.posting_failure.record");
    expect(listed).toContain("accounting.entry.save");
  });

  it("posting_rule.test previews the entry for a past event without writing; update under step-up marks is_modified; sync_defaults restores nothing modified", async () => {
    const { id } = await emit("invoicing.invoice.issued", invoice(dateIn(6, 3)));
    const rule = await ruleOf("invoicing.invoice.issued");
    const countBefore = (await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n;
    const preview = await h.run<{ ok: boolean; entry: { lines: { accountCode: string; side: string; amountCompany: number }[] } }>(h.admin, "accounting.posting_rule.test", { ruleId: rule.id, outboxId: id });
    expect(preview.ok).toBe(true);
    expect(preview.entry.lines.map((l) => [l.accountCode, l.side, l.amountCompany])).toEqual([
      ["130505", "debit", 1190000], ["413505", "credit", 600000], ["413595", "credit", 400000], ["240801", "credit", 190000],
    ]);
    expect((await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n).toBe(countBefore);

    expect((await h.sql`select is_modified from accounting.posting_rules where id = ${rule.id}`)[0]).toMatchObject({ is_modified: false });
    // The rule's record page reads it with its template and the Fuente it posts to.
    const consulted = await h.run<{ id: string; event: string; journal_code: string; is_modified: boolean; template: { lines: unknown[] } }>(h.admin, "accounting.posting_rule.consult", { id: rule.id });
    expect(consulted).toMatchObject({ id: rule.id, event: "invoicing.invoice.issued", journal_code: "VT", is_modified: false });
    expect(consulted.template.lines.length).toBeGreaterThan(0);
    await expect(h.run(h.admin, "accounting.posting_rule.consult", { id: newId() })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.run(h.admin, "accounting.posting_rule.update", { id: rule.id, name: "Otro nombre" })).rejects.toMatchObject({ code: "step_up_required" });
    await h.runStepUp(h.admin, "accounting.posting_rule.update", { id: rule.id, name: "Factura de venta (editada)", priority: 50 });
    expect((await h.sql`select is_modified, name, priority from accounting.posting_rules where id = ${rule.id}`)[0]).toMatchObject({ is_modified: true, name: "Factura de venta (editada)", priority: 50 });
    // The edited rule is kept; the default with its original name is added back as a separate default only when absent by name.
    const synced = await h.run<{ inserted: number }>(h.admin, "accounting.posting_rule.sync_defaults", {});
    expect(synced.inserted).toBe(1);
    expect((await h.sql`select name from accounting.posting_rules where id = ${rule.id}`)[0]).toMatchObject({ name: "Factura de venta (editada)" });
    // A template the kernel schema rejects, and a role nobody declared, are refused by name.
    await expect(h.runStepUp(h.admin, "accounting.posting_rule.update", { id: rule.id, template: { description: "x", lines: [{ role: "ghost", side: "debit", amount: "$.a" }] } })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("ghost")] });
    await expect(h.runStepUp(h.admin, "accounting.posting_rule.update", { id: rule.id, template: { lines: [] } })).rejects.toMatchObject({ code: "invalid_input" });
    // Another company's event is not found.
    await expect(h.run(h.admin, "accounting.posting_rule.test", { ruleId: rule.id, outboxId: newId() })).rejects.toMatchObject({ code: "not_found" });
  });

  it("effectsFor names the journal of each active rule for the confirmation card", async () => {
    const { accountingProvider } = await import("../posting/provider");
    const { id } = await emit("invoicing.invoice.issued", invoice(dateIn(6, 4)));
    const [row] = await h.sql<{ created_at: Date; chain_id: string }[]>`select created_at, chain_id from kernel.outbox where id = ${id}`;
    const ctx = buildConsumerContext(h.sql, { id, event: "invoicing.invoice.issued", createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, h.deps.registry);
    // The edited rule and the default sync_defaults added back by name are both active: one line per rule.
    expect(await accountingProvider.effectsFor(ctx, "invoicing.invoice.issued")).toEqual(["Contabilidad: asiento en Ventas", "Contabilidad: asiento en Ventas"]);
    expect(await accountingProvider.effectsFor(ctx, "unknown.event")).toEqual([]);
  });

  it("effectsFor: a rule with a `when` is listed only for a payload it holds on; without the payload it is left out (plan 2B Task 25)", async () => {
    const { accountingProvider } = await import("../posting/provider");
    const base = await ruleOf("invoicing.invoice.issued");
    const [rule] = await h.sql<{ template: Record<string, unknown>; journal_id: string }[]>`select template, journal_id from accounting.posting_rules where id = ${base.id}`;
    const event = "dryrun.effects.when";
    await h.runStepUp(h.admin, "accounting.posting_rule.create", {
      event, name: "Solo exportaciones", journalId: rule!.journal_id, template: { ...rule!.template, when: [{ path: "$.export", equals: true }] }, priority: 400,
    });
    const ctx = buildConsumerContext(h.sql, { companyId: h.companyId, chainId: newId() }, h.deps.registry);
    expect(await accountingProvider.effectsFor(ctx, event, { export: true })).toEqual(["Contabilidad: asiento en Ventas"]);
    expect(await accountingProvider.effectsFor(ctx, event, { export: false })).toEqual([]);
    expect(await accountingProvider.effectsFor(ctx, event)).toEqual([]);
  });

  it("the engine refuses a line naming a Pendiente account (D10, usability at Contabilizar): no entry, an inactive_account failure", async () => {
    await h.sql`update accounting.accounts set status = 'pending', requires_approval = true where company_id = ${h.companyId} and code = '413595'`;
    try {
      const { id } = await emit("invoicing.invoice.issued", invoice(dateIn(6, 20)));
      await deliver(id);
      expect((await entriesOf(id)).filter((e) => e.status === "posted")).toHaveLength(0);
      const failures = await failuresOf(id);
      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) {
        expect(failure).toMatchObject({ error_code: "inactive_account", status: "pending" });
        expect(String(failure.error_detail)).toContain("maestro_not_usable");
      }
    } finally {
      await h.sql`update accounting.accounts set status = 'saved', requires_approval = false where company_id = ${h.companyId} and code = '413595'`;
    }
  });
});

// Plan 2B Task 14 review: the void of a source reaches the ledger in one transaction (accounting.posting.reverse_source) that serializes
// with every post of the source's own event: the pendings are locked first, the undelivered events dismissed (their outbox rows locked),
// and only then the entry looked for.
describe("posting: the void of a source vs its own posting", () => {
  let only: string;
  let parked: string[] = [];
  const settled = async (p: Promise<unknown>, ms = 400): Promise<boolean> =>
    Promise.race([p.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
  const pendingOf = (outboxId: string) =>
    h.sql<{ id: string; status: string; posting_rule_id: string | null; extra: Record<string, unknown> }[]>`
      select id, status, posting_rule_id, extra from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${outboxId} order by seq`;
  const markOf = async (outboxId: string) => (await h.sql`select 1 from kernel.outbox_deliveries where outbox_id = ${outboxId} and module_id = 'accounting'`).length;
  const voidOf = (invoiceId: string, date = dateIn(4, 20)) => emit("invoicing.invoice.voided", { ...voidedFixture, date, invoiceId });
  const reversalOf = (entryId: string) => h.sql`select id, status from accounting.entries where reversal_of_id = ${entryId}`;

  beforeAll(async () => {
    // One active rule on the invoice (earlier tests left a second one active): each invoice posts one entry.
    only = (await ruleOf("invoicing.invoice.issued")).id;
    parked = (await h.sql<{ id: string }[]>`
      update accounting.posting_rules set is_active = false
       where company_id = ${h.companyId} and event = 'invoicing.invoice.issued' and id <> ${only} and is_active returning id`).map((r) => r.id);
  });
  afterAll(async () => {
    if (parked.length > 0) await h.sql`update accounting.posting_rules set is_active = true where id = any(${parked}::uuid[])`;
    await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
  });

  it("dismisses only the voided source's pending, with the code source_voided: another source's pending of the same event and a rule without a source survive", async () => {
    const [rule] = await h.sql<{ template: Record<string, unknown>; journal_id: string }[]>`select template, journal_id from accounting.posting_rules where id = ${only}`;
    const sourceless = Object.fromEntries(Object.entries(rule!.template).filter(([key]) => key !== "source"));
    const bare = await h.runStepUp<{ id: string }>(h.admin, "accounting.posting_rule.create", {
      event: "invoicing.invoice.issued", name: "Sin origen", journalId: rule!.journal_id, template: sourceless, priority: 300,
    });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    try {
      const x = invoice(dateIn(2, 11));
      const y = invoice(dateIn(2, 12));
      const issuedX = await emit("invoicing.invoice.issued", x);
      const issuedY = await emit("invoicing.invoice.issued", y);
      await deliver(issuedX.id);
      await deliver(issuedY.id);
      expect((await pendingOf(issuedX.id)).map((f) => f.status)).toEqual(["pending", "pending"]);

      const voided = await voidOf(x.invoiceId);
      await deliver(voided.id);
      const mine = await pendingOf(issuedX.id);
      const sourced = mine.find((f) => f.posting_rule_id === only)!;
      expect(sourced).toMatchObject({ status: "dismissed", extra: expect.objectContaining({ dismiss_code: "source_voided", dismissed_by_event: voided.id }) });
      // The code is catalogue-neutral (rule 24): no copy is stored, the inbox names it from accounting.values.dismiss_code.
      expect(sourced.extra).not.toHaveProperty("dismiss_reason");
      expect(mine.find((f) => f.posting_rule_id === bare.id)).toMatchObject({ status: "pending" });
      expect((await pendingOf(issuedY.id)).map((f) => f.status)).toEqual(["pending", "pending"]);
      expect(await failuresOf(voided.id)).toHaveLength(0);
      // Redelivered, the void changes nothing more (its idempotency key).
      await deliver(voided.id);
      expect((await pendingOf(issuedY.id)).map((f) => f.status)).toEqual(["pending", "pending"]);
    } finally {
      await h.runStepUp(h.admin, "accounting.posting_rule.disable", { id: bare.id });
      await h.sql`update accounting.posting_failures set status = 'dismissed' where company_id = ${h.companyId} and posting_rule_id = ${bare.id} and status = 'pending'`;
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
    }
  });

  it("a void before the source's event was consumed marks it handled: a post already past the engine's check finds the mark and writes nothing", async () => {
    const { postingConsumer } = await import("@erp/kernel");
    const { accountingProvider } = await import("../posting/provider");
    const z = invoice(dateIn(4, 5));
    const issued = await emit("invoicing.invoice.issued", z);
    const voided = await voidOf(z.invoiceId);
    await deliver(voided.id);
    expect(await markOf(issued.id)).toBe(1);
    // The engine skips it (the mark) …
    await deliver(issued.id);
    expect(await entriesOf(issued.id)).toHaveLength(0);
    // … and a post that was already past that check (a consumer without the check) re-checks under the outbox row lock: nothing is written.
    const [row] = await h.sql<{ created_at: Date; chain_id: string; payload: unknown }[]>`select created_at, chain_id, payload from kernel.outbox where id = ${issued.id}`;
    const ctx = buildConsumerContext(h.sql, { id: issued.id, event: "invoicing.invoice.issued", createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, h.deps.registry);
    await postingConsumer(accountingProvider)(ctx, row!.payload);
    expect(await entriesOf(issued.id)).toHaveLength(0);
    expect(await failuresOf(issued.id)).toHaveLength(0);
  });

  it("kernel.dismiss_events waits for the event's outbox row: a void blocks while a post holds it, and reverses what that post committed", async () => {
    const w = invoice(dateIn(4, 6));
    const issued = await emit("invoicing.invoice.issued", w);
    const voided = await voidOf(w.invoiceId);
    // A post in flight holds the event's row (kernel.lock_event_for takes it FOR UPDATE).
    const holder = await h.sql.reserve();
    try {
      await holder`begin`;
      await holder`select id from kernel.outbox where id = ${issued.id} for update`;
      const voiding = deliver(voided.id);
      expect(await settled(voiding)).toBe(false);
      // The holder ends without posting: the void then marks the event before any post can take the row.
      await holder`commit`;
      await voiding;
    } finally {
      holder.release();
    }
    // The void ran first once the row was free: nothing posted then, the event is marked, and the post afterwards writes nothing.
    await deliver(issued.id);
    expect(await entriesOf(issued.id)).toHaveLength(0);

    // The other order: the post committed while the void waited on the pending rows → the void finds and reverses the entry.
    const v = invoice(dateIn(4, 7));
    const issuedV = await emit("invoicing.invoice.issued", v);
    const voidedV = await voidOf(v.invoiceId);
    const posting = deliver(issuedV.id);
    const voiding = deliver(voidedV.id);
    await Promise.all([posting, voiding]);
    const entries = await entriesOf(issuedV.id);
    // Whichever ran first, the ledger is consistent: either nothing posted, or it posted and is reversed.
    if (entries.length === 1) expect(await reversalOf(entries[0]!.id as string)).toHaveLength(1);
    else expect(entries).toHaveLength(0);
  });

  it("posting.retry vs the void of its source: in either order (and concurrently) the pending ends resolved and reversed, or dismissed with nothing posted", async () => {
    const parkedPending = async () => {
      await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
      const inv = invoice(dateIn(2, 15));
      const issued = await emit("invoicing.invoice.issued", inv);
      await deliver(issued.id);
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
      const [failure] = await pendingOf(issued.id);
      expect(failure).toMatchObject({ status: "pending" });
      return { inv, issued, failureId: failure!.id };
    };

    // Retry first, then the void: the void re-checks the entry after locking the (now resolved) pending, and reverses it.
    const a = await parkedPending();
    expect(await h.run<{ resolved: boolean }>(h.admin, "accounting.posting.retry", { failureId: a.failureId })).toMatchObject({ resolved: true });
    const voidA = await voidOf(a.inv.invoiceId);
    await deliver(voidA.id);
    const [entryA] = await entriesOf(a.issued.id);
    expect(await reversalOf(entryA!.id as string)).toHaveLength(1);

    // The void first, then the retry: the pending is dismissed, the retry is refused and nothing posts.
    const b = await parkedPending();
    const voidB = await voidOf(b.inv.invoiceId);
    await deliver(voidB.id);
    expect((await pendingOf(b.issued.id))[0]).toMatchObject({ status: "dismissed" });
    await expect(h.run(h.admin, "accounting.posting.retry", { failureId: b.failureId })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await entriesOf(b.issued.id)).toHaveLength(0);

    // Both at once, released together from a held lock on the pending row.
    const c = await parkedPending();
    const voidC = await voidOf(c.inv.invoiceId);
    const holder = await h.sql.reserve();
    let retried: Promise<unknown>;
    let voiding: Promise<unknown>;
    try {
      await holder`begin`;
      await holder`select id from accounting.posting_failures where id = ${c.failureId} for update`;
      retried = h.run(h.admin, "accounting.posting.retry", { failureId: c.failureId }).catch((error: unknown) => error);
      voiding = deliver(voidC.id);
      expect(await settled(voiding)).toBe(false);
      await holder`commit`;
    } finally {
      holder.release();
    }
    await Promise.all([retried!, voiding!]);
    const [failureC] = await pendingOf(c.issued.id);
    const entriesC = await entriesOf(c.issued.id);
    if (failureC!.status === "resolved") {
      expect(entriesC).toHaveLength(1);
      expect(await reversalOf(entriesC[0]!.id as string)).toHaveLength(1);
    } else {
      expect(failureC).toMatchObject({ status: "dismissed", extra: expect.objectContaining({ dismiss_code: "source_voided" }) });
      expect(entriesC).toHaveLength(0);
    }
  });

  // Review round 2 (N1): a pending recorded while (or after) the void runs never stays live, and no retry posts a voided source.
  it("a post failing into a pending while the void runs: no live pending remains and the retry does not post", async () => {
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    const inv = invoice(dateIn(2, 18));
    const issued = await emit("invoicing.invoice.issued", inv);
    const voided = await voidOf(inv.invoiceId);
    // Both wait on the event's outbox row; the post queues first, fails (closed period), and records its pending while the void goes on.
    const holder = await h.sql.reserve();
    let posting: Promise<unknown>;
    let voiding: Promise<unknown>;
    try {
      await holder`begin`;
      await holder`select id from kernel.outbox where id = ${issued.id} for update`;
      posting = deliver(issued.id);
      await settled(posting, 200);
      voiding = deliver(voided.id);
      expect(await settled(voiding, 200)).toBe(false);
      await holder`commit`;
    } finally {
      holder.release();
    }
    await Promise.all([posting!, voiding!]);
    expect((await pendingOf(issued.id)).filter((f) => f.status === "pending")).toEqual([]);
    await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
    for (const f of await pendingOf(issued.id)) {
      const out = await h.run<{ resolved: boolean }>(h.admin, "accounting.posting.retry", { failureId: f.id }).catch((error: { code: string }) => error);
      expect(out).not.toMatchObject({ resolved: true });
    }
    expect(await entriesOf(issued.id)).toHaveLength(0);
    expect(await h.sql`select 1 from accounting.voided_sources where company_id = ${h.companyId} and source_id = ${inv.invoiceId}`).toHaveLength(1);
  });

  it("after the void: a pending recorded late is not recorded, and a retry of a live pending of the voided source dismisses it (source_voided) instead of posting", async () => {
    const inv = invoice(dateIn(4, 21));
    const issued = await emit("invoicing.invoice.issued", inv);
    const voided = await voidOf(inv.invoiceId);
    await deliver(voided.id);
    const [row] = await h.sql<{ created_at: Date; chain_id: string; payload: unknown }[]>`select created_at, chain_id, payload from kernel.outbox where id = ${issued.id}`;
    const ctx = buildConsumerContext(h.sql, { id: issued.id, event: "invoicing.invoice.issued", createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, h.deps.registry);
    // A rule that failed on the event after the void (an engine run already past its own checks) records nothing.
    const recorded = await ctx.runProcess("accounting.posting_failure.record", {
      eventId: issued.id, event: "invoicing.invoice.issued", eventDate: dateIn(4, 21), ruleId: only, payload: row!.payload, code: "closed_period", detail: "x",
    });
    expect(recorded).toEqual({ id: null, dismissed: true });
    expect(await pendingOf(issued.id)).toEqual([]);
    // A live pending of the voided source (written before the void's lock, by whatever path): the retry dismisses it, nothing posts.
    const [live] = await h.sql<{ id: string }[]>`
      insert into accounting.posting_failures (company_id, event_id, event, event_date, posting_rule_id, payload, error_code, error_detail)
      values (${h.companyId}, ${issued.id}, 'invoicing.invoice.issued', ${dateIn(4, 21)}, ${only}, ${h.sql.json(row!.payload as never)}, 'closed_period', 'x') returning id`;
    expect(await h.run(h.admin, "accounting.posting.retry", { failureId: live!.id })).toMatchObject({ resolved: false, code: "source_voided" });
    expect((await pendingOf(issued.id))[0]).toMatchObject({ status: "dismissed", extra: expect.objectContaining({ dismiss_code: "source_voided" }) });
    await expect(h.run(h.admin, "accounting.posting.retry", { failureId: live!.id })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await entriesOf(issued.id)).toHaveLength(0);
  });
});
