import { describe, expect, it } from "vitest";
import { checkFigures, defaultYear, netByAccount, periodRange, periodsOfYear, yearsOf, type PeriodLite } from "../record-tabs-model";

const p = (id: string, year: number, number: number): PeriodLite => ({ id, year, number, startsOn: `${year}-${String(number).padStart(2, "0")}-01` });
const periods = [p("a1", 2025, 12), p("b1", 2026, 1), p("b2", 2026, 2), p("b3", 2026, 3)];

describe("record tabs model", () => {
  it("opens on the latest year with figures and lists the periods of a year in order", () => {
    expect(yearsOf(periods)).toEqual([2026, 2025]);
    expect(defaultYear(periods, new Set(["a1"]))).toBe(2025);
    expect(defaultYear(periods, new Set(["a1", "b2"]))).toBe(2026);
    expect(defaultYear(periods, new Set())).toBe(2026);
    expect(defaultYear([], new Set())).toBeNull();
    expect(periodsOfYear([...periods].reverse(), 2026).map((x) => x.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("a range runs from the earlier to the later period whichever way it is chosen", () => {
    expect(periodRange(periods, "b1", "b3").map((x) => x.id)).toEqual(["b1", "b2", "b3"]);
    expect(periodRange(periods, "b3", "a1").map((x) => x.id)).toEqual(["a1", "b1", "b2", "b3"]);
    expect(periodRange(periods, "zz", "b1")).toEqual([]);
  });

  it("adds the accounts' movement over the range, by code", () => {
    const rows = [
      { periodId: "b1", accountId: "x", code: "5105", name: "Gastos de personal", debit: 800, credit: 0 },
      { periodId: "b2", accountId: "x", code: "5105", name: "Gastos de personal", debit: 200, credit: 50 },
      { periodId: "b3", accountId: "x", code: "5105", name: "Gastos de personal", debit: 999, credit: 0 },
      { periodId: "b2", accountId: "y", code: "4135", name: "Comercio", debit: 0, credit: 1000 },
    ];
    expect(netByAccount(rows, new Set(["b1", "b2"]))).toEqual([
      { accountId: "y", code: "4135", name: "Comercio", debit: 0, credit: 1000, net: -1000 },
      { accountId: "x", code: "5105", name: "Gastos de personal", debit: 1000, credit: 50, net: 950 },
    ]);
  });

  it("shows a close check's figures, amounts as money and counts as they are", () => {
    const money = (n: number) => `$ ${n}`;
    expect(checkFigures({ count: 3, ledger: 100, open: 90, differences: [{ a: 1 }], available: false }, money)).toEqual([
      { key: "count", text: "3" },
      { key: "ledger", text: "$ 100" },
      { key: "open", text: "$ 90" },
      { key: "available", text: "false" },
    ]);
  });
});
