import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoicingHarness, type Harness, type InvoiceOut } from "./helpers";

// Foreign-currency Borradores (plan 2B.2 Task 34.3; FX §2 document default, §8; owner items 118, 124, 127, 128; rulings R34-2, R34-7):
//   (1) a USD export invoice without a typed rate takes the rate of its date from Tasas de cambio (core.v_exchange_rates); no rate there →
//       exchange_rate_missing; a typed rate wins and stays editable while the invoice is a Borrador;
//   (2) a USD invoice to a customer in Colombia is refused with foreign_currency_domestic at create, update and issue (export only, item 124);
//   (3) «Recalcular precios» of a USD Borrador converts the free lines from the list price at the invoice's rate and keeps the pedido's lines;
//   (4) «Facturar pedidos» groups by customer and currency (not rate) and takes the rate of the invoice's date (item 128).

let h: Harness;
let buyer: string;
beforeAll(async () => {
  h = await invoicingHarness();
  buyer = (await h.run<{ id: string }>(h.admin, "core.party.create", {
    kind: ["customer"], personType: "1", documentType: "50", documentNumber: "555123456", legalName: "Coffee Importers LLC", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
    countryCode: "US", addressLine: "100 Main St, Seattle WA", invoiceEmail: "ap@importers.example",
  })).id;
  await h.markReady(buyer);
}, 300_000);
afterAll(async () => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
  await h.cleanup();
});

const setRate = (rateDate: string, rate: number) =>
  h.sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', ${rateDate}, ${rate}, 'trm')
        on conflict (company_id, currency, rate_date) do update set rate = excluded.rate`;
const rateOf = async (id: string) => Number((await h.sql<{ r: string }[]>`select exchange_rate::text as r from invoicing.invoices where id = ${id}`)[0]!.r);
const totalCompany = async (id: string) => Number((await h.sql<{ t: string }[]>`select total_company::text as t from invoicing.invoices where id = ${id}`)[0]!.t);
const unitPrices = async (id: string) => (await h.sql<{ p: string }[]>`select unit_price::text as p from invoicing.invoice_lines where invoice_id = ${id} order by line_no`).map((r) => Number(r.p));
const usdDraft = (input: Record<string, unknown>) =>
  h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: buyer, currency: "USD", lines: [{ productId: h.servicio, qty: 1, unitPrice: 12.5 }], ...input });

describe("the rate of a foreign-currency invoice (FX §2, R34-2)", () => {
  it("without a typed rate takes the table's rate of the issue date; a typed rate wins and stays editable in Borrador", async () => {
    await setRate(h.day(4, 5), 4123.45);
    const fromTable = await usdDraft({ issueDate: h.day(4, 5) });
    expect(await rateOf(fromTable.id)).toBe(4123.45);
    const typed = await usdDraft({ issueDate: h.day(4, 5), exchangeRate: 4000 });
    expect(await rateOf(typed.id)).toBe(4000);
    const atTyped = await totalCompany(typed.id);
    expect(atTyped).toBeGreaterThan(12.5 * 4000);
    await h.run(h.admin, "invoicing.invoice.update", { id: typed.id, exchangeRate: 4100 });
    expect(await rateOf(typed.id)).toBe(4100);
    // The company amounts follow the new rate (within the per-line cent rounding).
    expect(Math.abs((await totalCompany(typed.id)) - (atTyped / 4000) * 4100)).toBeLessThan(50);
  });

  it("no row for the date (nor in the 3 days before) and no typed rate → exchange_rate_missing, nothing written", async () => {
    const before = (await h.sql`select id from invoicing.invoices where company_id = ${h.companyId}`).length;
    const refused = await h.refusal(usdDraft({ issueDate: h.day(6, 20) }));
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toMatch(/^exchange_rate_missing/);
    expect(String((refused?.details as string[])[0])).toContain("USD");
    expect((await h.sql`select id from invoicing.invoices where company_id = ${h.companyId}`).length).toBe(before);
  });

  it("a rate typed on a company-currency invoice is refused on update (a COP invoice's rate is 1)", async () => {
    const cop = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.servicio, qty: 1 }] });
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.update", { id: cop.id, exchangeRate: 4000 }));
    expect(refused?.code).toBe("invalid_input");
    expect(await rateOf(cop.id)).toBe(1);
  });
});

describe("export only (item 124, R34-7)", () => {
  it("a USD invoice to a customer in Colombia is refused at create with foreign_currency_domestic", async () => {
    const refused = await h.refusal(usdDraft({ partyId: h.partyId, exchangeRate: 4000 }));
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toMatch(/^foreign_currency_domestic/);
  });

  it("a customer whose country changed to Colombia after the draft: update and issue are refused", async () => {
    const other = (await h.run<{ id: string }>(h.admin, "core.party.create", {
      kind: ["customer"], personType: "1", documentType: "50", documentNumber: "555987654", legalName: "Roasters Inc", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
      countryCode: "US", addressLine: "1 Pike St, Seattle WA", invoiceEmail: "ap@roasters.example",
    })).id;
    await h.markReady(other);
    const draft = await usdDraft({ partyId: other, exchangeRate: 4000 });
    await h.sql`update core.parties set country_code = 'CO', department_code = '11', municipality_code = '11001' where id = ${other}`;
    expect((await h.refusal(h.run(h.admin, "invoicing.invoice.update", { id: draft.id, notes: "x" })))?.message).toMatch(/^foreign_currency_domestic/);
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
    expect(refused?.message).toMatch(/^foreign_currency_domestic/);
    expect((await h.sql<{ stage: string }[]>`select stage from invoicing.invoices where id = ${draft.id}`)[0]!.stage).toBe("draft");
  });

  it("a COP invoice to a foreign buyer is still allowed (the refusal is about the currency, not the buyer)", async () => {
    const cop = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: buyer, lines: [{ productId: h.servicio, qty: 1 }] });
    expect(cop.stage).toBe("draft");
  });
});

/** A confirmed USD pedido of the foreign buyer at `rate`, its cafe line at 5 USD, shipped whole. */
const shippedUsdOrder = async (rate: number, currency = "USD") => {
  const order = await h.run<{ id: string }>(h.admin, "sales.order.create", {
    partyId: buyer, issueDate: h.day(3, 1), warehouseId: h.warehouseId, currency, ...(currency === "USD" ? { exchangeRate: rate } : {}),
    lines: [{ productId: h.cafe, qty: 1, unitPrice: currency === "USD" ? 5 : 20000 }],
  });
  await h.run(h.admin, "sales.order.confirm", { id: order.id });
  await h.shipDelivery(order.id);
  const [line] = await h.sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id}`;
  return { id: order.id, lineId: line!.id };
};

describe("«Recalcular precios» of a foreign Borrador (item 118, FX §8)", () => {
  it("converts a free line from the list price at the invoice's rate (half up to the cent) and keeps a pedido's line", async () => {
    const order = await shippedUsdOrder(4000);
    const draft = await usdDraft({ issueDate: h.day(4, 5), exchangeRate: 4000, lines: [{ productId: h.cafe, qty: 1, unitPrice: 9 }, { productId: h.servicio, qty: 1, unitPrice: 1 }] });
    await h.sql`update invoicing.invoice_lines set order_id = ${order.id}, order_line_id = ${order.lineId} where invoice_id = ${draft.id} and line_no = 1`;
    const out = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.reprice", { id: draft.id });
    // servicio's list price 50.000 / 4.000 = 12,50 USD; the pedido's line keeps 9.
    expect(await unitPrices(draft.id)).toEqual([9, 12.5]);
    expect(out.subtotal).toBe(21.5);
  });
});

describe("«Facturar pedidos» in a foreign currency (item 128)", () => {
  it("two USD pedidos at different rates make one invoice at the rate of the invoice's date", async () => {
    const a = await shippedUsdOrder(4000);
    const b = await shippedUsdOrder(4100);
    await setRate(h.day(5, 6), 4200);
    const out = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [a.id, b.id], issueDate: h.day(5, 6) });
    expect(out.invoices).toHaveLength(1);
    expect(await rateOf(out.invoices[0]!.id)).toBe(4200);
    expect(await unitPrices(out.invoices[0]!.id)).toEqual([5, 5]);
  });

  it("a COP and a USD pedido of the same customer make two invoices", async () => {
    const usd = await shippedUsdOrder(4000);
    const cop = await shippedUsdOrder(1, "COP");
    await setRate(h.day(5, 7), 4210);
    const out = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [usd.id, cop.id], issueDate: h.day(5, 7) });
    expect(out.invoices).toHaveLength(2);
    expect((await Promise.all(out.invoices.map((i) => rateOf(i.id)))).sort((x, y) => x - y)).toEqual([1, 4210]);
  });

  it("no rate on the invoice's date → exchange_rate_missing", async () => {
    const usd = await shippedUsdOrder(4000);
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.from_orders", { orderIds: [usd.id], issueDate: h.day(7, 20) }));
    expect(refused?.message).toMatch(/^exchange_rate_missing/);
  });
});
