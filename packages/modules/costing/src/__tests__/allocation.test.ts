import { describe, expect, it } from "vitest";
import { CostError, revalue } from "../average";
import { distribute } from "../allocation";

// Landed costs as arithmetic (plan 2B Task 9 Step 1): distribute() splits an amount, in cents, over the lines of a receipt by a base
// (value, quantity or weight) so the increments add up to the amount to the cent (largest remainder); revalue() adds a signed amount
// to a layer's value with its quantity unchanged, so the layer's value stays the sum of its cost events' amounts.

describe("distribute (largest remainder)", () => {
  it("splits in proportion to the base when it divides exactly", () => {
    expect(distribute(100_000, [1000, 3000])).toEqual([25_000, 75_000]);
  });

  it("leaves no cent behind: 100,00 over three equal bases is 33,34 / 33,33 / 33,33", () => {
    const out = distribute(10_000, [1, 1, 1]);
    expect(out).toEqual([3334, 3333, 3333]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("gives the leftover cents to the largest remainders, ties to the earlier line", () => {
    // 10 cents over 1:2:7 -> 1, 2, 7 exactly; 11 cents -> 1.1, 2.2, 7.7 -> floors 1,2,7 (10) + 1 to the largest remainder (7.7)
    expect(distribute(11, [1, 2, 7])).toEqual([1, 2, 8]);
    expect(distribute(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  it("a line with no base gets nothing", () => {
    expect(distribute(500, [0, 5, 0, 5])).toEqual([0, 250, 0, 250]);
  });

  it("always adds up to the total, whatever the bases", () => {
    const bases = [3.3333, 7.1111, 0.0001, 12.5, 99.9999];
    for (const total of [1, 7, 999, 123_457, 98_765_432]) {
      const out = distribute(total, bases.map((b) => Math.round(b * 1e4)));
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      for (const part of out) expect(Number.isInteger(part) && part >= 0).toBe(true);
    }
  });

  it("refuses a total that is not a positive whole number of cents and bases that add up to nothing", () => {
    expect(() => distribute(0, [1])).toThrow(CostError);
    expect(() => distribute(1.5, [1])).toThrow(CostError);
    expect(() => distribute(100, [0, 0])).toThrow(CostError);
    expect(() => distribute(100, [-1, 2])).toThrow(CostError);
  });
});

describe("revalue", () => {
  it("raises the value and the average, the quantity unchanged", () => {
    expect(revalue({ qty: 10, value: 1000, avgCost: 100 }, 500)).toEqual({ amount: 500, after: { qty: 10, value: 1500, avgCost: 150 } });
  });

  it("with units left it is value / qty rounded to 4 decimals", () => {
    expect(revalue({ qty: 3, value: 200, avgCost: 66.6667 }, 100.01).after).toEqual({ qty: 3, value: 300.01, avgCost: 100.0033 });
  });

  it("a layer with no units keeps its last average and holds the value (no value vanishes)", () => {
    expect(revalue({ qty: 0, value: 0, avgCost: 80 }, 50)).toEqual({ amount: 50, after: { qty: 0, value: 50, avgCost: 80 } });
  });

  it("a negative amount takes a landed cost back (a void), to the cent", () => {
    const raised = revalue({ qty: 7, value: 700, avgCost: 100 }, 33.33).after;
    expect(revalue(raised, -33.33).after).toEqual({ qty: 7, value: 700, avgCost: 100 });
  });
});
