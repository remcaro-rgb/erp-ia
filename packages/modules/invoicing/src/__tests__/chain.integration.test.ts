import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainHarness, type ChainHarness, type OutboxRow } from "./chain-helpers";

// THE EXIT CRITERION OF PHASE 2B (plan 2B Task 23, design §8.1, Review Focus 5): one sale from the quote to the ledger, with the real
// modules, the real posting engine on the demo chart and the e-invoice workflow on the mock DIAN, once under each `invoice_creation` value:
//
//   cotización → aceptada → pedido (from_quote) → confirmado → entrega despachada → factura (by hand, on the despacho, or on the
//   confirmation) → emitida → aceptada por la DIAN → recibo de caja → factura pagada → libro.
//
// The causal chain (rule 16, kernel §5): each USER ACTION (accept, convert, confirm, ship, invoice, issue, receive) runs on a chain of its
// own, and everything it causes downstream (every consumer's process, every event, every entry, the DIAN workflow's steps) carries that same
// chain id: so «what happened when pedido N was confirmed» is the audit of one chain. Actions a person starts separately (shipping is not
// confirming) start a new chain; they are tied to their predecessors by the documents their events name (orderId → deliveryId → movementId
// → invoiceId → paymentId), which this test follows link by link. The outbox has no causation column: the payload references are the link.
//
// Expected figures: 10 × Café $ 28.500 (list price) = $ 285.000 + IVA 5 % $ 14.250 = $ 299.250. Cost of sales 10 × $ 16.000 = $ 160.000 at
// the weighted average (one receipt of 200 at $ 16.000). In the on_order_confirmation run the customer withholds retefuente 2,5 % on the
// base ($ 7.125): the receipt brings $ 292.125 and still settles the invoice in full.
//
// Shared state and order: every test of this file runs on ONE company (chainHarness, seeded once in beforeAll), in file order. Each sale
// sets `invoice_creation` for itself and measures stock, the cost layer, the customer's 130505 balance, the outbox and the audit as
// differences from what was there before it; but a run's absolute checks (the credit exposure, the open items) hold only because the run
// before it left the customer owing nothing. The rules block sets `invoice_creation` back to manual for every invoice it makes. Run alone
// (-t), a test still passes; reordering the file or leaving an earlier sale unpaid breaks the absolute checks.
//
// The file lives in invoicing (not in sales, where the chain starts) because it runs invoicing's e-invoice workflow in-process: the
// `workflow()` plugin of this package's integration config builds it, as the other e-invoice suites do.

const QTY = 10;
const SUBTOTAL = 285000;
const IVA = 14250;
const TOTAL = 299250;
const UNIT_COST = 16000;
const COGS = QTY * UNIT_COST;
const REVENUE_CODE = "413595"; // the co pack's revenue role (role-mappings.ts)
const IVA_CODE = "240802"; // vat_out for tax:IVA5

type Mode = "manual" | "on_delivery" | "on_order_confirmation";

let h: ChainHarness;

beforeAll(async () => {
  h = await chainHarness();
}, 300_000);

afterAll(async () => {
  await h.cleanup();
});

const eventsOf = (rows: OutboxRow[], name: string, key: string, value: string) => rows.filter((r) => r.event === name && r.payload[key] === value);
const one = (rows: OutboxRow[], name: string, key: string, value: string) => {
  const found = eventsOf(rows, name, key, value);
  expect(found, `${name} with ${key} = ${value}`).toHaveLength(1);
  return found[0]!;
};

describe.each<{ mode: Mode; withholding: boolean }>([
  { mode: "manual", withholding: false },
  { mode: "on_delivery", withholding: false },
  { mode: "on_order_confirmation", withholding: true },
])("the chain quote → order → delivery → invoice → payment → ledger, invoice_creation = $mode", ({ mode, withholding }) => {
  it("runs end to end on one chain per action, posts every document in its journal and leaves the books, the stock and the CRM right", async () => {
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: mode });
    // What exists before this sale: every outbox row and audit chain written from here on belongs to it.
    const before = new Set((await h.outboxSince(new Date(0))).map((r) => r.id));
    const chainsBefore = new Set(await h.auditChainsSince(new Date(0)));
    // Every user action of this sale runs on its own chain (h.act); they are collected here.
    const actions: string[] = [];
    const act = async <T = unknown>(processId: string, input: unknown) => {
      const done = await h.act<T>(processId, input);
      actions.push(done.chainId);
      return done;
    };
    const stockBefore = await h.stock();
    const layerBefore = await h.costLayer();
    const receivableBefore = await h.partyBalance("130505");

    // ── 1. The deal and its quote: an oportunidad in the embudo, a cotización priced from the product's list price, sent and accepted. ──
    const opportunityId = (await act<{ id: string }>("crm.opportunity.create", { title: `Café para Andina (${mode})`, partyId: h.partyId, pipelineId: h.pipelineId })).result.id;
    const quote = (await act<{ id: string; number: string; total: number }>("crm.quote.create", {
      partyId: h.partyId, opportunityId, issueDate: h.today, validUntil: h.plusDays(h.today, 30), lines: [{ productId: h.cafe, qty: QTY }],
    })).result;
    expect(quote.total).toBe(TOTAL);
    await act("crm.quote.send", { id: quote.id });
    const accept = await act("crm.quote.accept", { id: quote.id });
    expect(await h.drain()).toEqual([]);

    // ── 2. The pedido from the accepted quote (its prices, not a live lookup), then confirmed: stock reserved, the deal won. ──
    const order = (await act<{ id: string; number: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId: h.warehouseId, issueDate: h.today })).result;
    const confirm = await act("sales.order.confirm", { id: order.id });
    expect(await h.drain()).toEqual([]);
    expect((await h.stock()).reserved - stockBefore.reserved).toBe(QTY);
    expect(await h.sql`select outcome, order_id from crm.opportunities where id = ${opportunityId}`).toEqual([{ outcome: "won", order_id: order.id }]);

    // ── 3. The entrega, shipped: inventory issues the stock (the reservation is used up), costing values it, the ledger gets the COGS. ──
    const delivery = (await act<{ id: string; number: string }>("sales.delivery.create", { orderId: order.id, date: h.today, costCenterId: h.costCenterId })).result;
    const ship = await act("sales.delivery.ship", { id: delivery.id });
    expect(await h.drain()).toEqual([]);

    // ── 4. The invoice: by hand from «Por facturar» and «Emitir» (manual), or by itself on the despacho / on the confirmation. ──
    let draftChain: string | null = null;
    let issueChain: string;
    if (mode === "manual") {
      const fromOrders = await act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
      expect(fromOrders.result.invoices).toHaveLength(1);
      draftChain = fromOrders.chainId;
      issueChain = (await act("invoicing.invoice.issue", { id: fromOrders.result.invoices[0]!.id })).chainId;
      expect(await h.drain()).toEqual([]);
    } else {
      issueChain = mode === "on_delivery" ? ship.chainId : confirm.chainId;
    }
    const invoices = await h.sql<{ id: string; number: string; origin: string; stage: string; total: string; cufe: string }[]>`
      select distinct i.id, i.number, i.origin, i.stage, i.total::text, i.cufe from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id where l.order_id = ${order.id}`;
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0]!;
    expect(invoice).toMatchObject({ origin: mode === "manual" ? "from_orders" : mode, stage: "issued", total: `${TOTAL}.0000` });

    // ── 5. The DIAN: the e-invoice workflow signs, sends and polls the mock DIAN, which accepts it. ──
    expect(await h.settleDian(invoice.id)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    const dian = (await h.sql<{ dian_status: string; cufe: string | null }[]>`select dian_status, cufe from invoicing.invoices where id = ${invoice.id}`)[0]!;
    expect(dian.dian_status).toBe("accepted");
    // The CUFE: the SHA-384 of the invoice's fields (Anexo técnico 1.9), 96 lowercase hex digits, the one the mock DIAN accepted.
    expect(dian.cufe).toMatch(/^[0-9a-f]{96}$/);
    // Before the payment the invoice is owed: the customer's exposure is its total, its receivable item open.
    expect(await h.creditExposure()).toBe(TOTAL);
    expect((await h.openItems()).filter((i) => i.kind === "document")).toEqual([expect.objectContaining({ code: "130505", open: TOTAL })]);

    // ── 6. The recibo de caja: the whole invoice settled (cash, plus the retefuente the customer withheld in one run). ──
    const held = withholding ? Math.round(SUBTOTAL * 0.025) : 0;
    const receive = await act<{ id: string; number: string }>("payments.payment.receive", {
      partyId: h.partyId, methodId: h.transferId, amount: TOTAL - held, date: h.today,
      allocations: [{ invoiceId: invoice.id, amount: TOTAL, withholdings: withholding ? [{ kind: "income", code: "RTEFTE_COMPRAS_2.5", rate: 2.5, base: SUBTOTAL, amount: held }] : [] }],
    });
    expect(await h.drain()).toEqual([]);

    // ════════════════════════════════ What the chain left ════════════════════════════════

    // The invoice is paid: paid_amount is what the receipts settled (cash + withholdings), recorded by invoicing's consumer of payments.received.
    expect(await h.sql`select stage, paid_amount::text from invoicing.invoices where id = ${invoice.id}`).toEqual([{ stage: "paid", paid_amount: `${TOTAL}.0000` }]);

    // The causal chains. Every event and every audit entry this sale wrote carries the chain of one of its user actions: nothing downstream
    // (a consumer, the posting engine, the DIAN workflow) starts a chain of its own.
    const events = (await h.outboxSince(new Date(0))).filter((r) => !before.has(r.id));
    expect(events.filter((e) => !actions.includes(e.chain_id)).map((e) => `${e.event} ${e.chain_id}`), "events outside the chain of a user action").toEqual([]);
    const auditChains = (await h.auditChainsSince(new Date(0))).filter((c) => !chainsBefore.has(c));
    expect(auditChains.filter((c) => !actions.includes(c)), "audit entries outside the chain of a user action").toEqual([]);

    // Accepting the quote: crm.quote.accepted names the oportunidad (the pedido is a separate action that reads it).
    expect(one(events, "crm.quote.accepted", "quoteId", quote.id)).toMatchObject({ chain_id: accept.chainId, payload: { opportunityId } });
    // Confirming the pedido: the confirmation names the quote and the oportunidad; the deal is won on the same chain.
    expect(one(events, "sales.order.confirmed", "orderId", order.id)).toMatchObject({ chain_id: confirm.chainId, payload: { quoteId: quote.id, opportunityId } });
    expect(one(events, "crm.opportunity.won", "opportunityId", opportunityId).chain_id).toBe(confirm.chainId);
    // Shipping: the despacho names its pedido; inventory's sale issue names the entrega; costing's COGS names the movement. One chain.
    const shipped = one(events, "sales.delivery.shipped", "deliveryId", delivery.id);
    expect(shipped).toMatchObject({ chain_id: ship.chainId, payload: { orderId: order.id } });
    const movement = events.find((e) => e.event === "inventory.movement.posted" && e.payload.sourceId === delivery.id)!;
    expect(movement).toMatchObject({ chain_id: ship.chainId, payload: { kind: "sale_issue", sourceEntity: "sales.delivery" } });
    const movementId = movement.payload.movementId as string;
    expect(one(events, "costing.cogs.posted", "movementId", movementId).chain_id).toBe(ship.chainId);
    // Invoicing: created and issued on the chain of the action that caused it (the despacho or the confirmation when automatic), and the
    // DIAN's acceptance — which the workflow records — on the issue's chain too. The issue names the pedido and the entrega it bills.
    const issued = one(events, "invoicing.invoice.issued", "invoiceId", invoice.id);
    expect(issued.chain_id).toBe(issueChain);
    expect(issued.payload).toMatchObject({ orderIds: [order.id], ...(mode === "on_order_confirmation" ? {} : { deliveryIds: [delivery.id] }) });
    expect(one(events, "invoicing.invoice.accepted", "invoiceId", invoice.id).chain_id).toBe(issueChain);
    expect(one(events, "invoicing.invoice.created", "invoiceId", invoice.id).chain_id).toBe(draftChain ?? issueChain);
    // Paying: the receipt names the invoice it settles; invoicing marks it paid on the receipt's chain and tells the CRM (the oportunidad
    // comes from the invoice's pedido), whose payment activity is logged on that chain too.
    const received = one(events, "payments.received", "paymentId", receive.result.id);
    expect(received).toMatchObject({ chain_id: receive.chainId, payload: { allocations: [expect.objectContaining({ invoiceId: invoice.id, amount: TOTAL })] } });
    expect(one(events, "invoicing.invoice.paid", "invoiceId", invoice.id)).toMatchObject({
      chain_id: receive.chainId, payload: { invoiceId: invoice.id, number: invoice.number, partyId: h.partyId, opportunityId, amount: TOTAL },
    });
    const activities = await h.sql<{ kind: string; opportunity_id: string; done: boolean; subject: string }[]>`
      select kind, opportunity_id, done_at is not null as done, subject from crm.activities where source_entity = 'invoicing.invoice' and source_id = ${invoice.id}`;
    expect(activities).toEqual([{ kind: "payment", opportunity_id: opportunityId, done: true, subject: `Factura ${invoice.number} pagada` }]);

    // «¿Qué pasó cuando se confirmó el pedido N?» answered from the audit (kernel.audit.consult, the audit viewer's process) by chain id.
    const confirmed = await h.whatHappened("sales.order.confirm", order.id);
    expect(confirmed.chainId).toBe(confirm.chainId);
    const confirmedProcesses = new Set(confirmed.entries.map((e) => e.process_id));
    expect([...confirmedProcesses]).toEqual(expect.arrayContaining(["sales.order.confirm", "inventory.reservation.create", "crm.opportunity.mark_won"]));
    expect(confirmed.entries.find((e) => e.process_id === "sales.order.confirm")).toMatchObject({ origin: "ui", row_id: order.id });
    expect(confirmed.entries.filter((e) => e.process_id !== "sales.order.confirm" && e.process_id !== null).every((e) => e.origin === "event" || e.origin === "ui")).toBe(true);
    if (mode === "on_order_confirmation") {
      expect([...confirmedProcesses]).toEqual(expect.arrayContaining(["invoicing.invoice.auto_create", "invoicing.invoice.issue", "invoicing.invoice.dian_result"]));
    } else {
      expect(confirmedProcesses.has("invoicing.invoice.issue")).toBe(false);
    }
    // The same question for the despacho: the sale issue, its costing, and (on_delivery) the invoice.
    const shippedTrail = new Set((await h.whatHappened("sales.delivery.ship", delivery.id)).entries.map((e) => e.process_id));
    expect([...shippedTrail]).toEqual(expect.arrayContaining(["sales.delivery.ship", "inventory.sale.issue", "costing.movement.cost"]));
    expect(shippedTrail.has("invoicing.invoice.issue")).toBe(mode === "on_delivery");
    // And for the payment: the receipt, and invoicing recording it (the paid status) and the CRM's activity.
    const paidTrail = new Set((await h.whatHappened("payments.payment.receive", receive.result.id)).entries.map((e) => e.process_id));
    expect([...paidTrail]).toEqual(expect.arrayContaining(["payments.payment.receive", "invoicing.invoice.record_payments", "crm.activity.create"]));

    // The ledger. The invoice in Ventas, on the issue's chain; the COGS in Notas de contabilidad, on the despacho's; the receipt in Recibos de
    // caja, on its own. Each dated by its own document.
    const invoiceEntries = await h.entriesOf(invoice.id);
    expect(invoiceEntries).toEqual([expect.objectContaining({ journal: "VT", status: "posted", chain_id: issueChain, date: h.today, total_debit: `${TOTAL}.0000`, total_credit: `${TOTAL}.0000` })]);
    const invoiceLines = await h.linesOf(invoiceEntries[0]!.id);
    expect(invoiceLines).toEqual(expect.arrayContaining([
      { code: "130505", debit: `${TOTAL}.0000`, credit: "0.0000" },
      // The revenue role's account and the IVA generated at 5 %, by code (the co pack's role mappings).
      { code: REVENUE_CODE, debit: "0.0000", credit: `${SUBTOTAL}.0000` },
      { code: IVA_CODE, debit: "0.0000", credit: `${IVA}.0000` },
    ]));
    expect(invoiceLines).toHaveLength(3);
    const cogsEntries = await h.entriesOf(movementId);
    expect(cogsEntries).toEqual([expect.objectContaining({ journal: "NC", status: "posted", chain_id: ship.chainId, date: h.today, total_debit: `${COGS}.0000` })]);
    expect(await h.linesOf(cogsEntries[0]!.id)).toEqual([
      { code: "613595", debit: `${COGS}.0000`, credit: "0.0000" },
      { code: "143505", debit: "0.0000", credit: `${COGS}.0000` },
    ]);
    const receiptEntries = await h.entriesOf(receive.result.id);
    expect(receiptEntries).toEqual([expect.objectContaining({ journal: "RC", status: "posted", chain_id: receive.chainId, date: h.today, total_debit: `${TOTAL}.0000` })]);
    expect(await h.linesOf(receiptEntries[0]!.id)).toEqual(expect.arrayContaining([
      { code: "111005", debit: `${TOTAL - held}.0000`, credit: "0.0000" },
      { code: "130505", debit: "0.0000", credit: `${TOTAL}.0000` },
      ...(withholding ? [{ code: "135515", debit: `${held}.0000`, credit: "0.0000" }] : []),
    ]));
    // The trial balance balances, every entry of it.
    const tb = await h.trialBalance();
    expect(tb.unbalanced).toBe(0);
    expect(tb.debit).toBeCloseTo(tb.credit, 4);

    // Stock and average cost: the 10 units left the bodega, nothing stays reserved, the layer kept its average.
    const stockAfter = await h.stock();
    expect(stockAfter).toEqual({ onHand: stockBefore.onHand - QTY, reserved: stockBefore.reserved });
    const layerAfter = await h.costLayer();
    expect(layerAfter).toEqual({ qty: layerBefore.qty - QTY, value: layerBefore.value - COGS });
    expect(layerAfter.value / layerAfter.qty).toBe(UNIT_COST);

    // The customer owes nothing again: the credit exposure is back to zero, the receivable item is closed in the aging (Task 22: open items
    // follow the allocations), and the 130505 balance of the customer is where it was before the sale.
    expect(await h.creditExposure()).toBe(0);
    expect(await h.sql`select 1 from invoicing.v_open_invoices where invoice_id = ${invoice.id}`).toEqual([]);
    const stillOpen = (await h.openItems()).filter((i) => i.kind === "document");
    expect(stillOpen.filter((i) => i.code === "130505")).toEqual([]);
    // The retefuente the customer withheld is a debit of 135515 with the customer as tercero (group 13), but a withholding suffered is no
    // customer item: with payments on, the open items leave the withholding_*_suffered accounts out (Task 22 fix round 1, owner ruling
    // 2026-11-05), so nothing of the customer stays open.
    expect(stillOpen.filter((i) => i.code !== "130505")).toEqual([]);
    expect(await h.partyBalance("130505")).toBe(receivableBefore);
    // Redelivering the receipt's event to invoicing changes nothing (paid_amount is recomputed from the allocations, not added up).
    await h.redeliver(received, "invoicing");
    expect(await h.sql`select stage, paid_amount::text from invoicing.invoices where id = ${invoice.id}`).toEqual([{ stage: "paid", paid_amount: `${TOTAL}.0000` }]);
    expect(eventsOf(await h.outboxSince(new Date(0)), "invoicing.invoice.paid", "invoiceId", invoice.id)).toHaveLength(1);
  });
});

describe("paid status: a payment void, credit notes and the annulment (plan 2B Task 23 rules)", () => {
  /** An issued invoice of one coffee (by hand: no pedido), accepted by the mock DIAN. */
  const acceptedInvoice = async (qty = 2) => {
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
    const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty }] });
    const issued = await h.run<{ id: string; number: string; total: number }>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(await h.drain()).toEqual([]);
    expect(await h.settleDian(issued.id)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    return issued;
  };
  const state = async (invoiceId: string) =>
    (await h.sql<{ stage: string; paid: number; credited: number; debited: number }[]>`
      select stage, paid_amount::float8 as paid, credited_amount::float8 as credited, debited_amount::float8 as debited from invoicing.invoices where id = ${invoiceId}`)[0]!;
  const pay = async (invoiceId: string, amount: number) => {
    const receipt = await h.run<{ id: string }>(h.admin, "payments.payment.receive", { partyId: h.partyId, methodId: h.transferId, amount, date: h.today, allocations: [{ invoiceId, amount }] });
    expect(await h.drain()).toEqual([]);
    return receipt;
  };

  it("a partial payment leaves the invoice issued with what was paid; the rest pays it; voiding a receipt gives the amount back and un-pays it", async () => {
    const invoice = await acceptedInvoice();
    const first = await pay(invoice.id, 20000);
    expect(await state(invoice.id)).toMatchObject({ stage: "issued", paid: 20000 });
    await pay(invoice.id, invoice.total - 20000);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total });
    await h.runStepUp("payments.payment.void", { id: first.id, reason: "Consignación devuelta por el banco" });
    expect(await h.drain()).toEqual([]);
    expect(await state(invoice.id)).toMatchObject({ stage: "issued", paid: invoice.total - 20000 });
    // The voided event names the allocation it gives back.
    const [voided] = await h.sql<{ payload: { allocations: { invoiceId: string; amount: number }[] } }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'payments.payment.voided' and payload->>'paymentId' = ${first.id}`;
    expect(voided!.payload.allocations).toEqual([{ invoiceId: invoice.id, amount: 20000 }]);
  });

  it("an invoice with payments applied is not annulled (void the receipt first); without them it is", async () => {
    const invoice = await acceptedInvoice();
    const receipt = await pay(invoice.id, 10000);
    // Even before invoicing's consumer records it (the receipt's event still undelivered), the allocation is read under the invoice's lock.
    await h.sql`update invoicing.invoices set paid_amount = 0 where id = ${invoice.id}`;
    const refused = await h.refusal(h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "Error en el cliente" }));
    expect(refused?.message).toMatch(/^invoice_paid/);
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Recibo equivocado" });
    expect(await h.drain()).toEqual([]);
    expect(await state(invoice.id)).toMatchObject({ stage: "issued", paid: 0 });
    const voided = await h.runStepUp<{ annulmentNoteId: string | null }>("invoicing.invoice.void", { id: invoice.id, reason: "Error en el cliente" });
    expect(voided.annulmentNoteId).not.toBeNull();
  });

  it("a credit note on a paid invoice is allowed (a refund): the invoice stays paid, its open amount never goes below zero and the credit is the customer's balance", async () => {
    const invoice = await acceptedInvoice();
    const receipt = await pay(invoice.id, invoice.total);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total });
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no`;
    const note = await h.run<{ id: string; total: number }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "credit", concept: "1", reason: "Devolución de una unidad", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
    await h.run(h.admin, "invoicing.note.issue", { id: note.id });
    expect(await h.drain()).toEqual([]);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total, credited: note.total });
    expect(await h.sql`select 1 from invoicing.v_open_invoices where invoice_id = ${invoice.id}`).toEqual([]);
    // In the ledger the invoice's receivable nets to minus the note: Dr the invoice, Cr the receipt, Cr the note on 130505 — a credit
    // balance of the customer (its saldo a favor), which the aging shows as a credit item (Task 22).
    const receivableOf = async (sourceId: string) => {
      let net = 0;
      for (const e of await h.entriesOf(sourceId)) for (const l of await h.linesOf(e.id)) if (l.code === "130505") net += Number(l.debit) - Number(l.credit);
      return net;
    };
    const net = (await receivableOf(invoice.id)) + (await receivableOf(receipt.id)) + (await receivableOf(note.id));
    expect(net).toBeCloseTo(-note.total, 2);
    // No receipt can be applied to it any more (nothing of it is open), and it is not annulled (it has a note, and a receipt settles it).
    const more = await h.refusal(h.run(h.admin, "payments.payment.receive", { partyId: h.partyId, methodId: h.transferId, amount: 1000, date: h.today, allocations: [{ invoiceId: invoice.id, amount: 1000 }] }));
    expect(more?.message).toMatch(/^allocation_exceeds_open/);
    expect((await h.refusal(h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "Anular tras la devolución" })))?.message).toMatch(/^invoice_has_note|^invoice_paid/);
  });

  it("a credit note that covers what is still owed after a partial payment makes the invoice paid", async () => {
    const invoice = await acceptedInvoice();
    const [line] = await h.sql<{ id: string; total: string }[]>`select id, total::text from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no`;
    // One coffee of two is returned (credited); the other is paid.
    const note = await h.run<{ id: string; total: number }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "credit", concept: "1", reason: "Devolución de una unidad", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
    await pay(invoice.id, invoice.total - note.total);
    expect(await state(invoice.id)).toMatchObject({ stage: "issued", paid: invoice.total - note.total });
    await h.run(h.admin, "invoicing.note.issue", { id: note.id });
    expect(await h.drain()).toEqual([]);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total - note.total, credited: note.total });
    expect(await h.sql`select count(*)::int as n from kernel.outbox where event = 'invoicing.invoice.paid' and payload->>'invoiceId' = ${invoice.id}`).toEqual([{ n: 1 }]);
  });

  it("a debit note on a paid invoice makes it owed again (issued, the debit open); a payment of the debit pays it again", async () => {
    const invoice = await acceptedInvoice();
    await pay(invoice.id, invoice.total);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total });
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no`;
    const note = await h.run<{ id: string; total: number }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "debit", concept: "1", reason: "Intereses de mora", lines: [{ invoiceLineId: line!.id, qty: 1, unitPrice: 10000 }] });
    await h.run(h.admin, "invoicing.note.issue", { id: note.id });
    expect(await h.drain()).toEqual([]);
    // What was paid stays; what is owed grew by the debit: the invoice is issued again and exactly the debit is open.
    expect(await state(invoice.id)).toMatchObject({ stage: "issued", paid: invoice.total, debited: note.total });
    expect(await h.sql`select open_company::float8 as open from invoicing.v_open_invoices where invoice_id = ${invoice.id}`).toEqual([{ open: note.total }]);
    await pay(invoice.id, note.total);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total + note.total, debited: note.total });
    expect(await h.sql`select 1 from invoicing.v_open_invoices where invoice_id = ${invoice.id}`).toEqual([]);
  });

  it("a receipt void and a new payment emit invoicing.invoice.paid again; the CRM logs one payment activity per invoice", async () => {
    const invoice = await acceptedInvoice();
    const paidEvents = async () =>
      h.sql<{ chain_id: string; amount: number }[]>`select chain_id, (payload->>'amount')::float8 as amount from kernel.outbox where event = 'invoicing.invoice.paid' and payload->>'invoiceId' = ${invoice.id} order by id`;
    const activities = async () =>
      h.sql<{ kind: string; party_id: string; done: boolean }[]>`select kind, party_id, done_at is not null as done from crm.activities where source_entity = 'invoicing.invoice' and source_id = ${invoice.id}`;
    const first = await pay(invoice.id, invoice.total);
    expect(await paidEvents()).toHaveLength(1);
    // A hand-made invoice bills no pedido: no oportunidad, the CRM logs the payment on the tercero.
    expect(await activities()).toEqual([{ kind: "payment", party_id: h.partyId, done: true }]);
    await h.runStepUp("payments.payment.void", { id: first.id, reason: "Consignación devuelta por el banco" });
    expect(await h.drain()).toEqual([]);
    expect(await state(invoice.id)).toMatchObject({ stage: "issued", paid: 0 });
    const again = await h.act("payments.payment.receive", { partyId: h.partyId, methodId: h.transferId, amount: invoice.total, date: h.today, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] });
    expect(await h.drain()).toEqual([]);
    expect(await state(invoice.id)).toMatchObject({ stage: "paid", paid: invoice.total });
    // Paid twice, so told twice (the second on the new receipt's chain); the CRM keeps the one activity of the invoice.
    const events = await paidEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ chain_id: again.chainId, amount: invoice.total });
    expect(await activities()).toHaveLength(1);
  });
});
