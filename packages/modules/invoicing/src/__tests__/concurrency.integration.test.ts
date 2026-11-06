import { buildConsumerContext, consumers } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoicingHarness, registry, type Harness, type InvoiceOut } from "./helpers";

// Review Focus 2 of Task 16 (fix round 1): concurrency and money. Numbers stay consecutive under concurrent «Emitir», a key replayed in
// parallel gives one result and one event, a consumer that crashed between creating and issuing an automatic invoice issues it once on
// redelivery, nothing is invoiced twice (over_invoicing), an Anular of an entrega or a cancel of a pedido waits for an «Emitir» in flight and
// is then refused, and every issued invoice posts debit = credit with the receivable equal to its total in the company currency (odd
// decimals, a foreign currency, INC on its own account).

let h: Harness;
beforeAll(async () => {
  h = await invoicingHarness();
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

const manual = (lines: { productId: string; qty: number; unitPrice?: number; discountPct?: number }[], extra: Record<string, unknown> = {}) =>
  h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines, ...extra });
const issue = (id: string, extra: Record<string, unknown> = {}) => h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A transaction that holds what an «Emitir» in flight holds (the pedido and its entregas, through sales' published locks) until released. */
async function issueInFlight(orderIds: string[], deliveryIds: string[], whileHeld: (tx: typeof h.sql) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const holding = new Promise<void>((r) => (held = r));
  const done = h.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(h.admin.claims)}, true)`;
    await tx`select set_config('erp.audit_process_id', 'invoicing.invoice.issue', true)`;
    await tx`select * from sales.lock_orders_for_invoice(${orderIds}::uuid[])`;
    if (deliveryIds.length > 0) await tx`select * from sales.lock_deliveries_for_invoice(${deliveryIds}::uuid[])`;
    await whileHeld(tx as unknown as typeof h.sql);
    held();
    await gate;
  });
  await Promise.race([holding, done]);
  return { release, done };
}

/** Marks a Borrador issued as «Emitir» would (number, CUFE, stage), inside the transaction of the simulated issue. */
const markIssued = (tx: typeof h.sql, invoiceId: string, n: number) => tx`
  update invoicing.invoices set number = ${`TEST${n}`}, cufe = ${`${"a".repeat(95)}${n}`}, stage = 'issued', dian_environment = 'habilitacion', issued_at = now(), status = 'posted' where id = ${invoiceId}`;

describe("numbering under concurrency", () => {
  it("two different invoices issued at once take consecutive numbers, no gap", async () => {
    const [a, b] = await Promise.all([manual([{ productId: h.cafe, qty: 1 }]), manual([{ productId: h.cafe, qty: 2 }])]);
    const [x, y] = await Promise.all([issue(a!.id), issue(b!.id)]);
    const numbers = [x!, y!].map((i) => Number(i.number!.replace("SETP", ""))).sort();
    expect(numbers[1]! - numbers[0]!).toBe(1);
    expect(new Set([x!.cufe, y!.cufe]).size).toBe(2);
  });

  it("two parallel «Emitir» with the same key give one result and one event", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    const [x, y] = await Promise.all([issue(draft.id, { idempotencyKey: "twice" }), issue(draft.id, { idempotencyKey: "twice" })]);
    expect(x).toEqual(y);
    expect(await h.issuedEvent(draft.id)).toHaveLength(1);
  });
});

describe("automatic invoices", () => {
  beforeAll(async () => {
    await h.setMode("on_delivery");
  });
  afterAll(async () => {
    await h.setMode("manual");
  });

  it("a consumer that crashed after creating the Borrador and before issuing it issues it once on redelivery: one invoice, one number", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    const delivery = await h.shipDelivery(order.id);
    const [shipped] = await h.sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = 'sales.delivery.shipped' and payload->>'deliveryId' = ${delivery.id}`;
    const ctx = buildConsumerContext(h.sql, { id: shipped!.id, event: shipped!.event, createdAt: shipped!.created_at, companyId: h.companyId, chainId: shipped!.chain_id }, registry);
    // The crash: auto_create committed, the issue never ran.
    await ctx.runProcess("invoicing.invoice.auto_create", { trigger: "delivery", deliveryId: delivery.id });
    expect((await h.invoicesOf({ deliveryId: delivery.id })).map((i) => i.stage)).toEqual(["draft"]);
    // The redelivery (the drain hands the row to every consumer, invoicing's included).
    expect(await h.drain()).toEqual([]);
    const consumer = consumers.for("sales.delivery.shipped").find((c) => c.moduleId === "invoicing")!;
    await consumer.fn(ctx, shipped!.payload);
    const invoices = await h.invoicesOf({ deliveryId: delivery.id });
    expect(invoices.map((i) => i.stage)).toEqual(["issued"]);
    expect(await h.issuedEvent(invoices[0]!.id)).toHaveLength(1);
  });

  it("an automatic invoice of what is already invoiced is a quiet no-op, never a failed delivery", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    expect(await h.invoicesOf({ orderId: order.id })).toHaveLength(1);
    // The same pedido asked again as a whole (the other automatic mode): everything is already invoiced.
    await h.setMode("on_order_confirmation");
    try {
      const [confirmed] = await h.sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = 'sales.order.confirmed' and payload->>'orderId' = ${order.id}`;
      const ctx = buildConsumerContext(h.sql, { id: confirmed!.id, event: confirmed!.event, createdAt: confirmed!.created_at, companyId: h.companyId, chainId: confirmed!.chain_id }, registry);
      const out = (await ctx.runProcess("invoicing.invoice.auto_create", { trigger: "order", orderId: order.id })) as { id: string | null; skipped?: string };
      expect(out).toMatchObject({ id: null, skipped: "over_invoicing" });
      expect(await h.invoicesOf({ orderId: order.id })).toHaveLength(1);
    } finally {
      await h.setMode("on_delivery");
    }
  });
});

describe("nothing is invoiced twice, nothing invoiced is undone", () => {
  it("two «Facturar pedidos» of the same entrega at once: one Borrador, the other refused over_invoicing", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 2 }]);
    await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    // Both read «Por facturar» while the pedido's invoicing lock is held, then go one after the other.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const blocker = h.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`invoicing.order:${h.companyId}:${order.id}`}, 0))`;
      held();
      await gate;
    });
    await holding;
    const both = Promise.all([0, 1].map(() => h.refusal(h.run(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] }))));
    await sleep(400);
    release();
    await blocker;
    const results = await both;
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)?.message).toMatch(/^over_invoicing/);
    expect(await h.invoicesOf({ orderId: order.id })).toHaveLength(1);
  });

  it("race: an Anular of an entrega waits for an «Emitir» in flight and is then refused (delivery_invoiced)", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    const delivery = await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    const { invoices } = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    const flight = await issueInFlight([order.id], [delivery.id], (tx) => markIssued(tx, invoices[0]!.id, 1).then(() => undefined));
    let settled = false;
    const voiding = h.refusal(h.run(h.admin, "sales.delivery.void", { id: delivery.id, reason: "Error" })).finally(() => (settled = true));
    await sleep(400);
    expect(settled).toBe(false);
    flight.release();
    await flight.done;
    expect((await voiding)?.message).toMatch(/^delivery_invoiced/);
  });

  it("an invoiced pedido is never cancelled, even with no entrega; a cancel waits for an «Emitir» in flight", async () => {
    await h.setMode("on_order_confirmation");
    try {
      const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
      expect(await h.drain()).toEqual([]);
      expect((await h.invoicesOf({ orderId: order.id })).map((i) => i.stage)).toEqual(["issued"]);
      expect((await h.refusal(h.run(h.admin, "sales.order.cancel", { id: order.id, reason: "Ya no lo quiere" })))?.message).toMatch(/^order_invoiced/);

      // The race: the automatic invoice stays in Borrador (customer not ready), its «Emitir» is in flight while someone cancels.
      const customer = await h.newCustomer("811222333", "Cancela Rápido S.A.S.");
      const other = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }], { partyId: customer });
      await h.run(h.admin, "core.party.deactivate", { id: customer });
      expect(await h.drain()).toEqual([]);
      const [draft] = await h.invoicesOf({ orderId: other.id });
      expect(draft!.stage).toBe("draft");
      const flight = await issueInFlight([other.id], [], (tx) => markIssued(tx, draft!.id, 2).then(() => undefined));
      let settled = false;
      const cancelling = h.refusal(h.run(h.admin, "sales.order.cancel", { id: other.id, reason: "x" })).finally(() => (settled = true));
      await sleep(400);
      expect(settled).toBe(false);
      flight.release();
      await flight.done;
      expect((await cancelling)?.message).toMatch(/^order_invoiced/);
    } finally {
      await h.setMode("manual");
    }
  });

  it("race: «Emitir» waits for a cancel of the pedido in flight and re-reads the pedido under its lock: refused order_cancelled", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    // A Borrador that bills the pedido line directly (as an invoice of the whole pedido does), the pedido still confirmed.
    await h.sql`update invoicing.invoice_lines set order_id = ${order.id}, order_line_id = ${order.lineIds[0]!} where invoice_id = ${draft.id}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    // The cancel in flight: the pedido FOR UPDATE (as sales.order.cancel takes it), cancelled, committed after «Emitir» has started.
    const cancel = h.sql.begin(async (tx) => {
      await tx`select id from sales.orders where id = ${order.id} for update`;
      await tx`update sales.orders set stage = 'cancelled', cancelled_at = now(), status = 'voided' where id = ${order.id}`;
      held();
      await gate;
    });
    await Promise.race([holding, cancel]);
    let settled = false;
    const issuing = h.refusal(issue(draft.id)).finally(() => (settled = true));
    await sleep(400);
    expect(settled).toBe(false);
    release();
    await cancel;
    expect((await issuing)?.message).toMatch(/^order_cancelled/);
    expect((await h.sql`select stage, number from invoicing.invoices where id = ${draft.id}`)[0]).toEqual({ stage: "draft", number: null });
  });
});

describe("money: every issued invoice balances and its receivable is its total in the company currency", () => {
  const posted = async (invoiceId: string) => {
    const [event] = await h.issuedEvent(invoiceId);
    const [entry] = await h.entriesFor(event!.id);
    const lines = await h.linesOf(entry!.id);
    const [inv] = await h.sql<{ total_company: string }[]>`select total_company::text from invoicing.invoices where id = ${invoiceId}`;
    const [open] = await h.sql<{ open_company: string }[]>`select open_company::text from invoicing.v_open_invoices where invoice_id = ${invoiceId}`;
    return { entry: entry!, lines, totalCompany: Number(inv!.total_company), open: Number(open!.open_company) };
  };
  const receivable = (lines: { code: string; debit: string }[]) => lines.filter((l) => l.code.startsWith("1305")).reduce((s, l) => s + Number(l.debit), 0);

  it("odd decimals over several lines", async () => {
    const draft = await manual([
      { productId: h.cafe, qty: 3, unitPrice: 33.335, discountPct: 7.5 },
      { productId: h.servicio, qty: 1.5, unitPrice: 9999.99, discountPct: 3.33 },
      { productId: h.cafe, qty: 7, unitPrice: 0.5055 },
    ]);
    await issue(draft.id);
    const p = await posted(draft.id);
    expect(p.entry.total_debit).toBe(p.entry.total_credit);
    expect(receivable(p.lines)).toBe(p.totalCompany);
    expect(p.open).toBe(p.totalCompany);
  });

  it("a foreign-currency invoice", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 3, unitPrice: 12.37 }, { productId: h.servicio, qty: 1, unitPrice: 99.99 }], { currency: "USD", exchangeRate: 4123.4567 });
    await issue(draft.id);
    const p = await posted(draft.id);
    expect(p.entry.total_debit).toBe(p.entry.total_credit);
    expect(receivable(p.lines)).toBe(p.totalCompany);
    expect(p.open).toBe(p.totalCompany);
  });

  it("INC 8 % posts to the INC account (249505), not to the IVA one", async () => {
    const restaurante = await h.product("RES-01", { description: "Almuerzo ejecutivo", kind: "service", trackStock: false, listPrice: 23456.78, ivaRate: "EXC", incRate: "8" });
    const draft = await manual([{ productId: restaurante, qty: 3 }]);
    await issue(draft.id);
    const p = await posted(draft.id);
    expect(p.entry.total_debit).toBe(p.entry.total_credit);
    expect(receivable(p.lines)).toBe(p.totalCompany);
    const credit = (prefix: string) => p.lines.filter((l) => l.code.startsWith(prefix)).reduce((s, l) => s + Number(l.credit), 0);
    expect(credit("249505")).toBeCloseTo(Math.round(3 * 23456.78 * 0.08 * 100) / 100, 2);
    expect(credit("2408")).toBe(0);
  });
});
