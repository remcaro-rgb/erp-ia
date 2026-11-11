import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoicingHarness, registry, type Harness, type InvoiceOut } from "./helpers";

// «Recalcular precios» (plan 2B.2 Task 50.17, owner item 17): the Borrador keeps its prices until the user asks; invoicing.invoice.reprice
// sets them from the products' list price of today and taxes them on the invoice's date, writing price_date = the company's today;
// «Emitir» never re-prices (it re-dates, re-taxes at the issue date and warns when price_date differs from the issue date).

let h: Harness;
beforeAll(async () => {
  h = await invoicingHarness();
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

const draftOf = (lines: { productId: string; qty: number; unitPrice?: number }[]) =>
  h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, issueDate: h.day(4, 5), lines });
const priceDate = async (id: string) => (await h.sql<{ d: string }[]>`select price_date::text as d from invoicing.invoices where id = ${id}`)[0]!.d;
const unitPrices = async (id: string) => (await h.sql<{ p: string }[]>`select unit_price::text as p from invoicing.invoice_lines where invoice_id = ${id} order by line_no`).map((r) => Number(r.p));

describe("invoicing.invoice.reprice", () => {
  it("a new Borrador records the company's today as its price date; the process is a normal update", async () => {
    const draft = await draftOf([{ productId: h.servicio, qty: 1 }]);
    expect(await priceDate(draft.id)).toBe(h.today);
    expect(registry.process("invoicing.invoice.reprice")).toMatchObject({ kind: "update", id: "invoicing.invoice.reprice" });
    expect(registry.process("invoicing.invoice.reprice").sensitivity ?? "normal").toBe("normal");
  });

  it("sets the prices from today's list, taxes them again and writes price_date = today; a typed price is replaced by the list", async () => {
    const draft = await draftOf([{ productId: h.servicio, qty: 2, unitPrice: 40000 }]);
    expect(await unitPrices(draft.id)).toEqual([40000]);
    await h.sql`update core.products set list_price = 60000 where id = ${h.servicio}`;
    await h.sql`update invoicing.invoices set price_date = ${h.day(1, 2)} where id = ${draft.id}`;
    try {
      const out = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.reprice", { id: draft.id });
      expect(await unitPrices(draft.id)).toEqual([60000]);
      expect(await priceDate(draft.id)).toBe(h.today);
      // 2 × 60.000 at 19 %.
      expect(out).toMatchObject({ subtotal: 120000, taxTotal: 22800, total: 142800, issueDate: h.day(4, 5) });
      const [taxes] = await h.sql<{ amount: string }[]>`select sum(amount)::text as amount from invoicing.invoice_taxes where invoice_id = ${draft.id}`;
      expect(Number(taxes!.amount)).toBe(22800);
    } finally {
      await h.sql`update core.products set list_price = 50000 where id = ${h.servicio}`;
    }
  });

  it("a line billed from a pedido keeps the agreed price; a free line takes the list; totals are recomputed and price_date is today (Task 52.4, item 50)", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 1 }]);
    const draft = await draftOf([{ productId: h.cafe, qty: 2, unitPrice: 18000 }, { productId: h.servicio, qty: 1, unitPrice: 40000 }]);
    // Link the first line to the pedido's line, as «Facturar pedidos» does (the processes do not let a Borrador mix both).
    await h.sql`update invoicing.invoice_lines set order_id = ${order.id}, order_line_id = ${order.lineIds[0]!} where invoice_id = ${draft.id} and line_no = 1`;
    const [cafe] = await h.sql<{ list_price: string | null }[]>`select list_price::text from core.products where id = ${h.cafe}`;
    expect(Number(cafe!.list_price)).not.toBe(18000);
    await h.sql`update invoicing.invoices set price_date = ${h.day(1, 2)} where id = ${draft.id}`;
    const out = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.reprice", { id: draft.id });
    // The pedido's line stays at 18.000; the free one goes to the list (50.000).
    expect(await unitPrices(draft.id)).toEqual([18000, 50000]);
    expect(await priceDate(draft.id)).toBe(h.today);
    expect(out.subtotal).toBe(2 * 18000 + 50000);
  });

  it("a draft in a foreign currency is repriced in its currency: the list price converts at the invoice's rate (Task 34.3, item 118 lifted)", async () => {
    const buyer = (await h.run<{ id: string }>(h.admin, "core.party.create", {
      kind: ["customer"], personType: "1", documentType: "50", documentNumber: "555000111", legalName: "Export Buyer LLC", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
      countryCode: "US", addressLine: "100 Main St, Seattle WA", invoiceEmail: "ap@buyer.example",
    })).id;
    await h.markReady(buyer);
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: buyer, issueDate: h.day(4, 5), currency: "USD", exchangeRate: 4000, lines: [{ productId: h.servicio, qty: 1, unitPrice: 12 }] });
    await h.run(h.admin, "invoicing.invoice.reprice", { id: draft.id });
    // 50.000 / 4.000 = 12,50 USD.
    expect(await unitPrices(draft.id)).toEqual([12.5]);
  });

  it("an issued invoice is refused and nothing changes", async () => {
    const draft = await draftOf([{ productId: h.servicio, qty: 1 }]);
    await h.run(h.admin, "invoicing.invoice.issue", { id: draft.id });
    const before = await unitPrices(draft.id);
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.reprice", { id: draft.id }));
    expect(refused?.code).toBe("invalid_state");
    expect(refused?.message).toMatch(/^invoice_issued/);
    expect(await unitPrices(draft.id)).toEqual(before);
  });

  it("«Emitir» keeps the Borrador's prices, re-evaluates taxes at the issue date and leaves price_date alone; it warns when the price date is not the issue date", async () => {
    const draft = await draftOf([{ productId: h.servicio, qty: 1, unitPrice: 40000 }]);
    await h.sql`update core.products set list_price = 90000 where id = ${h.servicio}`;
    await h.sql`update invoicing.invoices set price_date = ${h.day(1, 2)} where id = ${draft.id}`;
    try {
      const issued = await h.run<InvoiceOut & { priceWarning?: string | null }>(h.admin, "invoicing.invoice.issue", { id: draft.id });
      expect(issued).toMatchObject({ issueDate: h.today, subtotal: 40000, taxTotal: 7600, total: 47600 });
      expect(await unitPrices(draft.id)).toEqual([40000]);
      expect(await priceDate(draft.id)).toBe(h.day(1, 2));
      expect(issued.priceWarning).toContain(h.day(1, 2));
    } finally {
      await h.sql`update core.products set list_price = 50000 where id = ${h.servicio}`;
    }
    const fresh = await draftOf([{ productId: h.servicio, qty: 1 }]);
    const clean = await h.run<InvoiceOut & { priceWarning?: string | null }>(h.admin, "invoicing.invoice.issue", { id: fresh.id });
    expect(clean.priceWarning ?? null).toBeNull();
  });
});
