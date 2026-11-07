import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainHarness, type ChainHarness } from "./chain-helpers";

// Task 31, stage B (design §22.27, plan 2B Task 31 test 4): the writers of the upstream references keep kernel.document_links through
// ctx.links, in the same transaction as the document write. A sale through the REAL processes leaves quote_to_order, order_to_delivery,
// delivery_to_invoice (or order_to_invoice when the invoice is made on the order) and invoice_to_receipt, each on the chain of the user
// action that wrote its downstream document; a void or cancel marks the links (kept, never deleted); a Borrador's delete removes them.
//
// One company, in file order (as chain.integration.test.ts); each test builds its own documents and reads only the links that touch them.

let h: ChainHarness;

beforeAll(async () => {
  h = await chainHarness();
}, 300_000);

afterAll(async () => {
  await h.cleanup();
});

interface Link { kind: string; from_entity: string; from_id: string; to_entity: string; to_id: string; chain_id: string | null; voided_at: Date | null; voided_chain_id: string | null; seq: string }

/** Every link that has the document at either end, oldest first (the service role reads the raw table; users read the trail). */
const linksOf = (...ids: string[]) => h.sql<Link[]>`
  select kind, from_entity, from_id, to_entity, to_id, chain_id, voided_at, voided_chain_id, seq::text
  from kernel.document_links where company_id = ${h.companyId} and (from_id = any(${ids}::uuid[]) or to_id = any(${ids}::uuid[])) order by seq`;
type Trail = { nodes: { direction: string; depth: number; id: string; voided: boolean }[]; hidden: number };
const trailOf = (entity: string, id: string, direction: "up" | "down" | "both" = "both") =>
  h.run<Trail>(h.admin, "kernel.document_link.trail", { entity, id, direction });
const maxSeq = async () => Number((await h.sql<{ m: string | null }[]>`select max(seq)::text as m from kernel.document_links where company_id = ${h.companyId}`)[0]!.m ?? 0);
const setCreation = (invoiceCreation: "manual" | "on_delivery" | "on_order_confirmation") => h.runStepUp("invoicing.settings.update", { invoiceCreation });

const acceptedQuote = async (qty: number) => {
  const opportunityId = (await h.run<{ id: string }>(h.admin, "crm.opportunity.create", { title: `Café ${randomUUID().slice(0, 6)}`, partyId: h.partyId, pipelineId: h.pipelineId })).id;
  const quote = await h.run<{ id: string; number: string }>(h.admin, "crm.quote.create", {
    partyId: h.partyId, opportunityId, issueDate: h.today, validUntil: h.plusDays(h.today, 30), lines: [{ productId: h.cafe, qty }],
  });
  await h.run(h.admin, "crm.quote.send", { id: quote.id });
  await h.run(h.admin, "crm.quote.accept", { id: quote.id });
  expect(await h.drain()).toEqual([]);
  return quote;
};
const newOrder = async (qty: number) =>
  h.act<{ id: string; number: string }>("sales.order.create", { partyId: h.partyId, issueDate: h.today, warehouseId: h.warehouseId, lines: [{ productId: h.cafe, qty }] });
const confirmed = async (qty: number) => {
  const order = (await newOrder(qty)).result;
  const confirm = await h.act("sales.order.confirm", { id: order.id });
  expect(await h.drain()).toEqual([]);
  return { order, confirm };
};
const orderLine = async (orderId: string) => (await h.sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${orderId} order by line_no`)[0]!.id;
const shipped = async (orderId: string, qty?: number) => {
  const created = await h.act<{ id: string }>("sales.delivery.create", {
    orderId, date: h.today, costCenterId: h.costCenterId, ...(qty ? { lines: [{ orderLineId: await orderLine(orderId), qty }] } : {}),
  });
  await h.run(h.admin, "sales.delivery.ship", { id: created.result.id });
  expect(await h.drain()).toEqual([]);
  return created;
};

describe("the document links of the sales chain", () => {
  it("a full sale leaves the four kinds, each on the chain of the action that wrote its downstream document", async () => {
    await setCreation("manual");
    const quote = await acceptedQuote(4);
    const order = await h.act<{ id: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId: h.warehouseId, issueDate: h.today });
    await h.act("sales.order.confirm", { id: order.result.id });
    expect(await h.drain()).toEqual([]);
    const delivery = await h.act<{ id: string }>("sales.delivery.create", { orderId: order.result.id, date: h.today, costCenterId: h.costCenterId });
    await h.act("sales.delivery.ship", { id: delivery.result.id });
    expect(await h.drain()).toEqual([]);
    const fromOrders = await h.act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.result.id] });
    const invoiceId = fromOrders.result.invoices[0]!.id;
    const issue = await h.act("invoicing.invoice.issue", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    expect(await h.settleDian(invoiceId)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    const receive = await h.act<{ id: string }>("payments.payment.receive", {
      partyId: h.partyId, methodId: h.transferId, amount: 4 * 28500 * 1.05, date: h.today, allocations: [{ invoiceId, amount: 4 * 28500 * 1.05 }],
    });
    expect(await h.drain()).toEqual([]);

    const links = await linksOf(quote.id, order.result.id, delivery.result.id, invoiceId, receive.result.id);
    expect(links.map((l) => [l.kind, l.from_entity, l.from_id, l.to_entity, l.to_id, l.chain_id])).toEqual([
      ["quote_to_order", "crm.quote", quote.id, "sales.order", order.result.id, order.chainId],
      ["order_to_delivery", "sales.order", order.result.id, "sales.delivery", delivery.result.id, delivery.chainId],
      ["delivery_to_invoice", "sales.delivery", delivery.result.id, "invoicing.invoice", invoiceId, fromOrders.chainId],
      ["invoice_to_receipt", "invoicing.invoice", invoiceId, "payments.receipt", receive.result.id, receive.chainId],
    ]);
    expect(new Set(links.map((l) => l.chain_id)).size).toBe(4);
    expect(issue.chainId).not.toBe(fromOrders.chainId);
    expect(links.every((l) => l.voided_at === null)).toBe(true);

    // The trail, through its process (the only way a user reads it): from the invoice up to the quote and down to the receipt.
    const trail = await h.run<{ nodes: { direction: string; depth: number; id: string; kind: string | null }[]; hidden: number; truncated: boolean }>(h.admin, "kernel.document_link.trail", { entity: "invoicing.invoice", id: invoiceId });
    expect(trail.hidden).toBe(0);
    expect(trail.nodes.map((n) => [n.direction, n.depth, n.id])).toEqual([
      ["up", 1, delivery.result.id], ["up", 2, order.result.id], ["up", 3, quote.id], ["down", 1, receive.result.id],
    ]);
  });

  it("the confirmation of an order, its automatic invoice and the DIAN submission share one chain; an invoice made on the order links order_to_invoice", async () => {
    await setCreation("on_order_confirmation");
    try {
      const order = (await newOrder(2)).result;
      const confirm = await h.act("sales.order.confirm", { id: order.id });
      expect(await h.drain()).toEqual([]);
      const [line] = await h.sql<{ invoice_id: string; delivery_id: string | null }[]>`select invoice_id, delivery_id from invoicing.invoice_lines where order_id = ${order.id}`;
      expect(line!.delivery_id).toBeNull();
      expect(await h.settleDian(line!.invoice_id)).toBe("accepted");
      expect(await h.drain()).toEqual([]);
      const links = await linksOf(order.id, line!.invoice_id);
      expect(links.map((l) => [l.kind, l.from_id, l.to_id, l.chain_id])).toEqual([["order_to_invoice", order.id, line!.invoice_id, confirm.chainId]]);
      // The issue and the DIAN verdict ran on that chain too: the invoice's audit has no chain but the confirmation's.
      const chains = (await h.sql<{ chain_id: string }[]>`select distinct chain_id from kernel.audit_log where company_id = ${h.companyId} and row_id = ${line!.invoice_id}`).map((r) => r.chain_id);
      expect(chains).toEqual([confirm.chainId]);
    } finally {
      await setCreation("manual");
    }
  });

  it("a quote ordered again after cancelling the first order shows two orders, the first one voided", async () => {
    const quote = await acceptedQuote(1);
    const first = await h.act<{ id: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId: h.warehouseId, issueDate: h.today });
    const cancel = await h.act("sales.order.cancel", { id: first.result.id, reason: "El cliente cambió de idea" });
    const second = await h.act<{ id: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId: h.warehouseId, issueDate: h.today });
    const links = await linksOf(quote.id);
    expect(links.map((l) => [l.kind, l.to_id, l.voided_at !== null, l.voided_chain_id])).toEqual([
      ["quote_to_order", first.result.id, true, cancel.chainId],
      ["quote_to_order", second.result.id, false, null],
    ]);
    // The void keeps the link: the trail still names the cancelled order, flagged.
    const trail = await h.run<{ nodes: { id: string; voided: boolean }[] }>(h.admin, "kernel.document_link.trail", { entity: "crm.quote", id: quote.id, direction: "down" });
    expect(trail.nodes.map((n) => [n.id, n.voided])).toEqual([[first.result.id, true], [second.result.id, false]]);
    // The cancelled order is flagged, the live cotización it came from is not.
    expect((await trailOf("sales.order", first.result.id, "up")).nodes.map((n) => [n.id, n.voided])).toEqual([[quote.id, false]]);
  });

  it("one order delivered twice gives two links; voiding a delivery marks only its own", async () => {
    const { order } = await confirmed(6);
    const a = await shipped(order.id, 2);
    const b = await h.act<{ id: string }>("sales.delivery.create", { orderId: order.id, date: h.today, costCenterId: h.costCenterId });
    expect((await linksOf(order.id)).map((l) => [l.kind, l.to_id])).toEqual([["order_to_delivery", a.result.id], ["order_to_delivery", b.result.id]]);
    const voided = await h.act("sales.delivery.void", { id: b.result.id, reason: "Error de captura" });
    expect((await linksOf(order.id)).map((l) => [l.to_id, l.voided_at !== null, l.voided_chain_id])).toEqual([[a.result.id, false, null], [b.result.id, true, voided.chainId]]);
    expect((await trailOf("sales.order", order.id, "down")).nodes.map((n) => [n.id, n.voided])).toEqual([[a.result.id, false], [b.result.id, true]]);
    // From the voided delivery its live order is not flagged.
    expect((await trailOf("sales.delivery", b.result.id, "up")).nodes.map((n) => [n.id, n.voided])).toEqual([[order.id, false]]);
  });

  it("an invoice from two deliveries gives two delivery_to_invoice rows; a draft edit resyncs, a rerun burns no seq; deleting the Borrador removes them", async () => {
    const { order } = await confirmed(6);
    const a = await shipped(order.id, 2);
    const b = await shipped(order.id, 4);
    const made = await h.act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
    const invoiceId = made.result.invoices[0]!.id;
    const deliveryLinks = async () => (await linksOf(invoiceId)).map((l) => [l.kind, l.from_id].join(":"));
    expect((await deliveryLinks()).sort()).toEqual([`delivery_to_invoice:${a.result.id}`, `delivery_to_invoice:${b.result.id}`].sort());

    // Repricing rewrites the lines: the same links, no new seq.
    const seq = await maxSeq();
    await h.run(h.admin, "invoicing.invoice.reprice", { id: invoiceId });
    expect(await maxSeq()).toBe(seq);
    expect((await deliveryLinks()).sort()).toEqual([`delivery_to_invoice:${a.result.id}`, `delivery_to_invoice:${b.result.id}`].sort());

    // One line leaves the Borrador (by hand, as the lines of a Borrador can change): the next write of the lines drops its link.
    await h.sql`delete from invoicing.invoice_lines where invoice_id = ${invoiceId} and delivery_id = ${b.result.id}`;
    await h.run(h.admin, "invoicing.invoice.reprice", { id: invoiceId });
    expect(await deliveryLinks()).toEqual([`delivery_to_invoice:${a.result.id}`]);

    // Eliminar of the Borrador (the record frame runs <entity>.delete): its links go with it.
    await h.act("invoicing.invoice.delete", { id: invoiceId });
    expect(await linksOf(invoiceId)).toEqual([]);
    expect(await h.sql`select 1 from invoicing.invoices where id = ${invoiceId}`).toHaveLength(0);
    // Still a delete process: its audit entry keeps the label «delete» (rule 16).
    expect(await h.sql`select action from kernel.audit_log where company_id = ${h.companyId} and process_id = 'invoicing.invoice.delete' and entity = 'invoicing.invoice' and row_id = ${invoiceId}`).toContainEqual({ action: "delete" });
  });

  it("deleting a Borrador through invoicing.invoice.void removes its links too", async () => {
    const { order } = await confirmed(1);
    const delivery = await shipped(order.id);
    const made = await h.act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
    const invoiceId = made.result.invoices[0]!.id;
    expect((await linksOf(invoiceId)).map((l) => l.from_id)).toEqual([delivery.result.id]);
    await h.runStepUp("invoicing.invoice.void", { id: invoiceId, reason: "Borrador equivocado" });
    expect(await linksOf(invoiceId)).toEqual([]);
  });

  it("a receipt over two invoices gives two invoice_to_receipt rows; voiding the receipt and annulling an invoice mark theirs", async () => {
    await setCreation("on_order_confirmation");
    let invoices: string[];
    try {
      const one = await confirmed(1);
      const two = await confirmed(1);
      invoices = [];
      for (const order of [one.order, two.order]) {
        const [row] = await h.sql<{ invoice_id: string }[]>`select invoice_id from invoicing.invoice_lines where order_id = ${order.id}`;
        invoices.push(row!.invoice_id);
        expect(await h.settleDian(row!.invoice_id)).toBe("accepted");
      }
      expect(await h.drain()).toEqual([]);
    } finally {
      await setCreation("manual");
    }
    const amount = 28500 * 1.05;
    const receive = await h.act<{ id: string }>("payments.payment.receive", {
      partyId: h.partyId, methodId: h.transferId, amount: amount * 2, date: h.today, allocations: invoices.map((invoiceId) => ({ invoiceId, amount })),
    });
    expect(await h.drain()).toEqual([]);
    expect((await linksOf(receive.result.id)).map((l) => [l.kind, l.from_id, l.chain_id])).toEqual(invoices.map((id) => ["invoice_to_receipt", id, receive.chainId]));

    // Anular the receipt: its links stay, marked with the voiding action's chain; the invoices' other links are untouched.
    const voided = await h.runStepUp("payments.payment.void", { id: receive.result.id, reason: "Consignación devuelta" }, { ...h.admin, chainId: randomUUID() });
    expect(voided).toMatchObject({ status: "voided" });
    expect(await h.drain()).toEqual([]);
    const marked = await linksOf(receive.result.id);
    expect(marked).toHaveLength(2);
    expect(marked.every((l) => l.voided_at !== null && l.voided_chain_id !== null)).toBe(true);
    expect((await linksOf(invoices[0]!)).filter((l) => l.kind === "order_to_invoice").every((l) => l.voided_at === null)).toBe(true);
    const trail = await h.run<{ nodes: { id: string; voided: boolean }[] }>(h.admin, "kernel.document_link.trail", { entity: "invoicing.invoice", id: invoices[0]!, direction: "down" });
    expect(trail.nodes.map((n) => [n.id, n.voided])).toEqual([[receive.result.id, true]]);
    // The voided receipt is flagged; the invoices it applied to are live documents and are not.
    expect((await trailOf("payments.receipt", receive.result.id, "up")).nodes.filter((n) => n.depth === 1).map((n) => [n.id, n.voided]).sort()).toEqual(invoices.map((id) => [id, false]).sort());

    // Anular an issued, unpaid invoice (its annulment note, accepted by the DIAN): every link touching it is marked.
    const annul = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoices[0]!, reason: "Error en el cliente" });
    expect(await h.drain()).toEqual([]);
    expect(await h.settleDian({ noteId: annul.annulmentNoteId }, ["accepted", "rejected"])).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    expect(await h.sql`select stage from invoicing.invoices where id = ${invoices[0]!}`).toEqual([{ stage: "voided" }]);
    const after = await linksOf(invoices[0]!);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.every((l) => l.voided_at !== null)).toBe(true);
    expect((await linksOf(invoices[1]!)).some((l) => l.kind === "order_to_invoice" && l.voided_at === null)).toBe(true);
    // The annulled invoice's trail: its live order is not flagged, its (already voided) receipt is; from the order, the invoice is flagged.
    const orderId = after.find((l) => l.kind === "order_to_invoice")!.from_id;
    const annulled = await trailOf("invoicing.invoice", invoices[0]!);
    expect(annulled.nodes.map((n) => [n.direction, n.id, n.voided])).toEqual([["up", orderId, false], ["down", receive.result.id, true]]);
    expect((await trailOf("sales.order", orderId, "down")).nodes.filter((n) => n.depth === 1).map((n) => [n.id, n.voided])).toEqual([[invoices[0]!, true]]);
  });

  it("an invoice on two orders, and a mixed one (a delivery line and an order-only line), link each line's nearest document; resync follows the lines", async () => {
    const one = await confirmed(1);
    const two = await confirmed(1);
    const d1 = await shipped(one.order.id);
    const d2 = await shipped(two.order.id);
    const made = await h.act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [one.order.id, two.order.id] });
    expect(made.result.invoices).toHaveLength(1);
    const invoiceId = made.result.invoices[0]!.id;
    const kinds = async () => (await linksOf(invoiceId)).map((l) => `${l.kind}:${l.from_id}`).sort();
    // Lines name both an order and a delivery: only the deliveries are linked (the order is upstream of its delivery).
    expect(await kinds()).toEqual([`delivery_to_invoice:${d1.result.id}`, `delivery_to_invoice:${d2.result.id}`].sort());
    // A line with the order only (as an invoice made on the order has): mixed, then two orders.
    await h.sql`update invoicing.invoice_lines set delivery_id = null, delivery_line_id = null where invoice_id = ${invoiceId} and order_id = ${one.order.id}`;
    await h.run(h.admin, "invoicing.invoice.reprice", { id: invoiceId });
    expect(await kinds()).toEqual([`delivery_to_invoice:${d2.result.id}`, `order_to_invoice:${one.order.id}`].sort());
    await h.sql`update invoicing.invoice_lines set delivery_id = null, delivery_line_id = null where invoice_id = ${invoiceId}`;
    await h.run(h.admin, "invoicing.invoice.reprice", { id: invoiceId });
    expect(await kinds()).toEqual([`order_to_invoice:${one.order.id}`, `order_to_invoice:${two.order.id}`].sort());
  });

  it("a delivery voided with a Borrador invoice downstream, then the Borrador deleted: no link row remains and the trail names no phantom", async () => {
    const { order } = await confirmed(1);
    const delivery = await shipped(order.id);
    const made = await h.act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
    const invoiceId = made.result.invoices[0]!.id;
    await h.act("sales.delivery.void", { id: delivery.result.id, reason: "Error de despacho" });
    expect((await linksOf(delivery.result.id)).filter((l) => l.to_id === invoiceId).every((l) => l.voided_at !== null)).toBe(true);
    await h.act("invoicing.invoice.delete", { id: invoiceId });
    expect(await linksOf(invoiceId)).toEqual([]);
    const trail = await trailOf("sales.delivery", delivery.result.id);
    expect(trail.hidden).toBe(0);
    expect(trail.nodes.map((n) => n.id)).toEqual([order.id]);
  });

  it("voiding a cotización that has an order marks its quote_to_order link; the trail flags the cotización, not the live order", async () => {
    const quote = await acceptedQuote(1);
    const order = await h.act<{ id: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId: h.warehouseId, issueDate: h.today });
    const voided = await h.act("crm.quote.void", { id: quote.id, reason: "Cotización anulada" });
    expect((await linksOf(quote.id)).map((l) => [l.kind, l.to_id, l.voided_at !== null, l.voided_chain_id])).toEqual([["quote_to_order", order.result.id, true, voided.chainId]]);
    // The voided cotización is flagged from the order; the live order is not flagged from the cotización.
    expect((await trailOf("crm.quote", quote.id, "down")).nodes.map((n) => [n.id, n.voided])).toEqual([[order.result.id, false]]);
    expect((await trailOf("sales.order", order.result.id, "up")).nodes.map((n) => [n.id, n.voided])).toEqual([[quote.id, true]]);
    expect(await h.sql`select action from kernel.audit_log where company_id = ${h.companyId} and process_id = 'crm.quote.void' and entity = 'crm.quote' and row_id = ${quote.id}`).toContainEqual({ action: "update" });
  });

  it("deleting a Borrador receipt removes its links", async () => {
    const invoiceId = (await h.sql<{ id: string }[]>`select id from invoicing.invoices where company_id = ${h.companyId} limit 1`)[0]!.id;
    const [draft] = await h.sql<{ id: string }[]>`
      insert into payments.receipts (company_id, date, party_id, method_id, method_code, currency, exchange_rate, amount, applied, withholding_total, advance, requires_approval, posts)
      values (${h.companyId}, ${h.today}, ${h.partyId}, ${h.transferId}, 'transfer', 'COP', 1, 1, 0, 0, 1, false, true) returning id`;
    await h.sql`
      insert into kernel.document_links (company_id, from_entity, from_id, to_entity, to_id, kind, chain_id)
      values (${h.companyId}, 'invoicing.invoice', ${invoiceId}, 'payments.receipt', ${draft!.id}, 'invoice_to_receipt', ${randomUUID()})`;
    expect(await linksOf(draft!.id)).toHaveLength(1);
    await h.act("payments.receipt.delete", { id: draft!.id });
    expect(await linksOf(draft!.id)).toEqual([]);
    expect(await h.sql`select 1 from payments.receipts where id = ${draft!.id}`).toHaveLength(0);
    expect(await h.sql`select action from kernel.audit_log where company_id = ${h.companyId} and process_id = 'payments.receipt.delete' and entity = 'payments.receipt' and row_id = ${draft!.id}`).toContainEqual({ action: "delete" });
  });

  it("no process of the five writes a link outside ctx.links", () => {
    const root = join(__dirname, "../../..");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : files(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    for (const module of ["sales", "invoicing", "payments", "crm"]) {
      const sources = files(join(root, module, "src"));
      expect(sources.length, `${module} sources found`).toBeGreaterThan(5);
      for (const file of sources) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(/document_links|document_link_(sync|mark_voided|writer|record|step)/);
      }
    }
  });
});
