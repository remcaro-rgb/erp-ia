import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainHarness, type ChainHarness } from "./chain-helpers";

// Task 31, stage C (design §22.27, plan 2B Task 31 test 5, R31-9): migration 0125 fills kernel.document_links for the documents created
// before 0124. The sales chain is built through the REAL processes (whose writers sync the links, stage B); the company's links are then
// deleted through the service role and the body of 0125 is applied (the file itself, read from supabase/migrations, inside a transaction
// that is rolled back, so the shared local database is not changed). The test lives in the invoicing package, as test 4: the kernel package
// cannot load the sales, invoicing, payments and crm modules that create the data.

let h: ChainHarness;
beforeAll(async () => {
  h = await chainHarness();
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

const MIGRATION = readFileSync(join(__dirname, "../../../../../supabase/migrations/0125_kernel_document_links_backfill.sql"), "utf8");
const setCreation = (invoiceCreation: "manual" | "on_order_confirmation") => h.runStepUp("invoicing.settings.update", { invoiceCreation });

interface Link { kind: string; from_id: string; to_id: string; origin: string; chain_id: string | null; voided_at: Date | null; voided_chain_id: string | null; voided_ends: string[]; created_at: Date }
const keyOf = (l: Pick<Link, "kind" | "from_id" | "to_id">) => `${l.kind}|${l.from_id}|${l.to_id}`;

const acceptedQuote = async (qty: number) => {
  const opportunityId = (await h.run<{ id: string }>(h.admin, "crm.opportunity.create", { title: `Café ${randomUUID().slice(0, 6)}`, partyId: h.partyId, pipelineId: h.pipelineId })).id;
  const quote = await h.run<{ id: string }>(h.admin, "crm.quote.create", { partyId: h.partyId, opportunityId, issueDate: h.today, validUntil: h.plusDays(h.today, 30), lines: [{ productId: h.cafe, qty }] });
  await h.run(h.admin, "crm.quote.send", { id: quote.id });
  await h.run(h.admin, "crm.quote.accept", { id: quote.id });
  expect(await h.drain()).toEqual([]);
  return quote;
};
const fromQuote = (quoteId: string) => h.act<{ id: string }>("sales.order.from_quote", { quoteId, warehouseId: h.warehouseId, issueDate: h.today });
const confirmedOrder = async (qty: number) => {
  const order = (await h.act<{ id: string }>("sales.order.create", { partyId: h.partyId, issueDate: h.today, warehouseId: h.warehouseId, lines: [{ productId: h.cafe, qty }] })).result;
  await h.act("sales.order.confirm", { id: order.id });
  expect(await h.drain()).toEqual([]);
  return order;
};
const shipDelivery = async (orderId: string, qty?: number) => {
  const [line] = await h.sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${orderId} order by line_no`;
  const d = await h.act<{ id: string }>("sales.delivery.create", { orderId, date: h.today, costCenterId: h.costCenterId, ...(qty ? { lines: [{ orderLineId: line!.id, qty }] } : {}) });
  await h.run(h.admin, "sales.delivery.ship", { id: d.result.id });
  expect(await h.drain()).toEqual([]);
  return d.result.id;
};

describe("0125 backfill of the document links", () => {
  it("fills one row per source relation, marks voided and cancelled documents, and a second run adds nothing", async () => {
    await setCreation("manual");
    // 1. A full sale: quote, order, delivery, invoice from the order, receipt.
    const quote = await acceptedQuote(4);
    const order = (await fromQuote(quote.id)).result;
    await h.act("sales.order.confirm", { id: order.id });
    expect(await h.drain()).toEqual([]);
    const delivery = await shipDelivery(order.id);
    const invoiceId = (await h.act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] })).result.invoices[0]!.id;
    await h.act("invoicing.invoice.issue", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    expect(await h.settleDian(invoiceId)).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    const receipt = (await h.act<{ id: string }>("payments.payment.receive", {
      partyId: h.partyId, methodId: h.transferId, amount: 4 * 28500 * 1.05, date: h.today, allocations: [{ invoiceId, amount: 4 * 28500 * 1.05 }],
    })).result.id;
    expect(await h.drain()).toEqual([]);
    // 2. A quote ordered twice: the first order cancelled.
    const quote2 = await acceptedQuote(1);
    const cancelled = (await fromQuote(quote2.id)).result;
    await h.act("sales.order.cancel", { id: cancelled.id, reason: "El cliente cambió de idea" });
    await fromQuote(quote2.id);
    // 3. One order delivered twice, one remisión voided.
    const twice = await confirmedOrder(6);
    await shipDelivery(twice.id, 2);
    const secondDelivery = await shipDelivery(twice.id, 2);
    await h.runStepUp("sales.delivery.void", { id: secondDelivery, reason: "Devuelta" });
    expect(await h.drain()).toEqual([]);
    // 4. Invoices made on the order (order_to_invoice), one receipt over both, the receipt voided, one invoice annulled.
    await setCreation("on_order_confirmation");
    const invoices: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const o = await confirmedOrder(1);
        const [row] = await h.sql<{ invoice_id: string }[]>`select invoice_id from invoicing.invoice_lines where order_id = ${o.id}`;
        invoices.push(row!.invoice_id);
        expect(await h.settleDian(row!.invoice_id)).toBe("accepted");
      }
      expect(await h.drain()).toEqual([]);
    } finally {
      await setCreation("manual");
    }
    const amount = 28500 * 1.05;
    const multi = (await h.act<{ id: string }>("payments.payment.receive", {
      partyId: h.partyId, methodId: h.transferId, amount: amount * 2, date: h.today, allocations: invoices.map((id) => ({ invoiceId: id, amount })),
    })).result.id;
    expect(await h.drain()).toEqual([]);
    await h.runStepUp("payments.payment.void", { id: multi, reason: "Consignación devuelta" }, { ...h.admin, chainId: randomUUID() });
    expect(await h.drain()).toEqual([]);
    const annul = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoices[0]!, reason: "Error en el cliente" });
    expect(await h.drain()).toEqual([]);
    expect(await h.settleDian({ noteId: annul.annulmentNoteId }, ["accepted", "rejected"])).toBe("accepted");
    expect(await h.drain()).toEqual([]);
    expect(receipt && delivery).toBeTruthy();

    // 5. A quote with an order, voided (crm.quote.void marks quote_to_order).
    const quote3 = await acceptedQuote(1);
    const order3 = (await fromQuote(quote3.id)).result;
    await h.run(h.admin, "crm.quote.void", { id: quote3.id, reason: "Cotización retirada" });
    expect(await h.drain()).toEqual([]);

    const readLinks = (sql: typeof h.sql) => sql<Link[]>`
      select kind, from_id, to_id, origin, chain_id, voided_at, voided_chain_id, voided_ends, created_at from kernel.document_links where company_id = ${h.companyId} order by seq`;
    const writerRows = await readLinks(h.sql);
    expect(writerRows.length).toBeGreaterThan(10);
    expect(new Set(writerRows.map((l) => l.kind))).toEqual(new Set(["quote_to_order", "order_to_delivery", "delivery_to_invoice", "order_to_invoice", "invoice_to_receipt"]));
    expect(writerRows.some((l) => l.voided_at !== null)).toBe(true);

    class Rollback extends Error {}
    let result: {
      mutated: Link[]; rows: Link[]; second: Link[]; expected: Record<string, number>; seqs: string[]; counterFirst: number; counterSecond: number;
      afterPartial: { seq: string; kind: string; from_id: string; to_id: string }[]; counterPartial: number; dropped: number; all: number;
    } | undefined;
    await h.sql.begin(async (tx) => {
      await tx`delete from kernel.document_links where company_id = ${h.companyId}`;
      expect(await readLinks(tx as unknown as typeof h.sql)).toEqual([]);
      await tx.unsafe(MIGRATION);
      const rows = await readLinks(tx as unknown as typeof h.sql);
      const counts = async (q: string) => Number((await tx.unsafe<{ n: string }[]>(q, [h.companyId]))[0]!.n);
      const expected = {
        quote_to_order: await counts("select count(*)::text n from sales.orders where company_id = $1 and quote_id is not null"),
        order_to_delivery: await counts("select count(*)::text n from sales.deliveries where company_id = $1"),
        delivery_to_invoice: await counts("select count(*)::text n from (select distinct delivery_id, invoice_id from invoicing.invoice_lines where company_id = $1 and delivery_id is not null) x"),
        order_to_invoice: await counts("select count(*)::text n from (select distinct order_id, invoice_id from invoicing.invoice_lines where company_id = $1 and delivery_id is null and order_id is not null) x"),
        invoice_to_receipt: await counts("select count(*)::text n from (select distinct invoice_id, receipt_id from payments.receipt_allocations where company_id = $1) x"),
      };
      const seqs = (await tx.unsafe<{ seq: string }[]>("select seq::text from kernel.document_links where company_id = $1 order by seq", [h.companyId])).map((r) => r.seq);
      // The counter of the table's gap-free seq: a run that finds every row present must not move it (the trigger burns a seq before the
      // arbiter of `on conflict` looks), and neither may a row the writers already made.
      const counter = async () => Number((await tx.unsafe<{ next: string }[]>("select next::text from core.entity_sequences where company_id = $1 and entity = 'kernel.document_link'", [h.companyId]))[0]!.next);
      const counterFirst = await counter();
      await tx.unsafe(MIGRATION);
      const counterSecond = await counter();
      const second = await readLinks(tx as unknown as typeof h.sql);
      // Partial overlap (writers made some rows between 0124 and 0125): delete every other link, run again.
      const all = await tx.unsafe<{ id: string; seq: string }[]>("select id, seq::text from kernel.document_links where company_id = $1 order by seq", [h.companyId]);
      const dropped = all.filter((_, i) => i % 2 === 0);
      await tx.unsafe("delete from kernel.document_links where id = any($1::uuid[])", [dropped.map((r) => r.id)]);
      await tx.unsafe(MIGRATION);
      const afterPartial = await tx.unsafe<{ seq: string; kind: string; from_id: string; to_id: string }[]>("select seq::text, kind, from_id, to_id from kernel.document_links where company_id = $1 order by seq", [h.companyId]);
      const counterPartial = await counter();
      const kept = new Set(all.filter((_, i) => i % 2 === 1).map((r) => r.id));
      void kept;
      // Voided terms the processes cannot reach one by one (a cancelled order that has a remisión, a voided remisión already invoiced, an
      // invoice voided in status with its stage still issued): stored states set by the service role, with the guard triggers off, inside the rolled-back transaction.
      await tx.unsafe("delete from kernel.document_links where company_id = $1", [h.companyId]);
      await tx`set local session_replication_role = replica`; // the state guards refuse these updates by design; the repair reads stored data
      await tx`update sales.deliveries set status = 'voided' where id = ${delivery}`;
      await tx`update sales.orders set stage = 'cancelled', cancelled_at = now() where id = ${twice.id}`;
      await tx`update invoicing.invoices set status = 'voided' where id = ${invoices[1]!}`;
      await tx`set local session_replication_role = origin`;
      await tx.unsafe(MIGRATION);
      const mutated = await readLinks(tx as unknown as typeof h.sql);
      result = { mutated, rows, second, expected, seqs, counterFirst, counterSecond, afterPartial, counterPartial, dropped: dropped.length, all: all.length };
      throw new Rollback();
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
    const { mutated, rows, second, expected, seqs, counterFirst, counterSecond, afterPartial, counterPartial, dropped } = result!;

    // One row per source relation: the counts equal the distinct pairs in the source tables.
    for (const kind of Object.keys(expected)) expect(rows.filter((l) => l.kind === kind).length, kind).toBe(expected[kind]);
    expect(rows).toHaveLength(Object.values(expected).reduce((a, b) => a + b, 0));
    // They are exactly the rows the writers made: same keys, same voided marking, nothing more.
    expect(rows.map(keyOf).sort()).toEqual(writerRows.map(keyOf).sort());
    const writerVoid = new Map(writerRows.map((l) => [keyOf(l), l.voided_at !== null]));
    for (const l of rows) expect(l.voided_at !== null, keyOf(l)).toBe(writerVoid.get(keyOf(l)));
    // And the same voided END(S): the backfill names the voided document of each link as the writers' markVoided does.
    const writerEnds = new Map(writerRows.map((l) => [keyOf(l), [...l.voided_ends].sort()]));
    for (const l of rows) expect([...l.voided_ends].sort(), keyOf(l)).toEqual(writerEnds.get(keyOf(l)));
    expect(rows.some((l) => l.voided_ends.length === 2), "a link voided from both ends (the voided receipt of an annulled invoice)").toBe(true);
    // Voided and cancelled documents give marked rows (the cancelled order, the voided remisión, the voided receipt, the annulled invoice).
    expect(rows.filter((l) => l.voided_at !== null).length).toBeGreaterThanOrEqual(5);
    expect(rows.some((l) => l.kind === "quote_to_order" && l.to_id === cancelled.id && l.voided_at !== null)).toBe(true);
    expect(rows.some((l) => l.kind === "order_to_delivery" && l.to_id === secondDelivery && l.voided_at !== null)).toBe(true);
    expect(rows.some((l) => l.kind === "invoice_to_receipt" && l.to_id === multi && l.voided_at !== null)).toBe(true);
    expect(rows.filter((l) => l.from_id === invoices[0] || l.to_id === invoices[0]).every((l) => l.voided_at !== null)).toBe(true);
    expect(rows.some((l) => l.kind === "order_to_invoice" && l.voided_at === null)).toBe(true);
    // Stored states: each term of the voided mark is reachable on its own.
    const isVoided = (kind: string, to: string, from?: string) => mutated.find((l) => l.kind === kind && l.to_id === to && (!from || l.from_id === from))!.voided_at !== null;
    expect(isVoided("delivery_to_invoice", invoiceId, delivery), "voided remisión already invoiced").toBe(true);
    expect(isVoided("quote_to_order", order.id), "its order stays live").toBe(false);
    expect(mutated.find((l) => l.kind === "delivery_to_invoice" && l.to_id === invoiceId && l.from_id === delivery)!.voided_ends, "only the delivery is the voided end").toEqual([`sales.delivery:${delivery}`]);
    expect(mutated.filter((l) => l.kind === "order_to_delivery" && l.from_id === twice.id).every((l) => l.voided_at !== null), "cancelled order with remisiones").toBe(true);
    expect(mutated.filter((l) => l.to_id === invoices[1]! || l.from_id === invoices[1]!).every((l) => l.voided_at !== null), "invoice voided by status").toBe(true);
    expect(mutated.filter((l) => l.to_id === invoices[1]! || l.from_id === invoices[1]!)).not.toHaveLength(0);
    // Origin and chain: backfill, no chain, no voiding chain; created_at is the downstream document's.
    expect(rows.every((l) => l.origin === "backfill" && l.chain_id === null && l.voided_chain_id === null)).toBe(true);
    const downstream = new Map<string, number>();
    for (const r of await h.sql<{ id: string; created_at: Date }[]>`
      select id, created_at from sales.orders where company_id = ${h.companyId} union all select id, created_at from sales.deliveries where company_id = ${h.companyId}
      union all select id, created_at from invoicing.invoices where company_id = ${h.companyId} union all select id, created_at from payments.receipts where company_id = ${h.companyId}`) downstream.set(r.id, r.created_at.getTime());
    for (const l of rows) expect(l.created_at.getTime(), keyOf(l)).toBe(downstream.get(l.to_id));
    expect(rows.some((l) => l.kind === "quote_to_order" && l.from_id === quote3.id && l.to_id === order3.id && l.voided_at !== null), "voided quote").toBe(true);
    // seq is gap-free from the table's trigger.
    expect(seqs.map(Number)).toEqual(seqs.map((_, i) => Number(seqs[0]) + i));
    // Idempotent: the second run adds nothing.
    expect(second).toEqual(rows);
    expect(counterSecond, "a second run burns no seq").toBe(counterFirst);
    expect(Number(seqs[seqs.length - 1]) + 1, "the counter is the next of the last seq").toBe(counterFirst);
    // Partial overlap: only the missing half is inserted, with contiguous new seqs after the counter, and the key set is whole again.
    expect(afterPartial.map(keyOf).sort()).toEqual(rows.map(keyOf).sort());
    const fresh = afterPartial.map((r) => Number(r.seq)).filter((n) => n >= counterFirst);
    expect(fresh).toHaveLength(dropped);
    expect(fresh).toEqual(fresh.map((_, i) => counterFirst + i));
    expect(counterPartial).toBe(counterFirst + dropped);
  }, 300_000);
});
