import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers } from "@erp/kernel";
import { postingModeHarness, type Harness } from "./posting-mode-harness";

// Posting mode (plan 2B Task 33, owner decisions item 5, R33-1..R33-10): `accounting.settings.posting_mode` chooses, per company, between inline
// strict (the default: a contabiliza documento posts in its own action and rolls back when it cannot) and asynchronous (the action commits, the
// event waits in the outbox and the accounting consumer posts it, a refusal goes to the retry queue). Every contabiliza documento reaches the
// ledger through emitAndPostStrict, so the mode applies to all of them; `asyncCase` names the processes each case covers, and
// async-mode-coverage.integration.test.ts fails when a process of the derived set has no case here.

let h: Harness;
/** A case of the asynchronous mode for the documentos (process ids) it covers; read by async-mode-coverage.integration.test.ts. */
const asyncCase = (processIds: string[], title: string, fn: () => Promise<void>) => it(`${title} [${processIds.join(", ")}]`, fn);

beforeAll(async () => {
  h = await postingModeHarness();
}, 300_000);
afterAll(async () => {
  await h?.cleanup();
});

const IVA = 1.19;
/** The accounting row of the settings and its mode. */
const mode = async () => (await h.sql<{ posting_mode: string }[]>`select posting_mode from accounting.settings where company_id = ${h.companyId}`)[0]!.posting_mode;
const balanced = async () => {
  const l = await h.ledger();
  expect(l.debit).toBeCloseTo(l.credit, 4);
};
const pendingFailures = () => h.count("accounting.posting_failures", "status = 'pending'");

describe("(1) inline strict is the default", () => {
  it("a configured company is inline_strict, and an issued invoice posts in its own action", async () => {
    expect(await mode()).toBe("inline_strict");
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ postingMode: "inline_strict", pendingDocuments: 0, pendingFailures: 0 });
    const invoice = await h.issuedInvoice();
    expect(await h.entriesOf(invoice.id)).toHaveLength(1);
    expect(await h.eventsOf("invoicing.invoice.issued", "invoiceId", invoice.id)).toEqual([expect.objectContaining({ delivered: true })]);
    expect(await h.pending(invoice.id)).toEqual([]);
  });
});

describe("(2) asynchronous: each documento commits without its entry, the consumer posts it", () => {
  beforeAll(async () => {
    const out = await h.setMode("asynchronous");
    expect(out).toMatchObject({ mode: "asynchronous", previous: "inline_strict", pendingFailures: 0, pendingDocuments: 0 });
  });

  /** The action committed, its source has no entry and its event waits; the consumer posts it; the row clears; the trial balance includes it only after. */
  const postsLater = async (sourceId: string, event: string, key: string, expected: { entries: number; reversal?: boolean } = { entries: 1 }) => {
    const before = await h.trialDebit();
    const already = (await h.entriesOf(sourceId)).length;
    expect((await h.eventsOf(event, key, sourceId)).filter((e) => !e.delivered)).toHaveLength(1);
    expect(await h.pending(sourceId)).toEqual([expect.objectContaining({ source_id: sourceId, event, state: "queued", failure_id: null })]);
    expect(await h.trialDebit()).toBe(before);
    expect(await h.drain()).toEqual([]);
    const entries = await h.entriesOf(sourceId);
    expect(entries).toHaveLength(already + expected.entries);
    const added = entries.slice(already);
    for (const e of added) expect(e).toMatchObject({ status: "posted", total_debit: e.total_credit });
    if (expected.reversal) expect(added[0]!.reversal_of_id).not.toBeNull();
    expect(await h.pending(sourceId)).toEqual([]);
    const posted = added.reduce((s, e) => s + Number(e.total_debit), 0);
    expect(await h.trialDebit()).toBeCloseTo(before + posted, 2);
    await balanced();
  };

  asyncCase(["invoicing.invoice.issue"], "an invoice issued in asynchronous mode posts when the consumer runs", async () => {
    const invoice = await h.issuedInvoice(2);
    expect(invoice.total).toBe(2 * 100000 * IVA);
    expect(await h.entriesOf(invoice.id)).toEqual([]);
    await postsLater(invoice.id, "invoicing.invoice.issued", "invoiceId");
  });

  asyncCase(["invoicing.note.issue"], "a credit note issued in asynchronous mode posts when the consumer runs", async () => {
    const invoice = await h.issuedInvoice(2);
    expect(await h.drain()).toEqual([]);
    const note = await h.issuedNote(invoice.id);
    expect(await h.entriesOf(note.id)).toEqual([]);
    await postsLater(note.id, "invoicing.note.issued", "noteId");
  });

  asyncCase(["payments.payment.receive", "payments.payment.void"], "a receipt and its void post when the consumer runs", async () => {
    const invoice = await h.issuedInvoice();
    expect(await h.drain()).toEqual([]);
    const receipt = await h.receive(invoice.id, invoice.total);
    expect(await h.entriesOf(receipt.id)).toEqual([]);
    await postsLater(receipt.id, "payments.received", "paymentId");
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" });
    // The void's event names the receipt as its source (the reversal's rule), so the receipt shows the pending reversal.
    await postsLater(receipt.id, "payments.payment.voided", "paymentId", { entries: 1, reversal: true });
  });

  asyncCase(["payments.advance.apply", "payments.advance.undo"], "an advance application and its undo post when the consumer runs", async () => {
    const invoice = await h.issuedInvoice();
    expect(await h.drain()).toEqual([]);
    const advance = await h.run<{ id: string }>(h.admin, "payments.payment.receive", { partyId: h.customerId, methodId: h.transfer, amount: invoice.total, date: h.today, allocations: [] });
    await postsLater(advance.id, "payments.received", "paymentId");
    const application = await h.run<{ id: string; number: string }>(h.admin, "payments.advance.apply", {
      partyId: h.customerId, lines: [{ receiptId: advance.id, invoiceId: invoice.id, amount: invoice.total }],
    });
    expect(await h.entriesOf(application.id)).toEqual([]);
    await postsLater(application.id, "payments.advance.applied", "applicationId");
    await h.runStepUp("payments.advance.undo", { id: application.id, reason: "Aplicación equivocada" });
    await postsLater(application.id, "payments.advance.unapplied", "applicationId", { entries: 1, reversal: true });
  });

  asyncCase(["invoicing.invoice.void", "invoicing.note.issue_annulment"], "an invoice voided by its annulment note posts the note when the consumer runs", async () => {
    const invoice = await h.issuedInvoice();
    expect(await h.drain()).toEqual([]);
    const out = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Error en el cliente" });
    expect(await h.entriesOf(out.annulmentNoteId)).toEqual([]);
    await postsLater(out.annulmentNoteId, "invoicing.note.issued", "noteId");
  });

  asyncCase(["costing.landed_cost.allocate", "costing.landed_cost.void"], "a landed cost and its void post when the consumer runs", async () => {
    const movementId = await h.stockReceipt("LC-A1");
    expect(await h.drain(["costing", "accounting"])).toEqual([]);
    const landed = await h.allocate(movementId, 500);
    expect(landed.status).toBe("posted");
    expect(await h.entriesOf(landed.id)).toEqual([]);
    await postsLater(landed.id, "costing.landed_cost.allocated", "landedCostId");
    await h.runStepUp("costing.landed_cost.void", { id: landed.id, reason: "Flete duplicado" });
    await postsLater(landed.id, "costing.landed_cost.voided", "landedCostId", { entries: 1, reversal: true });
  });
});

describe("(3) a failing rule in asynchronous mode goes to the retry queue; the action still commits", () => {
  it("no account for a role: the invoice commits, the consumer records a pending, a fixed mapping and a retry post it once", async () => {
    expect(await mode()).toBe("asynchronous");
    const saved = await h.sql<{ id: string; account_id: string }[]>`
      delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'receivable' and dimension is null returning id, account_id`;
    expect(saved).toHaveLength(1);
    const invoice = await h.issuedInvoice();
    expect((await h.sql`select stage from invoicing.invoices where id = ${invoice.id}`)[0]).toEqual({ stage: "issued" });
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(invoice.id)).toEqual([]);
    const [failed] = await h.pending(invoice.id);
    expect(failed).toMatchObject({ source_id: invoice.id, event: "invoicing.invoice.issued", state: "failed", failure_id: expect.any(String) });
    const [failure] = await h.sql<{ error_code: string; status: string }[]>`select error_code, status from accounting.posting_failures where id = ${failed!.failure_id}`;
    expect(failure).toEqual({ error_code: "missing_account_mapping", status: "pending" });
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ pendingFailures: 1, pendingDocuments: 0 });

    await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "receivable", accountId: saved[0]!.account_id }] });
    expect(await h.run(h.admin, "accounting.posting.retry", { failureId: failed!.failure_id })).toMatchObject({ resolved: true });
    const entries = await h.entriesOf(invoice.id);
    expect(entries).toHaveLength(1);
    expect(await h.pending(invoice.id)).toEqual([]);
    // A second retry and a second consumer run post nothing more: one entry, the same id.
    await expect(h.run(h.admin, "accounting.posting.retry", { failureId: failed!.failure_id })).rejects.toMatchObject({ code: "invalid_input" });
    const [event] = await h.sql<{ id: string; event: string; payload: unknown; created_at: Date; chain_id: string }[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoice.id}`;
    const consumer = consumers.for(event!.event).find((c) => c.moduleId === "accounting")!;
    await consumer.fn(buildConsumerContext(h.sql, { id: event!.id, event: event!.event, createdAt: event!.created_at, companyId: h.companyId, chainId: event!.chain_id }, h.registry), event!.payload);
    expect((await h.entriesOf(invoice.id)).map((e) => e.id)).toEqual(entries.map((e) => e.id));
    expect(await pendingFailures()).toBe(0);
    await balanced();
  });

  it("a closed period behaves the same: pending, reopen, retry", async () => {
    const [period] = await h.sql<{ id: string }[]>`
      select p.id from accounting.periods p where p.company_id = ${h.companyId} and ${h.today}::date between p.starts_on and p.ends_on`;
    await h.sql`update accounting.periods set status = 'closed' where id = ${period!.id}`;
    try {
      const invoice = await h.issuedInvoice();
      expect(await h.drain()).toEqual([]);
      const [failed] = await h.pending(invoice.id);
      expect(failed).toMatchObject({ state: "failed" });
      expect((await h.sql`select error_code from accounting.posting_failures where id = ${failed!.failure_id}`)[0]).toEqual({ error_code: "closed_period" });
      await h.sql`update accounting.periods set status = 'open' where id = ${period!.id}`;
      expect(await h.run(h.admin, "accounting.posting.retry", { failureId: failed!.failure_id })).toMatchObject({ resolved: true });
      expect(await h.entriesOf(invoice.id)).toHaveLength(1);
      expect(await h.pending(invoice.id)).toEqual([]);
    } finally {
      await h.sql`update accounting.periods set status = 'open' where id = ${period!.id}`;
    }
  });
});

describe("(4) the same failing rule in inline mode still rolls the action back", () => {
  it("no account for a role: Emitir is refused and the invoice stays a draft", async () => {
    await h.setMode("inline_strict");
    const saved = await h.sql<{ account_id: string }[]>`
      delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'receivable' and dimension is null returning account_id`;
    try {
      const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.customerId, paymentForm: "2", lines: [{ productId: h.servicio, qty: 1 }] });
      const before = { entries: await h.count("accounting.entries"), failures: await h.count("accounting.posting_failures") };
      const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
      expect(refused?.message).toMatch(/missing_account_mapping/);
      expect((await h.sql`select stage from invoicing.invoices where id = ${draft.id}`)[0]).toEqual({ stage: "draft" });
      expect({ entries: await h.count("accounting.entries"), failures: await h.count("accounting.posting_failures") }).toEqual(before);
      expect(await h.eventsOf("invoicing.invoice.issued", "invoiceId", draft.id)).toEqual([]);
    } finally {
      await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "receivable", accountId: saved[0]!.account_id }] });
    }
  });
});

describe("(5) void while queued", () => {
  it("a receipt voided while its event still waits never reaches the ledger: no entry, no pending, balanced", async () => {
    await h.setMode("asynchronous");
    const invoice = await h.issuedInvoice();
    expect(await h.drain()).toEqual([]);
    const receipt = await h.receive(invoice.id, invoice.total);
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" });
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(receipt.id)).toEqual([]);
    expect(await h.pending(receipt.id)).toEqual([]);
    expect(await pendingFailures()).toBe(0);
    await balanced();
  });
});

// Fix round 1 (review C1): an inline void after switching back from asynchronous follows the voided-source protocol of
// accounting.posting.reverse_source: the source is recorded voided and its pendings dismissed, so a retry of the original never posts.
describe("(5b) inline void of a source whose posting waits from the asynchronous mode", () => {
  it("the original failed: switch to inline, void, fix the mapping and retry: no entry, the pending dismissed, balanced", async () => {
    await h.setMode("asynchronous");
    const invoice = await h.issuedInvoice();
    expect(await h.drain()).toEqual([]);
    const saved = await h.sql<{ account_id: string }[]>`
      delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'receivable' and dimension is null returning account_id`;
    let failureId: string;
    let receiptId: string;
    try {
      const receipt = await h.receive(invoice.id, invoice.total);
      receiptId = receipt.id;
      expect(await h.drain()).toEqual([]);
      const [failed] = await h.pending(receipt.id);
      expect(failed).toMatchObject({ state: "failed", event: "payments.received" });
      failureId = failed!.failure_id!;
      await h.setMode("inline_strict");
      await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" });
    } finally {
      await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "receivable", accountId: saved[0]!.account_id }] });
    }
    expect((await h.sql`select status, extra->>'dismiss_code' as code from accounting.posting_failures where id = ${failureId!}`)[0]).toEqual({ status: "dismissed", code: "source_voided" });
    expect(await h.count("accounting.voided_sources", `source_id = '${receiptId!}' and event = 'payments.received'`)).toBe(1);
    await expect(h.run(h.admin, "accounting.posting.retry", { failureId: failureId! })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(receiptId!)).toEqual([]);
    expect(await h.pending(receiptId!)).toEqual([]);
    await balanced();
  });

  it("the original still queued: switch to inline, void: the consumer never posts it; the source is recorded voided", async () => {
    await h.setMode("asynchronous");
    const invoice = await h.issuedInvoice();
    expect(await h.drain()).toEqual([]);
    const receipt = await h.receive(invoice.id, invoice.total);
    await h.setMode("inline_strict");
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" });
    expect(await h.count("accounting.voided_sources", `source_id = '${receipt.id}' and event = 'payments.received'`)).toBe(1);
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(receipt.id)).toEqual([]);
    expect(await h.pending(receipt.id)).toEqual([]);
    expect(await pendingFailures()).toBe(0);
    await balanced();
  });

  it("an inline void of a posted original still reverses it in the same action (and records the source voided)", async () => {
    expect(await mode()).toBe("inline_strict");
    const invoice = await h.issuedInvoice();
    const receipt = await h.receive(invoice.id, invoice.total);
    expect(await h.entriesOf(receipt.id)).toHaveLength(1);
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" });
    const entries = await h.entriesOf(receipt.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.reversal_of_id).toBe(entries[0]!.id);
    expect(await h.count("accounting.voided_sources", `source_id = '${receipt.id}' and event = 'payments.received'`)).toBe(1);
    await balanced();
  });
});

// Fix round 1 (review I1): an event the dispatcher dead-lettered before accounting ran is still a document outside the ledger.
describe("(5c) dead-lettered posting events", () => {
  it("show as `dead` in pending_postings and count as documents awaiting posting; one accounting already handled does not", async () => {
    await h.setMode("asynchronous");
    const invoice = await h.issuedInvoice();
    const [event] = await h.eventsOf("invoicing.invoice.issued", "invoiceId", invoice.id);
    const dead = (delivered: string[]) => h.sql`
      with moved as (delete from kernel.outbox where id = ${event!.id} returning *)
      insert into kernel.outbox_dead_letter (id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, last_error, failed_at, delivered_modules)
      select id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, 'invalid_input: fallo de prueba', now(), ${delivered}::text[] from moved`;
    await dead(["invoicing"]);
    try {
      expect(await h.pending(invoice.id)).toEqual([expect.objectContaining({ source_id: invoice.id, event: "invoicing.invoice.issued", state: "dead", failure_id: null })]);
      expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ pendingDocuments: 1 });
      expect(await h.pending(invoice.id, h.otherAdmin)).toEqual([]);
      await h.sql`update kernel.outbox_dead_letter set delivered_modules = array['invoicing', 'accounting'] where id = ${event!.id}`;
      expect(await h.pending(invoice.id)).toEqual([]);
    } finally {
      await h.sql`delete from kernel.outbox_dead_letter where id = ${event!.id}`;
    }
    await h.setMode("inline_strict");
  });
});

describe("(6) switching the mode never rewrites anything", () => {
  it("inline → asynchronous → inline: entries stay, the queue posts afterwards, nothing is reposted; the counts come back; audited", async () => {
    await h.setMode("inline_strict");
    expect(await h.drain()).toEqual([]);
    const entries0 = await h.count("accounting.entries");
    const a = await h.issuedInvoice();
    expect(await h.entriesOf(a.id)).toHaveLength(1);
    const toAsync = await h.setMode("asynchronous");
    expect(toAsync).toMatchObject({ mode: "asynchronous", previous: "inline_strict", pendingDocuments: 0, pendingFailures: 0 });
    const b = await h.issuedInvoice();
    expect(await h.entriesOf(b.id)).toEqual([]);
    // Back to inline with a non-empty queue: allowed, and the result says what is still waiting.
    const toInline = await h.setMode("inline_strict");
    expect(toInline).toMatchObject({ mode: "inline_strict", previous: "asynchronous", pendingDocuments: 1, pendingFailures: 0 });
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ postingMode: "inline_strict", pendingDocuments: 1, pendingFailures: 0 });
    const c = await h.issuedInvoice();
    expect(await h.entriesOf(c.id)).toHaveLength(1);
    // The queued event posts under the inline mode (the consumer is mode-blind); the inline ones are not composed again.
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(b.id)).toHaveLength(1);
    expect(await h.drain()).toEqual([]);
    expect(await h.count("accounting.entries")).toBe(entries0 + 3);
    for (const id of [a.id, b.id, c.id]) expect(await h.entriesOf(id)).toHaveLength(1);

    const audits = await h.sql<{ diff: { posting_mode?: { old: string; new: string } }; origin: string; actor_user_id: string; chain_id: string; process_id: string }[]>`
      select diff, origin, actor_user_id, chain_id, process_id from kernel.audit_log
      where company_id = ${h.companyId} and entity = 'accounting.settings' and action = 'update' and diff ? 'posting_mode' order by occurred_at desc limit 2`;
    expect(audits.map((r) => r.diff.posting_mode)).toEqual([{ old: "asynchronous", new: "inline_strict" }, { old: "inline_strict", new: "asynchronous" }]);
    for (const r of audits) expect(r).toMatchObject({ origin: "ui", actor_user_id: h.admin.claims.sub, chain_id: expect.any(String), process_id: "accounting.posting_mode.set" });
  });

  it("setting the mode it already has changes nothing and says so", async () => {
    expect(await h.setMode("inline_strict")).toMatchObject({ mode: "inline_strict", previous: "inline_strict" });
  });
});

describe("(7) permission and step-up", () => {
  it("refuses without a fresh code, refuses a role without the permission, refuses when accounting is not configured", async () => {
    await expect(h.run(h.admin, "accounting.posting_mode.set", { mode: "asynchronous" })).rejects.toMatchObject({ code: "step_up_required" });
    await expect(h.setMode("asynchronous", h.member)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.setMode("asynchronous", h.otherAdmin)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/not configured/) });
    await expect(h.runStepUp("accounting.posting_mode.set", { mode: "sometimes" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await mode()).toBe("inline_strict");
  });

  it("settings.update rejects the mode; a direct update as a user is refused by the trigger, as the service it passes", async () => {
    await expect(h.runStepUp("accounting.settings.update", { postingMode: "asynchronous" })).rejects.toMatchObject({ code: "invalid_input" });
    const direct = h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...h.admin.claims })}, true), set_config('role', 'authenticated', true)`;
      await tx`update accounting.settings set posting_mode = 'asynchronous' where company_id = ${h.companyId}`;
    });
    await expect(direct).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/accounting\.posting_mode\.set/) });
    // Inside another process run it is refused just the same.
    const other = h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...h.admin.claims })}, true), set_config('role', 'authenticated', true)`;
      await tx`select set_config('erp.audit_process_id', 'accounting.settings.update', true)`;
      await tx`update accounting.settings set posting_mode = 'asynchronous' where company_id = ${h.companyId}`;
    });
    await expect(other).rejects.toMatchObject({ code: "42501" });
    expect(await mode()).toBe("inline_strict");
    await h.sql`update accounting.settings set posting_mode = 'asynchronous' where company_id = ${h.companyId}`;
    expect(await mode()).toBe("asynchronous");
    await h.sql`update accounting.settings set posting_mode = 'inline_strict' where company_id = ${h.companyId}`;
    await expect(h.sql`update accounting.settings set posting_mode = 'sometimes' where company_id = ${h.companyId}`).rejects.toThrow(/settings_posting_mode_check/);
  });
});

describe("(8) RLS", () => {
  it("company B's user reads neither company A's mode nor its pending postings; anon is refused", async () => {
    await h.setMode("asynchronous");
    const invoice = await h.issuedInvoice();
    expect(await h.pending(invoice.id)).toHaveLength(1);
    expect(await h.pending(invoice.id, h.otherAdmin)).toEqual([]);
    expect((await h.pending(undefined, h.otherAdmin)).filter((r) => r.source_id === invoice.id)).toEqual([]);
    let rows: readonly unknown[] = [];
    await h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...h.otherAdmin.claims })}, true), set_config('role', 'authenticated', true)`;
      rows = await tx`select posting_mode from accounting.settings where company_id = ${h.companyId}`;
    });
    expect(rows).toEqual([]);
    expect(await h.run(h.otherAdmin, "accounting.settings.consult", {})).toMatchObject({ configured: false, postingMode: "inline_strict", pendingDocuments: 0 });
    const anon = h.sql.begin(async (tx) => {
      await tx`select set_config('role', 'anon', true)`;
      return tx`select * from accounting.pending_postings()`;
    });
    await expect(anon).rejects.toMatchObject({ code: "42501" });
    expect(await h.drain()).toEqual([]);
  });
});

describe("(9) entitlements in asynchronous mode (Task 50.9)", () => {
  it("accounting switched off: the action succeeds, the event parks and shows as pending; enabling accounting posts it", async () => {
    expect(await mode()).toBe("asynchronous");
    await h.setAccounting(false);
    let invoiceId: string;
    try {
      const invoice = await h.issuedInvoice();
      invoiceId = invoice.id;
      expect(await h.entriesOf(invoiceId)).toEqual([]);
      expect(await h.eventsOf("invoicing.invoice.issued", "invoiceId", invoiceId)).toEqual([expect.objectContaining({ delivered: false })]);
      // The reader says queued; the screen labels it «Contabilidad desactivada» (stage B, pending.ts).
      expect(await h.pending(invoiceId)).toEqual([expect.objectContaining({ state: "queued" })]);
    } finally {
      await h.setAccounting(true);
    }
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(invoiceId!)).toHaveLength(1);
    expect(await h.pending(invoiceId!)).toEqual([]);
  });

  it("never bought: the action succeeds and the event parks unhandled (not_entitled), as in inline mode", async () => {
    await h.sql`update kernel.tenant_entitlements set enabled = false where tenant_id = ${h.seed.tenantId} and key = 'module:accounting'`;
    let invoiceId: string;
    try {
      const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.customerId, paymentForm: "2", lines: [{ productId: h.servicio, qty: 1 }] });
      invoiceId = (await h.run<{ id: string }>(h.admin, "invoicing.invoice.issue", { id: draft.id })).id;
      expect(await h.entriesOf(invoiceId)).toEqual([]);
      expect(await h.eventsOf("invoicing.invoice.issued", "invoiceId", invoiceId)).toEqual([expect.objectContaining({ delivered: false })]);
    } finally {
      await h.sql`update kernel.tenant_entitlements set enabled = true where tenant_id = ${h.seed.tenantId} and key = 'module:accounting'`;
    }
    // Once bought again the replayed event posts.
    expect(await h.drain()).toEqual([]);
    expect(await h.entriesOf(invoiceId!)).toHaveLength(1);
  });
});

describe("(10) an event dated before the ledger start in asynchronous mode", () => {
  it("is counted skipped by the consumer: no entry, no pending", async () => {
    const [{ start }] = await h.sql<[{ start: string }]>`select ledger_starts_on::text as start from accounting.settings where company_id = ${h.companyId}`;
    await h.sql`update accounting.settings set ledger_starts_on = (${h.today}::date + 1) where company_id = ${h.companyId}`;
    try {
      const invoice = await h.issuedInvoice();
      expect(await h.pending(invoice.id)).toEqual([expect.objectContaining({ state: "queued" })]);
      expect(await h.drain()).toEqual([]);
      expect(await h.entriesOf(invoice.id)).toEqual([]);
      expect(await h.pending(invoice.id)).toEqual([]);
      // The consumer counts the issued event as skipped (as it counts every event of the action dated before the start).
      const [issued] = await h.eventsOf("invoicing.invoice.issued", "invoiceId", invoice.id);
      expect(await h.count("accounting.skipped_events", `outbox_id = '${issued!.id}'`)).toBe(1);
      expect(await pendingFailures()).toBe(0);
    } finally {
      await h.sql`update accounting.settings set ledger_starts_on = ${start} where company_id = ${h.companyId}`;
    }
  });
});

describe("(11) race around a switch", () => {
  it("the consumer and an inline action on two documents, interleaved around a switch, leave exactly one entry per event", async () => {
    expect(await mode()).toBe("asynchronous");
    const x = await h.issuedInvoice();
    // Two postings of one company at once may deadlock on the gap-free sequences (40P01, retryable): the losing inline action rolls back
    // whole, as any refused run, and the user's retry issues it; the consumer rethrows it (fix round 1, I2) and the dispatcher retries the
    // delivery, so no pending is ever recorded for it.
    const deadlocked = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "40P01";
    const y = h.issuedInvoice().catch(async (e: unknown) => {
      if (!deadlocked(e)) throw e;
      return null;
    });
    const drained = h.drain().then((f) => f.filter((x) => !/deadlock|failed/.test(x.message)));
    const [, failures, first] = await Promise.all([h.setMode("inline_strict"), drained, y]);
    expect(failures).toEqual([]);
    const yIssued = first ?? (await h.issuedInvoice());
    for (let i = 0; i < 5 && (await h.drain()).length > 0; i++);
    expect(await h.drain()).toEqual([]);
    expect(await pendingFailures()).toBe(0);
    for (const id of [x.id, yIssued.id]) {
      const events = await h.eventsOf("invoicing.invoice.issued", "invoiceId", id);
      expect(events).toEqual([expect.objectContaining({ delivered: true })]);
      const entries = await h.entriesOf(id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source_event_id).toBe(events[0]!.id);
    }
    expect(await h.pending()).toEqual([]);
    await balanced();
  });
});
