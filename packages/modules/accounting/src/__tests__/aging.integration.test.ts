import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReport } from "@erp/kernel";
// The payments harness (core, accounting on the demo chart, invoicing and payments): accounting cannot depend on payments or invoicing.
import { paymentsHarness, registry, type Harness } from "../../../payments/src/__tests__/helpers";

// Cartera por edades in both currencies (plan 2B.2 Task 34.7; FX §7; review focus 2 of Task 34): the parameter «Moneda»,
// `currency: "company" | "document"` (default company).
//   (9) «Moneda del documento» groups the rows by currency with a subtotal per currency and no grand total across currencies;
//       «Equivalente en COP» is today's report: every figure in pesos, the footer totals over every party.

let h: Harness;
let export0: string;
let usdParty: string;
let copParty: string;
const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Record<string, any>[]; total: number; aggregates: Record<string, any> };
const aging = (params: Record<string, unknown> = {}) => runReport({ sql: h.sql, registry }, h.admin, "accounting.aging", { kind: "receivable", asOf: h.today, ...params }, state) as Promise<Out>;
const FIGURES = ["not_due", "b1", "b2", "b3", "over", "credits", "total"] as const;
const figures = (row: Record<string, unknown>) => Object.fromEntries(FIGURES.map((f) => [f, row[f]]));

beforeAll(async () => {
  h = await paymentsHarness();
  export0 = (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku: "EXP-01", description: "Café verde de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
  usdParty = await h.newCustomer("901360001", "Northwind Roasters LLC");
  copParty = await h.newCustomer("901360002", "Almacenes del Valle S.A.S.");
  await h.issuedInvoice(1, { partyId: usdParty, currency: "USD", exchangeRate: 4100, productId: export0, unitPrice: 1000 });
  await h.issuedInvoice(1, { partyId: usdParty, currency: "USD", exchangeRate: 4200, productId: export0, unitPrice: 250 });
  await h.issuedInvoice(1, { partyId: copParty });
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

describe("(9) «Moneda del documento»", () => {
  it("groups by currency with a USD subtotal and a COP subtotal, in each one's own figures, and no grand total", async () => {
    const out = await aging({ currency: "document" });
    const usd = out.rows.filter((r) => r.currency === "USD");
    const cop = out.rows.filter((r) => r.currency === "COP");
    expect(usd.map((r) => [r.row_kind, r.party_id ?? null])).toEqual([["detail", usdParty], ["subtotal", null]]);
    expect(figures(usd[0]!)).toEqual({ not_due: 1250, b1: 0, b2: 0, b3: 0, over: 0, credits: 0, total: 1250 });
    expect(usd[1]).toMatchObject({ party_name: "Subtotal USD", total: 1250, not_due: 1250 });
    const copDetail = cop.filter((r) => r.row_kind === "detail");
    expect(copDetail.map((r) => r.party_id)).toEqual(expect.arrayContaining([copParty]));
    const copSubtotal = cop.find((r) => r.row_kind === "subtotal")!;
    expect(copSubtotal).toMatchObject({ party_name: "Subtotal COP" });
    expect(copSubtotal.total).toBe(copDetail.reduce((s, r) => s + r.total, 0));
    // The groups follow each other: every USD row after every COP row (alphabetical by code), each subtotal closing its group.
    expect(out.rows.map((r) => `${r.currency}:${r.row_kind}`).filter((v, i, a) => a.indexOf(v) === i)).toEqual(["COP:detail", "COP:subtotal", "USD:detail", "USD:subtotal"]);
    for (const field of FIGURES) expect(out.aggregates[field]).toBeUndefined();
    expect(out.aggregates).toMatchObject({ currency: "document" });
  });
});

describe("(9) «Equivalente en COP»", () => {
  it("is the default and today's report: every row in pesos, no subtotal row, the footer totals over every party", async () => {
    const byDefault = await aging();
    const company = await aging({ currency: "company" });
    expect(company).toEqual(byDefault);
    expect(company.rows.every((r) => r.currency === "COP" && r.row_kind === "detail")).toBe(true);
    const usd = company.rows.find((r) => r.party_id === usdParty)!;
    expect(figures(usd)).toEqual({ not_due: 5150000, b1: 0, b2: 0, b3: 0, over: 0, credits: 0, total: 5150000 });
    expect(company.aggregates.total).toBe(company.rows.reduce((s, r) => s + r.total, 0));
    expect(company.aggregates).toMatchObject({ currency: "company", valuesIn: "COP" });
  });
});

// Detalle de cartera (owner 2026-11-11): a figure of the aging drills down to the open items that make it.
const detail = (params: Record<string, unknown> = {}) => runReport({ sql: h.sql, registry }, h.admin, "accounting.aging_detail", { kind: "receivable", asOf: h.today, ...params }, state) as Promise<Out>;

describe("Detalle de cartera", () => {
  it("lists the documents of a party's bucket, each with its comprobante, and they add up to the aging's figure", async () => {
    const row = (await aging()).rows.find((r) => r.party_id === usdParty)!;
    const out = await detail({ partyId: usdParty, bucket: "not_due" });
    expect(out.rows).toHaveLength(2);
    expect(out.rows.every((r) => r.party_id === usdParty && r.bucket === "report.aging.not_due" && typeof r.entry_id === "string" && r.number !== "")).toBe(true);
    expect(out.rows.reduce((s, r) => s + r.open, 0)).toBe(row.not_due);
    expect(out.aggregates.open).toBe(row.not_due);
    // «Total» is every bucket; another bucket of the same party has nothing.
    expect((await detail({ partyId: usdParty, bucket: "all" })).rows).toHaveLength(2);
    expect((await detail({ partyId: usdParty, bucket: "over" })).rows).toHaveLength(0);
  });

  it("in «Moneda del documento» lists each item in its own currency, only the clicked currency's", async () => {
    const out = await detail({ currency: "document", currencyCode: "USD" });
    expect(out.rows.map((r) => [r.currency, r.open]).sort()).toEqual([["USD", 1000], ["USD", 250]].sort());
  });
});
