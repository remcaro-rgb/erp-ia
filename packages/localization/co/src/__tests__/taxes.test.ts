import { describe, expect, it } from "vitest";
import { co } from "../index";
import { ROUNDING, UVT, computeTaxes, round2, uvtFor } from "../taxes";

const nobody = { responsibilities: ["R-99-PN"] };
const agent = { responsibilities: ["O-23"] };

describe("rounding (Serena amounts.ts)", () => {
  it("pins per-line half-up to 2 decimals", () => {
    expect(ROUNDING).toBe("per_line_half_up_2");
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(740.665)).toBe(740.67);
    expect(round2(-1.005)).toBe(-1.01);
  });
  it("3 x 33,3333 rounds the line once", () => {
    const r = computeTaxes({ lines: [{ quantity: 3, unitPrice: 33.3333, ivaRate: "19" }], party: nobody, date: "2026-03-01" });
    expect(r.lines[0]).toMatchObject({ base: 100, iva: 19, ivaRate: 19, payable: 119 });
    expect(r.total).toBe(119);
  });
});

describe("fixes after review", () => {
  it("a non-agent customer in a year without UVT still computes, no withholdings", () => {
    const r = computeTaxes({ lines: [{ quantity: 1, unitPrice: 1000, ivaRate: "19" }], party: nobody, date: "2040-01-01" });
    expect(r.total).toBe(1190);
    expect(r.withholdingsSuffered).toEqual([]);
  });
  it("an agent in a year without UVT is an error", () => {
    expect(() => computeTaxes({ lines: [{ quantity: 1, unitPrice: 1000, ivaRate: "19" }], party: agent, date: "2040-01-01" })).toThrow(/UVT/);
  });
  it("free sample without reference price is rejected", () => {
    expect(() => computeTaxes({ lines: [{ quantity: 1, unitPrice: 0, isFreeSample: true, ivaRate: "19" }], party: nobody, date: "2026-03-01" })).toThrow(/referencePrice/);
  });
  it("rounds ties on large amounts with 15 significant digits (documented: a tie stored just below .005 rounds up)", () => {
    expect(round2(12345678901.005)).toBe(12345678901.01);
    expect(round2(12345678901.004)).toBe(12345678901);
  });
  it("per-line rounding differs from rounding the total; tax lines add up to taxTotal", () => {
    const lines = [1, 2, 3].map(() => ({ quantity: 1, unitPrice: 10.5, ivaRate: "5" as const }));
    const r = computeTaxes({ lines, party: nobody, date: "2026-03-01" });
    expect(r.lines.map((l) => l.iva)).toEqual([0.53, 0.53, 0.53]); // 0.525 each, half-up per line
    expect(r.taxTotal).toBe(1.59); // rounding the total once would give 1.58
    expect(r.taxes.reduce((s, t) => s + t.amount, 0)).toBeCloseTo(r.taxTotal, 10);
  });
  it("ReteIVA alone via withholdsVat override", () => {
    const r = computeTaxes({ lines: [{ quantity: 1, unitPrice: 2000000, ivaRate: "19" }], party: { responsibilities: ["R-99-PN"], withholdsVat: true }, date: "2026-03-01" });
    expect(r.withholdingsSuffered).toEqual([{ code: "RTEIVA", concept: "compras", rate: 15, base: 380000, amount: 57000 }]);
  });
  it("ReteICA does not depend on the national UVT gate", () => {
    const r = computeTaxes({ lines: [{ quantity: 1, unitPrice: 50000, kind: "service", ivaRate: "19" }], party: { responsibilities: ["R-99-PN"], reteIcaRate: 0.966 }, date: "2040-01-01" });
    expect(r.withholdingsSuffered).toEqual([{ code: "RTEICA", concept: "servicios", rate: 0.966, base: 50000, amount: 483 }]);
  });
});

describe("IVA and INC", () => {
  it("IVA 19, 5, 0 and EXC", () => {
    const r = computeTaxes({
      lines: [
        { quantity: 2, unitPrice: 10000, ivaRate: "19" },
        { quantity: 1, unitPrice: 28500, ivaRate: "5" },
        { quantity: 1, unitPrice: 5000, ivaRate: "0" },
        { quantity: 1, unitPrice: 7000, ivaRate: "EXC" },
      ],
      party: nobody,
      date: "2026-03-01",
    });
    expect(r.lines.map((l) => [l.base, l.ivaRate, l.iva])).toEqual([[20000, 19, 3800], [28500, 5, 1425], [5000, 0, 0], [7000, null, 0]]);
    expect(r.subtotal).toBe(60500);
    expect(r.taxTotal).toBe(5225);
    expect(r.total).toBe(65725);
  });
  it("excluded product yields no tax line; IVA 0 does", () => {
    const r = computeTaxes({ lines: [{ quantity: 1, unitPrice: 7000, ivaRate: "EXC" }], party: nobody, date: "2026-03-01" });
    expect(r.taxes).toEqual([]);
    const z = computeTaxes({ lines: [{ quantity: 1, unitPrice: 7000, ivaRate: "0" }], party: nobody, date: "2026-03-01" });
    expect(z.taxes).toEqual([{ family: "IVA", code: "01", rate: 0, base: 7000, amount: 0 }]);
  });
  it("line with INC 8 (no IVA) and a discount", () => {
    const r = computeTaxes({ lines: [{ quantity: 2, unitPrice: 25000, discount: 5000, ivaRate: "EXC", incRate: "8" }], party: nobody, date: "2026-03-01" });
    expect(r.lines[0]).toMatchObject({ base: 45000, incRate: 8, inc: 3600, iva: 0, payable: 48600 });
    expect(r.taxes).toEqual([{ family: "INC", code: "04", rate: 8, base: 45000, amount: 3600 }]);
  });
  it("other taxes by percent or per unit", () => {
    const r = computeTaxes({ lines: [{ quantity: 10, unitPrice: 1000, ivaRate: "19", otherTaxes: [{ code: "34", amountPerUnit: 35 }, "22"] }], party: nobody, date: "2026-03-01" });
    expect(r.lines[0]?.otherTaxes).toEqual([
      { code: "34", rate: null, amount: 350, rateKnown: true },
      { code: "22", rate: null, amount: 0, rateKnown: false },
    ]);
    expect(r.lines[0]?.payable).toBe(10000 + 1900 + 350);
  });
});

describe("free sample", () => {
  it("taxes on the reference price, payable 0, outside the document total", () => {
    const r = computeTaxes({
      lines: [
        { quantity: 2, unitPrice: 0, isFreeSample: true, referencePrice: 10000, ivaRate: "19" },
        { quantity: 1, unitPrice: 10000, ivaRate: "19" },
      ],
      party: nobody,
      date: "2026-03-01",
    });
    expect(r.lines[0]).toMatchObject({ base: 20000, iva: 3800, payable: 0, freeSample: true });
    expect(r.freeSampleBase).toBe(20000);
    expect(r.subtotal).toBe(10000);
    expect(r.total).toBe(11900);
  });
});

describe("withholdings suffered", () => {
  it("UVT table by document year", () => {
    expect(UVT[2026]).toBe(52374);
    expect(uvtFor("2026-12-31")).toBe(52374);
    expect(uvtFor("2025-01-01")).toBe(49799);
    expect(() => uvtFor("2040-01-01")).toThrow(/UVT/);
  });
  it("none when the customer is not an agent", () => {
    const r = computeTaxes({ lines: [{ quantity: 1, unitPrice: 5000000, ivaRate: "19" }], party: nobody, date: "2026-03-01" });
    expect(r.withholdingsSuffered).toEqual([]);
  });
  it("goods at 2,5 % from 27 UVT (1.414.098) and ReteIVA 15 % of the IVA", () => {
    const below = computeTaxes({ lines: [{ quantity: 1, unitPrice: 1414000, ivaRate: "19" }], party: agent, date: "2026-03-01" });
    expect(below.withholdingsSuffered).toEqual([]);
    const at = computeTaxes({ lines: [{ quantity: 1, unitPrice: 1414098, ivaRate: "19" }], party: agent, date: "2026-03-01" });
    expect(at.withholdingsSuffered).toEqual([
      { code: "RTEFTE", concept: "compras", rate: 2.5, base: 1414098, amount: 35352.45 },
      { code: "RTEIVA", concept: "compras", rate: 15, base: 268678.62, amount: 40301.79 },
    ]);
  });
  it("services at 4 % from 4 UVT, and the previous year's UVT for an older date", () => {
    const l = [{ quantity: 1, unitPrice: 220000, kind: "service" as const, ivaRate: "19" as const }];
    const y26 = computeTaxes({ lines: l, party: agent, date: "2026-03-01" });
    expect(y26.withholdingsSuffered.map((w) => [w.code, w.rate, w.amount])).toEqual([["RTEFTE", 4, 8800], ["RTEIVA", 15, 6270]]);
    // 4 UVT: 209.496 in 2026, 199.196 in 2025; 190.000 is below both
    expect(computeTaxes({ lines: [{ quantity: 1, unitPrice: 205000, kind: "service", ivaRate: "19" }], party: agent, date: "2026-03-01" }).withholdingsSuffered).toEqual([]);
    expect(computeTaxes({ lines: [{ quantity: 1, unitPrice: 205000, kind: "service", ivaRate: "19" }], party: agent, date: "2025-03-01" }).withholdingsSuffered).toHaveLength(2);
    const small = [{ quantity: 1, unitPrice: 190000, kind: "service" as const, ivaRate: "19" as const }];
    expect(computeTaxes({ lines: small, party: agent, date: "2025-03-01" }).withholdingsSuffered).toEqual([]);
  });
  it("ReteICA only with the municipality rate", () => {
    const r = computeTaxes({ lines: [{ quantity: 1, unitPrice: 300000, kind: "service", ivaRate: "EXC" }], party: { responsibilities: ["O-13"], reteIcaRate: 0.966 }, date: "2026-03-01" });
    expect(r.withholdingsSuffered.find((w) => w.code === "RTEICA")).toMatchObject({ rate: 0.966, base: 300000, amount: 2898 });
  });
});

describe("pack wiring", () => {
  it("exposes taxes on the country pack", () => {
    expect(co.taxes.computeTaxes).toBe(computeTaxes);
    expect(co.taxes.rounding).toBe("per_line_half_up_2");
  });
});
