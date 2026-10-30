import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { composeEntry } from "../compose";
import type { RuleTemplate } from "../template";
import { invoiceEvent, invoiceTemplate } from "./fixtures";

const options = { tolerance: 1, companyCurrency: "COP" };
const simple = (amounts: [number, number]): { template: RuleTemplate; payload: unknown } => ({
  template: {
    description: "t",
    lines: [
      { role: "cash", side: "debit", amount: "$.a" },
      { role: "revenue", side: "credit", amount: "$.b" },
    ],
  },
  payload: { a: amounts[0], b: amounts[1] },
});
const run = (t: RuleTemplate, payload: unknown) => composeEntry(t, { ...invoiceEvent, payload }, options);

describe("posting compose", () => {
  it("composes the §5.4 invoice template into a balanced entry with one revenue line per invoice line and one tax line per tax", () => {
    const r = composeEntry(invoiceTemplate, invoiceEvent, options);
    expect(r.ok && r.entry.lines.map((l) => [l.role, l.side, l.amountCompany])).toEqual([
      ["receivable", "debit", 119000],
      ["revenue", "credit", 50000],
      ["revenue", "credit", 50000],
      ["vat_out", "credit", 19000],
    ]);
    if (!r.ok) throw new Error(r.detail);
    expect(r.entry).toMatchObject({ date: "2026-10-30", description: "Factura FE-1 · Tiendas D1 S.A.S.", currency: "COP", exchangeRate: 1, partyId: "party-1", sourceEventId: "evt-1", chainId: "chain-1" });
    expect(r.entry.lines[1]).toMatchObject({ dimension: "category:bebidas", partyId: "party-1" });
    expect(r.entry.lines[3]).toMatchObject({ taxCode: "01", taxBase: 100000 });
    expect(r.entry.source).toEqual({ entity: "invoicing.invoice", id: "inv-1" });
  });
  it("balances a 0.5 COP difference through a rounding line and refuses 2 COP", () => {
    const ok = simple([100.5, 100]);
    const r = run(ok.template, ok.payload);
    expect(r.ok && r.entry.roundingLine).toMatchObject({ role: "rounding", side: "credit", amountCompany: 0.5 });
    const bad = simple([102, 100]);
    expect(run(bad.template, bad.payload)).toMatchObject({ ok: false, code: "unbalanced" });
  });
  it("drops zero lines, flips negative amounts and rounds half-up in company currency", () => {
    const t: RuleTemplate = { description: "t", lines: [
      { role: "cash", side: "debit", amount: "$.a" },
      { role: "revenue", side: "credit", amount: "$.z" },
      { role: "sales_returns", side: "debit", amount: "$.n" },
      { role: "receivable", side: "credit", amount: "$.m" },
    ] };
    const r = run(t, { a: 1.005, z: 0, n: -1, m: 0.005 });
    expect(r.ok && r.entry.lines.map((l) => [l.role, l.side, l.amountCompany])).toEqual([["cash", "debit", 1.01], ["sales_returns", "credit", 1], ["receivable", "credit", 0.01]]);
  });
  it("converts with the header rate unless the line gives amountCompany", () => {
    const t: RuleTemplate = { description: "t", currency: "$.cur", exchangeRate: "$.rate", lines: [
      { role: "cash", side: "debit", amount: "$.a" },
      { role: "revenue", side: "credit", amount: "$.a", amountCompany: "$.fixed" },
    ] };
    const r = run(t, { cur: "USD", rate: 4000, a: 10, fixed: 40000 });
    expect(r.ok && r.entry.lines.map((l) => [l.amountDoc, l.amountCompany])).toEqual([[10, 40000], [10, 40000]]);
  });
  it("reports an invalid template or a non-numeric amount", () => {
    expect(run({ description: "t", lines: [{ role: "cash", side: "debit", amount: "$.x" }, { role: "revenue", side: "credit", amount: "$.y" }] }, { x: "abc", y: 1 })).toMatchObject({ ok: false, code: "invalid_template" });
    expect(composeEntry({ description: "t", lines: [] } as never, invoiceEvent, options)).toMatchObject({ ok: false, code: "invalid_template" });
  });
  const cents = fc.integer({ min: 0, max: 10_000_000 });
  it("every ok composition has sum debit = sum credit and is deterministic", () => {
    fc.assert(fc.property(fc.array(cents, { minLength: 1, maxLength: 6 }), fc.integer({ min: -150, max: 150 }), (credits, skew) => {
      const total = credits.reduce((a, b) => a + b, 0) + skew;
      const t: RuleTemplate = { description: "t", lines: [
        { role: "receivable", side: "debit", amount: "$.total" },
        { role: "revenue", side: "credit", forEach: "$.items[*]", amount: "$" },
      ] };
      const payload = { total: total / 100, items: credits.map((c) => c / 100) };
      const a = run(t, payload);
      expect(run(t, payload)).toEqual(a);
      if (!a.ok) return;
      const all = [...a.entry.lines, ...(a.entry.roundingLine ? [a.entry.roundingLine] : [])];
      const sum = (side: string) => Math.round(all.filter((l) => l.side === side).reduce((s, l) => s + l.amountCompany * 100, 0));
      expect(sum("debit")).toBe(sum("credit"));
    }), { numRuns: 200 });
  });
});
