import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { MockEInvoiceTransport, type MockScenario } from "@erp/infra";
import { buildConsumerContext, setEInvoiceTransport, type ProcessError } from "@erp/kernel";
import { einvoiceSubmission } from "../workflows/einvoice.workflow";
import { chainHarness, registry, type ChainHarness, type OutboxRow } from "./chain-helpers";

// The failure paths of the quote-to-ledger chain (plan 2B Task 24, design §8.1, kernel §5.5/§5.12, Review Focus 1–3), on the harness of the
// chain test (Task 23: every module of the chain, the real posting engine on the demo chart, the e-invoice workflow in-process on the mock
// DIAN, the outbox handed to its consumers as the dispatch workflow does, a consumer of a switched-off module parked):
//
//   1. an entrega in a closed period: the stock moves, the cost of sales is a closed_period posting failure, the invoice of that entrega is
//      issued and posts in its own (open) month; period.reopen + posting.retry posts the COGS once, a second retry is refused;
//   2. the DIAN rejects the invoice, then accepts it corrected: one number, one CUFE, the trail draft→submitted→rejected→…→accepted, the
//      resolution's range keeps no gap and the number is not drawn twice;
//   3. the last unit: an entrega and a second pedido at once, two entregas at once: on hand never negative, one ships, the other is refused;
//   4. an annulled invoice whose DIAN acceptance comes after a stopped sending (poll limit) and «Reintentar envío»: voided exactly once,
//      invoiced_qty given back, the entry reversed once;
//   5. modules switched off: payments off refuses receipts but a receipt already posted still pays its invoice; invoicing off parks the
//      receipt's event, which pays the invoice exactly once when invoicing is on again;
//   6. accounting switched off: the documents still issue and post nothing; every event parks; accounting on again drains them and posts
//      every entry exactly once, balanced, dated by its own document, on its own action's chain.
//
// The plan names packages/modules/sales/src/__tests__/chain-failures.integration.test.ts; the file lives here, next to the chain test, for
// the same reason (it runs invoicing's e-invoice workflow in-process, and sales may not depend on invoicing, crm or payments).
//
// Shared state and order: ONE company for the file (chainHarness), tests in file order. Every test measures what it changed (counts by its
// own documents, differences of the customer's balance) and puts back what it switched (a module, the DIAN's verdict) in a finally.

const PRICE = 28500;
const UNIT_COST = 16000;

let h: ChainHarness;
const NAMESPACE = `t24-${process.pid}-${Date.now()}`;
let verdict: MockScenario = "accepted";
/** The mock DIAN this file talks to: one namespace (its documents survive a change of instance), `verdict` decided per document sent. */
const useDian = (next: MockScenario, pendingPolls = 1) => {
  verdict = next;
  setEInvoiceTransport(new MockEInvoiceTransport({ namespace: NAMESPACE, pendingPolls, scenario: () => verdict }));
};

beforeAll(async () => {
  h = await chainHarness();
  useDian("accepted");
}, 300_000);

afterAll(async () => {
  await h.cleanup();
});

// ── Helpers on the harness ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const eventsNamed = (name: string, key: string, value: string) =>
  h.sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = ${name} and payload->>${key} = ${value} order by created_at, id`;
const anyOutboxRow = async (id: string) => (await h.sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where id = ${id}`)[0]!;
const product = async (sku: string) =>
  (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: PRICE, isFreeSample: false, trackStock: true,
  })).id;
const receive = async (productId: string, qty: number, date = h.today) => {
  await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date, warehouseId: h.warehouseId, lines: [{ productId, locationId: h.locationId, qty, unitCost: UNIT_COST }] });
  expect(await h.drain()).toEqual([]);
};
const stockOf = async (productId: string) => {
  const [row] = await h.sql<{ on_hand: string | null; reserved: string | null }[]>`
    select sum(on_hand)::text as on_hand, sum(reserved)::text as reserved from inventory.v_stock where product_id = ${productId} and warehouse_id = ${h.warehouseId}`;
  return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0) };
};
/** A pedido of the customer, created and confirmed (one user action each), not drained. */
const confirmedOrder = async (productId: string, qty: number, issueDate = h.today) => {
  const order = (await h.act<{ id: string; number: string }>("sales.order.create", { partyId: h.partyId, issueDate, warehouseId: h.warehouseId, lines: [{ productId, qty, unitPrice: PRICE }] })).result;
  const confirm = await h.act("sales.order.confirm", { id: order.id });
  return { ...order, confirmChain: confirm.chainId };
};
const createDelivery = async (orderId: string, date = h.today) =>
  (await h.run<{ id: string; number: string }>(h.admin, "sales.delivery.create", { orderId, date, costCenterId: h.costCenterId }));
const ship = (deliveryId: string) => h.act("sales.delivery.ship", { id: deliveryId });
/** «Por facturar» → Borrador → «Emitir» (manual mode), then the DIAN's verdict; answers the invoice and the chain of its Emitir. */
const invoiceOrder = async (orderId: string) => {
  await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
  const { invoices } = await h.run<{ invoices: { id: string }[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [orderId] });
  expect(invoices).toHaveLength(1);
  const issued = await h.act<{ id: string; number: string; total: number; cufe: string }>("invoicing.invoice.issue", { id: invoices[0]!.id });
  expect(await h.drain()).toEqual([]);
  return { ...issued.result, issueChain: issued.chainId };
};
const pay = (invoiceId: string, amount: number) =>
  h.act<{ id: string }>("payments.payment.receive", { partyId: h.partyId, methodId: h.transferId, amount, date: h.today, allocations: [{ invoiceId, amount }] });
const invoiceRow = async (id: string) =>
  (await h.sql<{ stage: string; dian_status: string; number: string; cufe: string; paid_amount: string; annulment_note_id: string | null }[]>`
    select stage, dian_status, number, cufe, paid_amount::text, annulment_note_id from invoicing.invoices where id = ${id}`)[0]!;
const nextInvoiceNumber = async () =>
  Number((await h.sql<{ n: string }[]>`select next_number::text as n from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice'`)[0]!.n);
const invoicedQty = async (deliveryId: string) =>
  (await h.sql<{ q: number }[]>`select invoiced_qty::float8 as q from sales.delivery_lines where delivery_id = ${deliveryId} order by line_no`).map((r) => r.q);
const movementOf = async (deliveryId: string) =>
  h.sql<{ id: string; status: string; date: string }[]>`select id, status, date::text as date from inventory.movements where company_id = ${h.companyId} and source_entity = 'sales.delivery' and source_id = ${deliveryId}`;
const cogsEventOf = async (movementId: string) => (await eventsNamed("costing.cogs.posted", "movementId", movementId))[0]!;
const failuresOf = (eventId: string) =>
  h.sql<{ id: string; error_code: string; status: string }[]>`select id, error_code, status from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${eventId} order by created_at`;
const balanced = async () => {
  const tb = await h.trialBalance();
  expect(tb.unbalanced).toBe(0);
  expect(tb.debit).toBeCloseTo(tb.credit, 4);
};
/** A day of the month before today's, in the same fiscal year (the harness opens the current year only). */
const lastMonth = () => {
  const [y, m] = h.today.split("-").map(Number) as [number, number];
  if (m === 1) throw new Error("chain-failures: the closed-period test needs a month before today's in the same fiscal year (run it after January)");
  return { number: m - 1, day: `${y}-${String(m - 1).padStart(2, "0")}-15` };
};

// ── 1. Closed period (OD-4) through the whole chain ─────────────────────────────────────────────────────────────────────────────────

describe("an entrega in a closed period", () => {
  it("moves the stock; its COGS is a closed_period failure; its invoice issues and posts in today's open month; reopen + retry posts the COGS once", async () => {
    const closed = lastMonth();
    const [period] = await h.sql<{ id: string }[]>`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = ${closed.number} returning id`;
    const stockBefore = await h.stock();
    const receivableBefore = await h.partyBalance("130505");
    const order = await confirmedOrder(h.cafe, 2, closed.day);
    expect(await h.drain()).toEqual([]);
    const delivery = await createDelivery(order.id, closed.day);
    const shipped = await ship(delivery.id);
    expect(await h.drain()).toEqual([]);

    // The stock moved, dated in the closed month; costing valued it; the ledger refused the COGS as a closed_period pending.
    const [movement] = await movementOf(delivery.id);
    expect(movement).toMatchObject({ status: "saved", date: closed.day });
    expect((await h.stock()).onHand).toBe(stockBefore.onHand - 2);
    const cogs = await cogsEventOf(movement!.id);
    expect(cogs.chain_id).toBe(shipped.chainId);
    expect(await h.entriesOf(movement!.id)).toEqual([]);
    const failures = await failuresOf(cogs.id);
    expect(failures).toEqual([{ id: expect.any(String), error_code: "closed_period", status: "pending" }]);

    // The invoice of that entrega: issued today (issue_date = the company's today), posted in its own open month, accepted by the DIAN.
    const invoice = await invoiceOrder(order.id);
    expect(await h.settleDian(invoice.id)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    expect(await invoicedQty(delivery.id)).toEqual([2]);
    expect(await h.entriesOf(invoice.id)).toEqual([expect.objectContaining({ journal: "VT", status: "posted", date: h.today, chain_id: invoice.issueChain })]);
    // Still one pending: the invoice did not touch the closed month, nor resolve or duplicate the COGS failure.
    expect(await failuresOf(cogs.id)).toEqual(failures);
    await balanced();

    // Reopen the month and retry: the COGS posts ONCE, dated by the entrega, on the despacho's chain.
    await h.runStepUp("accounting.period.reopen", { periodId: period!.id });
    const retried = await h.run<{ resolved: boolean; entryId?: string }>(h.admin, "accounting.posting.retry", { failureId: failures[0]!.id });
    expect(retried.resolved).toBe(true);
    const cogsEntries = await h.entriesOf(movement!.id);
    expect(cogsEntries).toEqual([expect.objectContaining({ id: retried.entryId, journal: "NC", status: "posted", date: closed.day, total_debit: `${2 * UNIT_COST}.0000` })]);
    expect(await h.linesOf(cogsEntries[0]!.id)).toEqual([
      { code: "613595", debit: `${2 * UNIT_COST}.0000`, credit: "0.0000" },
      { code: "143505", debit: "0.0000", credit: `${2 * UNIT_COST}.0000` },
    ]);
    // A second retry is refused, a redelivery of the COGS event posts nothing more; no failure is left pending.
    expect((await h.refusal(h.run(h.admin, "accounting.posting.retry", { failureId: failures[0]!.id })))?.code).toBe("invalid_input");
    await h.redeliver(cogs, "accounting");
    expect(await h.entriesOf(movement!.id)).toHaveLength(1);
    expect(await failuresOf(cogs.id)).toEqual([expect.objectContaining({ status: "resolved" })]);

    // The rest of the chain: paid, the customer owes what he owed before; the books balance.
    await pay(invoice.id, invoice.total);
    expect(await h.drain()).toEqual([]);
    expect((await invoiceRow(invoice.id)).stage).toBe("paid");
    expect(await h.partyBalance("130505")).toBe(receivableBefore);
    expect(await h.parkedRows()).toEqual([]);
    await balanced();
  });
});

// ── 2. DIAN rejection, then the corrected resubmission ──────────────────────────────────────────────────────────────────────────────

describe("the DIAN rejects the invoice of an entrega, then accepts it corrected", () => {
  it("keeps one number and one CUFE, the trail draft→submitted→rejected→submitted→rejected→submitted→accepted, no gap and no number drawn twice", async () => {
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: "on_delivery" });
    useDian("rejected");
    try {
      const numberBefore = await nextInvoiceNumber();
      const order = await confirmedOrder(h.cafe, 1);
      expect(await h.drain()).toEqual([]);
      const delivery = await createDelivery(order.id);
      const shipped = await ship(delivery.id);
      expect(await h.drain()).toEqual([]);
      const [invoice] = await h.sql<{ id: string; number: string; cufe: string; total: number }[]>`
        select distinct i.id, i.number, i.cufe, i.total::float8 as total from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id where l.delivery_id = ${delivery.id}`;
      expect(invoice!.number).toBe(`${h.resolution.prefix}${numberBefore}`);
      expect(await nextInvoiceNumber()).toBe(numberBefore + 1);
      expect(await h.settleDian(invoice!.id)).toBe("rejected");
      expect(await h.drain()).toEqual([]);
      expect((await invoiceRow(invoice!.id)).dian_status).toBe("rejected");
      // A rejected invoice takes no payment (the DIAN has not accepted it).
      expect((await h.refusal(pay(invoice!.id, invoice!.total)))?.message).toMatch(/^invoice_not_accepted/);

      // «Reintentar envío» unchanged: the same document is rejected again (round 2).
      useDian("accepted");
      await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice!.id });
      expect(await h.drain()).toEqual([]);
      expect(await h.settleDian(invoice!.id, ["accepted", "rejected"])).toBe("rejected");
      expect(await h.drain()).toEqual([]);
      // Corrected where the DIAN pointed (the customer's e-mail, in Terceros) and sent again: accepted (round 3).
      await h.run(h.admin, "core.party.update", { id: h.partyId, invoiceEmail: "facturacion@andina.example" });
      const corrected = await h.act("invoicing.invoice.resubmit", { id: invoice!.id });
      expect(await h.drain()).toEqual([]);
      expect(await h.settleDian(invoice!.id, ["accepted", "rejected"])).toBe("accepted");
      expect(await h.drain()).toEqual([]);

      // One invoice, one number, one CUFE, one submission (three rounds), one issued event, one VT entry, on the despacho's chain.
      expect(await invoiceRow(invoice!.id)).toMatchObject({ number: invoice!.number, cufe: invoice!.cufe, dian_status: "accepted", stage: "issued" });
      expect(await h.sql`select round, status, cufe from invoicing.einvoice_submissions where invoice_id = ${invoice!.id} and note_id is null`).toEqual([{ round: 3, status: "accepted", cufe: invoice!.cufe }]);
      expect(await eventsNamed("invoicing.invoice.issued", "invoiceId", invoice!.id)).toHaveLength(1);
      expect((await eventsNamed("invoicing.invoice.rejected", "invoiceId", invoice!.id)).map((e) => e.payload.round)).toEqual([1, 2]);
      // The first verdict on the despacho's chain (it issued the invoice); the acceptance on the chain of the «Reintentar envío» that sent
      // the corrected document (a user action of its own, Task 23's reading of the chain).
      expect((await eventsNamed("invoicing.invoice.rejected", "invoiceId", invoice!.id))[0]!.chain_id).toBe(shipped.chainId);
      expect((await eventsNamed("invoicing.invoice.accepted", "invoiceId", invoice!.id)).map((e) => e.chain_id)).toEqual([corrected.chainId]);
      expect(await h.entriesOf(invoice!.id)).toEqual([expect.objectContaining({ journal: "VT", status: "posted", chain_id: shipped.chainId })]);
      const trail = await h.sql<{ before: string | null; after: string }[]>`
        select diff->'dian_status'->>'old' as before, diff->'dian_status'->>'new' as after from kernel.audit_log
        where row_id = ${invoice!.id} and entity = 'invoicing.invoices' and action = 'update' and diff ? 'dian_status' order by occurred_at, id`;
      expect(trail.map((t) => `${t.before}→${t.after}`)).toEqual(["draft→submitted", "submitted→rejected", "rejected→submitted", "submitted→rejected", "rejected→submitted", "submitted→accepted"]);
      // The resubmissions drew no number: the next invoice takes the very next one of the range (no gap, nothing consumed twice).
      expect(await nextInvoiceNumber()).toBe(numberBefore + 1);
      await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
      const next = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 1 }] });
      const nextIssued = await h.run<{ id: string; number: string; total: number }>(h.admin, "invoicing.invoice.issue", { id: next.id });
      expect(nextIssued.number).toBe(`${h.resolution.prefix}${numberBefore + 1}`);
      expect(await h.drain()).toEqual([]);
      expect(await h.settleDian(nextIssued.id)).toBe("accepted");
      expect(await h.drain()).toEqual([]);
      const numbers = (await h.sql<{ number: string }[]>`select number from invoicing.invoices where company_id = ${h.companyId} and number is not null order by number`).map((r) => Number(r.number.slice(h.resolution.prefix.length)));
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => h.resolution.from + i));

      // Accepted, it is paid normally, once.
      await pay(invoice!.id, invoice!.total);
      await pay(nextIssued.id, nextIssued.total);
      expect(await h.drain()).toEqual([]);
      expect((await invoiceRow(invoice!.id)).stage).toBe("paid");
      expect(await eventsNamed("invoicing.invoice.paid", "invoiceId", invoice!.id)).toHaveLength(1);
      await balanced();
    } finally {
      useDian("accepted");
      await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
    }
  });
});

// ── 3. The last unit ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the last unit in stock (Review Focus 1)", () => {
  it("the despacho of the last unit and the confirmation of a second pedido at once: both pass, the second reserves nothing and its entrega is refused; on hand never negative", async () => {
    const ultimo = await product("ULT-01");
    await receive(ultimo, 1);
    const a = await confirmedOrder(ultimo, 1);
    expect(await h.drain()).toEqual([]);
    expect(await stockOf(ultimo)).toEqual({ onHand: 1, reserved: 1 });
    const deliveryA = await createDelivery(a.id);
    // The second pedido is created first; its confirmation races the despacho of the first.
    const b = (await h.run<{ id: string }>(h.admin, "sales.order.create", { partyId: h.partyId, issueDate: h.today, warehouseId: h.warehouseId, lines: [{ productId: ultimo, qty: 1, unitPrice: PRICE }] }));
    const results = await Promise.all([
      ship(deliveryA.id).then(() => "ok", (e: ProcessError) => e.message),
      h.run(h.admin, "sales.order.confirm", { id: b.id }).then(() => "ok", (e: ProcessError) => e.message),
    ]);
    expect(results).toEqual(["ok", "ok"]);
    expect(await h.drain()).toEqual([]);
    // The unit left with the first pedido; nothing is reserved for the second (its line is short); never below zero.
    expect(await stockOf(ultimo)).toEqual({ onHand: 0, reserved: 0 });
    expect(await movementOf(deliveryA.id)).toEqual([expect.objectContaining({ status: "saved" })]);
    const deliveryB = await createDelivery(b.id);
    const refused = await h.refusal(ship(deliveryB.id));
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toMatch(/^negative_stock_refused/);
    expect((await h.sql<{ stage: string }[]>`select stage from sales.deliveries where id = ${deliveryB.id}`)[0]!.stage).toBe("open");
    expect(await movementOf(deliveryB.id)).toEqual([]);
    expect(await stockOf(ultimo)).toEqual({ onHand: 0, reserved: 0 });

    // The chain goes on for the first: invoiced from its entrega, accepted, its COGS once. The second has nothing to invoice.
    const invoice = await invoiceOrder(a.id);
    expect(await h.settleDian(invoice.id)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    const [movement] = await movementOf(deliveryA.id);
    expect(await h.entriesOf(movement!.id)).toHaveLength(1);
    expect(await h.sql`select 1 from invoicing.v_pending_to_invoice where delivery_id = ${deliveryB.id}`).toEqual([]);
    expect((await h.refusal(h.run(h.admin, "invoicing.invoice.from_orders", { orderIds: [b.id] })))).not.toBeNull();
    // Stock back: the second entrega ships, the bodega goes to zero again, never below.
    await receive(ultimo, 1);
    await ship(deliveryB.id);
    expect(await h.drain()).toEqual([]);
    expect(await stockOf(ultimo)).toEqual({ onHand: 0, reserved: 0 });
    await pay(invoice.id, invoice.total);
    expect(await h.drain()).toEqual([]);
    await balanced();
  });

  it("two entregas of two pedidos for the last unit shipped at once: one ships, the other is refused negative_stock_refused before any stock moves", async () => {
    const lone = await product("ULT-02");
    // Both pedidos confirmed while the bodega is empty (short: nothing reserved), then one unit arrives.
    const a = await confirmedOrder(lone, 1);
    const b = await confirmedOrder(lone, 1);
    expect(await h.drain()).toEqual([]);
    await receive(lone, 1);
    const reserved = (await stockOf(lone)).reserved;
    expect(reserved).toBeLessThanOrEqual(1);
    const deliveries = [await createDelivery(a.id), await createDelivery(b.id)];
    const results = await Promise.all(deliveries.map((d) => ship(d.id).then(() => "ok", (e: ProcessError) => e.message)));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.find((r) => r !== "ok")).toMatch(/^negative_stock_refused/);
    expect(await h.drain()).toEqual([]);
    expect(await stockOf(lone)).toEqual({ onHand: 0, reserved: 0 });
    const moved = await Promise.all(deliveries.map((d) => movementOf(d.id)));
    expect(moved.map((m) => m.length).sort()).toEqual([0, 1]);
    // No stock level of the company is below zero, in any bucket.
    expect(await h.sql`select 1 from inventory.stock_levels where company_id = ${h.companyId} and on_hand < 0`).toEqual([]);
  });
});

// ── 4. The annulment whose acceptance arrives after a stopped sending ───────────────────────────────────────────────────────────────

describe("an invoice annulled by its credit note, accepted by the DIAN only after a retry", () => {
  it("poll limit → «Reintentar envío» → accepted: the invoice is voided exactly once, invoiced_qty given back, its entry reversed once", async () => {
    const order = await confirmedOrder(h.cafe, 3);
    expect(await h.drain()).toEqual([]);
    const delivery = await createDelivery(order.id);
    await ship(delivery.id);
    expect(await h.drain()).toEqual([]);
    const invoice = await invoiceOrder(order.id);
    expect(await h.settleDian(invoice.id)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    expect(await invoicedQty(delivery.id)).toEqual([3]);
    const receivableBefore = await h.partyBalance("130505");

    // Anular: the annulment credit note is issued (and posted) at once; the DIAN answers it «pending» longer than the run polls.
    useDian("pending", 4);
    try {
      const voided = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Factura errada" });
      const noteId = voided.annulmentNoteId;
      const [noteIssued] = await eventsNamed("invoicing.note.issued", "noteId", noteId);
      // The sending, run by hand with a limit of 2 polls (the consumer's run would use the default limit of 20).
      const ctx = buildConsumerContext(h.sql, { companyId: h.companyId, chainId: noteIssued!.chain_id }, registry);
      const requested = (await ctx.runProcess("invoicing.einvoice_submission.request", { noteId })) as { submissionId: string; start: boolean };
      expect(requested.start).toBe(true);
      const run = await start(einvoiceSubmission, [{ companyId: h.companyId, invoiceId: invoice.id, noteId, submissionId: requested.submissionId, chainId: noteIssued!.chain_id, maxPolls: 2 }]);
      const outcome = run.returnValue.then(() => "returned", (e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(await h.settleDian({ noteId })).toBe("failed");
      expect(await outcome).toMatch(/poll_limit/);
      // Stopped: the note was sent and is still awaited; the invoice stays issued with what it invoiced.
      expect(await h.sql`select dian_status from invoicing.notes where id = ${noteId}`).toEqual([{ dian_status: "submitted" }]);
      expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "issued", annulment_note_id: null });
      expect(await invoicedQty(delivery.id)).toEqual([3]);

      // «Reintentar envío» of the note: the same round resumed (polled, never sent again), and the DIAN accepts it.
      await h.run(h.admin, "invoicing.note.resubmit", { id: noteId });
      expect(await h.drain()).toEqual([]);
      expect(await h.settleDian({ noteId }, ["accepted", "rejected"])).toBe("accepted");
      expect(await h.drain()).toEqual([]);
      expect(await h.sql`select round, attempts, status from invoicing.einvoice_submissions where note_id = ${noteId}`).toEqual([{ round: 1, attempts: 1, status: "accepted" }]);

      // Voided exactly once: one stage change issued → voided, one invoicing.invoice.annulled; the entrega's invoiced_qty given back.
      expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "voided", annulment_note_id: noteId, number: invoice.number });
      const stages = await h.sql<{ before: string; after: string }[]>`
        select diff->'stage'->>'old' as before, diff->'stage'->>'new' as after from kernel.audit_log
        where row_id = ${invoice.id} and entity = 'invoicing.invoices' and action = 'update' and diff ? 'stage' order by occurred_at, id`;
      expect(stages.filter((s) => s.after === "voided")).toEqual([{ before: "issued", after: "voided" }]);
      const annulled = await eventsNamed("invoicing.invoice.annulled", "invoiceId", invoice.id);
      expect(annulled).toHaveLength(1);
      expect(annulled[0]!.payload).toMatchObject({ noteId, deliveryIds: [delivery.id] });
      expect(await invoicedQty(delivery.id)).toEqual([0]);
      expect(await h.sql`select 1 from invoicing.v_pending_to_invoice where delivery_id = ${delivery.id}`).toHaveLength(1);

      // The ledger: the invoice's entry and the note's, its exact mirror, once each; the customer's receivable back to before the invoice.
      const invoiceEntries = await h.entriesOf(invoice.id);
      const noteEntries = await h.entriesOf(noteId);
      expect(invoiceEntries).toHaveLength(1);
      expect(noteEntries).toEqual([expect.objectContaining({ status: "posted", total_debit: invoiceEntries[0]!.total_debit })]);
      const net = new Map<string, number>();
      for (const e of [...invoiceEntries, ...noteEntries]) for (const l of await h.linesOf(e.id)) net.set(l.code, (net.get(l.code) ?? 0) + Number(l.debit) - Number(l.credit));
      expect([...net.values()].every((v) => Math.abs(v) < 0.0001)).toBe(true);
      expect(await h.partyBalance("130505")).toBeCloseTo(receivableBefore - invoice.total, 4);

      // Redeliveries change nothing: the annulment to sales, the note's events to invoicing and to the ledger; a second retry is refused.
      await h.redeliver(annulled[0]!, "sales");
      await h.redeliver(noteIssued!, "accounting");
      await h.redeliver(noteIssued!, "invoicing");
      expect(await h.drain()).toEqual([]);
      expect(await invoicedQty(delivery.id)).toEqual([0]);
      expect(await h.entriesOf(noteId)).toHaveLength(1);
      expect(await eventsNamed("invoicing.invoice.annulled", "invoiceId", invoice.id)).toHaveLength(1);
      expect((await h.refusal(h.run(h.admin, "invoicing.note.resubmit", { id: noteId })))?.message).toMatch(/einvoice_accepted/);
      await balanced();

      // What shipped is invoiced again, once (the entrega is pending to invoice again).
      useDian("accepted");
      const again = await invoiceOrder(order.id);
      expect(await h.settleDian(again.id)).toBe("accepted");
      expect(await h.drain()).toEqual([]);
      expect(await invoicedQty(delivery.id)).toEqual([3]);
      await pay(again.id, again.total);
      expect(await h.drain()).toEqual([]);
      await balanced();
    } finally {
      useDian("accepted");
    }
  });
});

// ── 5. Modules switched off: payments, invoicing ────────────────────────────────────────────────────────────────────────────────────

/** An invoice by hand (no pedido), issued and accepted. */
const acceptedInvoice = async (qty = 1) => {
  await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
  const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty }] });
  const issued = await h.run<{ id: string; number: string; total: number }>(h.admin, "invoicing.invoice.issue", { id: draft.id });
  expect(await h.drain()).toEqual([]);
  expect(await h.settleDian(issued.id)).toBe("accepted");
  expect(await h.drain()).toEqual([]);
  return issued;
};
const setModule = (moduleId: string, on: boolean) => h.runStepUp(on ? "kernel.admin.module.enable" : "kernel.admin.module.disable", { moduleId });

describe("modules switched off (design §5.12: paused, queued, not dropped)", () => {
  it("payments off: no receipt can be taken; a receipt posted before still reaches invoicing (its consumer is on) and pays the invoice once", async () => {
    const invoice = await acceptedInvoice();
    const receipt = await pay(invoice.id, invoice.total);
    // Switched off after the receipt posted, before invoicing recorded it.
    await setModule("payments", false);
    try {
      expect((await h.refusal(pay(invoice.id, invoice.total)))?.code).toBe("not_entitled");
      expect(await h.drain()).toEqual([]);
      // payments consumes no event: nothing parks; the receipt's event was invoicing's to consume, and invoicing is on.
      expect(await h.parkedRows()).toEqual([]);
      expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "paid", paid_amount: `${invoice.total}.0000` });
      expect(await eventsNamed("invoicing.invoice.paid", "invoiceId", invoice.id)).toHaveLength(1);
      expect(await h.entriesOf(receipt.result.id)).toHaveLength(1);
    } finally {
      await setModule("payments", true);
    }
    expect(await h.drain()).toEqual([]);
    expect(await eventsNamed("invoicing.invoice.paid", "invoiceId", invoice.id)).toHaveLength(1);
  });

  it("invoicing off: the receipt's event parks for invoicing (posted in the ledger already); invoicing on again drains it: paid exactly once, the CRM told once", async () => {
    const invoice = await acceptedInvoice();
    const receipt = await pay(invoice.id, invoice.total);
    await setModule("invoicing", false);
    let received: OutboxRow;
    try {
      expect(await h.drain()).toEqual([]);
      received = (await eventsNamed("payments.received", "paymentId", receipt.result.id))[0]!;
      // Parked: undispatched, marked module_disabled, delivered to every other module (the ledger posted it inline), not to invoicing.
      expect((await h.parkedRows()).map((r) => r.id)).toContain(received.id);
      const delivered = (await h.sql<{ module_id: string }[]>`select module_id from kernel.outbox_deliveries where outbox_id = ${received.id}`).map((r) => r.module_id);
      expect(delivered).toContain("accounting");
      expect(delivered).not.toContain("invoicing");
      expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "issued", paid_amount: "0.0000" });
      expect(await eventsNamed("invoicing.invoice.paid", "invoiceId", invoice.id)).toEqual([]);
      expect(await h.entriesOf(receipt.result.id)).toHaveLength(1);
      // A later drain while invoicing is still off leaves it parked (paused, not dropped, not dead-lettered).
      expect(await h.drain()).toEqual([]);
      expect(await h.sql`select 1 from kernel.outbox_dead_letter where id = ${received.id}`).toEqual([]);
    } finally {
      await setModule("invoicing", true);
    }
    expect(await h.drain()).toEqual([]);
    expect(await h.parkedRows()).toEqual([]);
    expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "paid", paid_amount: `${invoice.total}.0000` });
    const paid = await eventsNamed("invoicing.invoice.paid", "invoiceId", invoice.id);
    expect(paid).toHaveLength(1);
    // On the receipt's own chain, as if it had never waited.
    expect(paid[0]!.chain_id).toBe(receipt.chainId);
    expect(await h.sql`select 1 from crm.activities where source_entity = 'invoicing.invoice' and source_id = ${invoice.id}`).toHaveLength(1);
    expect(await h.entriesOf(receipt.result.id)).toHaveLength(1);
    await h.redeliver(await anyOutboxRow(received!.id), "invoicing");
    expect(await eventsNamed("invoicing.invoice.paid", "invoiceId", invoice.id)).toHaveLength(1);
    await balanced();
  });
});

// ── 6. Accounting switched off ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a company with accounting switched off", () => {
  it("issues, ships and collects with nothing posted (events parked); accounting on again posts every entry exactly once, balanced, dated by its own document, on its own chain", async () => {
    const receivableBefore = await h.partyBalance("130505");
    const entriesBefore = Number((await h.sql<{ n: string }[]>`select count(*)::text as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n);
    const shippedOn = h.plusDays(h.today, -2);
    await setModule("accounting", false);
    let order: Awaited<ReturnType<typeof confirmedOrder>>;
    let delivery: { id: string };
    let shipChain: string;
    let invoice: Awaited<ReturnType<typeof invoiceOrder>>;
    let voidedReceipt: { id: string };
    let receipt: { result: { id: string }; chainId: string };
    try {
      order = await confirmedOrder(h.cafe, 4, h.plusDays(h.today, -4));
      expect(await h.drain()).toEqual([]);
      delivery = await createDelivery(order.id, shippedOn);
      shipChain = (await ship(delivery.id)).chainId;
      expect(await h.drain()).toEqual([]);
      // Emitir succeeds without the ledger (inline posting: accounting_disabled); the DIAN accepts it.
      invoice = await invoiceOrder(order.id);
      expect(await h.settleDian(invoice.id)).toBe("accepted");
      expect(await h.drain()).toEqual([]);
      // A receipt posted then voided while accounting is off must never reach the ledger; a second one pays the invoice.
      voidedReceipt = (await pay(invoice.id, 10000)).result;
      expect(await h.drain()).toEqual([]);
      await h.runStepUp("payments.payment.void", { id: voidedReceipt.id, reason: "Consignación devuelta" });
      expect(await h.drain()).toEqual([]);
      receipt = await pay(invoice.id, invoice.total);
      expect(await h.drain()).toEqual([]);
      expect((await invoiceRow(invoice.id)).stage).toBe("paid");

      // Nothing posted, nothing failed, nothing skipped: the documents' events wait for the ledger.
      const [movement] = await movementOf(delivery.id);
      for (const source of [movement!.id, invoice.id, receipt.result.id, voidedReceipt.id]) expect(await h.entriesOf(source)).toEqual([]);
      expect(await h.sql`select 1 from accounting.posting_failures where company_id = ${h.companyId} and status = 'pending'`).toEqual([]);
      const parked = await h.parkedRows();
      const parkedOf = (event: string, key: string, value: string) => parked.filter((r) => r.event === event && r.payload[key] === value);
      expect(parkedOf("costing.cogs.posted", "movementId", movement!.id)).toHaveLength(1);
      expect(parkedOf("invoicing.invoice.issued", "invoiceId", invoice.id)).toHaveLength(1);
      expect(parkedOf("payments.received", "paymentId", receipt.result.id)).toHaveLength(1);
      // The voided receipt's own event is no longer waiting for the ledger (dismissed by the void): only its void parks, reversing nothing.
      expect(parkedOf("payments.received", "paymentId", voidedReceipt.id)).toEqual([]);
      // Every other module got its events: stock moved, the invoice paid; only accounting waits.
      for (const row of parked) {
        const pending = (await h.sql<{ module_id: string }[]>`select module_id from kernel.outbox_deliveries where outbox_id = ${row.id}`).map((r) => r.module_id);
        expect(pending, `${row.event} delivered to accounting while it was off`).not.toContain("accounting");
      }
      expect(Number((await h.sql<{ n: string }[]>`select count(*)::text as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n)).toBe(entriesBefore);
    } finally {
      await setModule("accounting", true);
    }

    // Accounting on again: the consumer drains every parked event.
    expect(await h.drain()).toEqual([]);
    expect(await h.parkedRows()).toEqual([]);
    const [movement] = await movementOf(delivery!.id);
    const cogs = await h.entriesOf(movement!.id);
    expect(cogs).toEqual([expect.objectContaining({ journal: "NC", status: "posted", date: shippedOn, chain_id: shipChain!, total_debit: `${4 * UNIT_COST}.0000` })]);
    expect(await h.entriesOf(invoice!.id)).toEqual([expect.objectContaining({ journal: "VT", status: "posted", date: h.today, chain_id: invoice!.issueChain, total_debit: `${invoice!.total}.0000` })]);
    expect(await h.entriesOf(receipt!.result.id)).toEqual([expect.objectContaining({ journal: "RC", status: "posted", date: h.today, chain_id: receipt!.chainId, total_debit: `${invoice!.total}.0000` })]);
    expect(await h.entriesOf(voidedReceipt!.id)).toEqual([]);
    expect(await h.sql`select 1 from accounting.posting_failures where company_id = ${h.companyId} and status = 'pending'`).toEqual([]);
    expect(await h.partyBalance("130505")).toBe(receivableBefore);
    await balanced();

    // Exactly once: redelivering every event of this sale to the ledger posts nothing more.
    const sources = [movement!.id, invoice!.id, receipt!.result.id];
    const before = await Promise.all(sources.map((s) => h.entriesOf(s)));
    for (const row of [
      await cogsEventOf(movement!.id),
      ...(await eventsNamed("invoicing.invoice.issued", "invoiceId", invoice!.id)),
      ...(await eventsNamed("payments.received", "paymentId", receipt!.result.id)),
      ...(await eventsNamed("payments.received", "paymentId", voidedReceipt!.id)),
      ...(await eventsNamed("payments.payment.voided", "paymentId", voidedReceipt!.id)),
    ]) await h.redeliver(row, "accounting");
    expect(await Promise.all(sources.map((s) => h.entriesOf(s)))).toEqual(before);
    expect(await h.entriesOf(voidedReceipt!.id)).toEqual([]);
    await balanced();
  });
});
