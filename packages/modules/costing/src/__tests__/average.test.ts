import { describe, expect, it } from "vitest";
import { averageOf, CostError, EMPTY_LAYER, enter, exit, exitEstimateFits, reverse } from "../average";

// The weighted average as arithmetic (plan 2B Task 8 Step 1): the integration tests run the same cases through the inventory events.

describe("weighted average", () => {
  it("receipts 10 @ 100 and 10 @ 120 give an average of 110", () => {
    const first = enter(EMPTY_LAYER, 10, 100);
    expect(first).toEqual({ amount: 1000, after: { qty: 10, value: 1000, avgCost: 100 } });
    const second = enter(first.after, 10, 120);
    expect(second).toEqual({ amount: 1200, after: { qty: 20, value: 2200, avgCost: 110 } });
  });

  it("an issue of 5 is valued at the average (550) and leaves the average unchanged", () => {
    const layer = { qty: 20, value: 2200, avgCost: 110 };
    expect(exit(layer, 5)).toEqual({ unitCost: 110, amount: 550, after: { qty: 15, value: 1650, avgCost: 110 } });
  });

  it("an issue after another receipt uses the new average", () => {
    const after = enter({ qty: 15, value: 1650, avgCost: 110 }, 10, 140).after;
    expect(after).toEqual({ qty: 25, value: 3050, avgCost: 122 });
    expect(exit(after, 5)).toMatchObject({ unitCost: 122, amount: 610 });
  });

  it("taking the whole remaining quantity takes the whole remaining value (no cent left behind)", () => {
    const layer = enter(enter(EMPTY_LAYER, 1, 100).after, 2, 50).after; // 3 units worth 200: average 66.6667
    expect(layer).toEqual({ qty: 3, value: 200, avgCost: 66.6667 });
    const one = exit(layer, 1);
    expect(one.amount).toBe(66.67);
    expect(exit(one.after, 2)).toMatchObject({ amount: 133.33, after: { qty: 0, value: 0 } });
  });

  it("refuses a negative cost on an entry and on an exit at a given cost", () => {
    expect(() => enter(EMPTY_LAYER, 1, -5)).toThrow(CostError);
    expect(() => enter(EMPTY_LAYER, 1, -5)).toThrow(/^negative_cost_refused/);
    expect(() => exit({ qty: 2, value: 200, avgCost: 100 }, 1, -1)).toThrow(/^negative_cost_refused/);
    expect(() => enter(EMPTY_LAYER, 0, 5)).toThrow(/^invalid_quantity/);
  });

  it("a layer without a cost gives 0 on an exit; an entry into a backordered layer keeps its value (−3, −300) + 10 @ 120 → (7, 900), average 128.57", () => {
    expect(exit(EMPTY_LAYER, 3)).toEqual({ unitCost: 0, amount: 0, after: { qty: -3, value: 0, avgCost: null } });
    expect(enter({ qty: -3, value: -300, avgCost: 100 }, 10, 120)).toEqual({ amount: 1200, after: { qty: 7, value: 900, avgCost: 128.5714 } });
  });

  it("an exit below zero takes qty × the last average and keeps value = old value − amount", () => {
    expect(exit({ qty: 2, value: 200, avgCost: 100 }, 5)).toEqual({ unitCost: 100, amount: 500, after: { qty: -3, value: -300, avgCost: 100 } });
  });

  it("an exit at a given cost (an adjustment) removes exactly qty × that cost, even past the layer's value (no floor)", () => {
    expect(exit({ qty: 10, value: 1000, avgCost: 100 }, 2, 150)).toEqual({ unitCost: 150, amount: 300, after: { qty: 8, value: 700, avgCost: 87.5 } });
    expect(exit({ qty: 10, value: 1000, avgCost: 100 }, 9, 200)).toEqual({ unitCost: 200, amount: 1800, after: { qty: 1, value: -800, avgCost: 0 } });
  });

  it("the average is value / qty at full precision: 3 units worth 200 issue 1 at 66.67 and the remaining 2 at 133.33", () => {
    const layer = { qty: 3, value: 200, avgCost: 66.6667 };
    expect(averageOf(layer)).toBeCloseTo(200 / 3, 10);
    const one = exit(layer, 1);
    expect(one).toMatchObject({ unitCost: 66.6667, amount: 66.67, after: { qty: 2, value: 133.33 } });
  });

  it("value after = value before + signed amount, for every shape", () => {
    let layer = EMPTY_LAYER;
    const steps: [string, number, number?][] = [["in", 10, 100], ["out", 4], ["out", 9], ["in", 5, 130], ["out", 1, 77], ["in", 3, 0], ["out", 2], ["out", 2]];
    let sum = 0;
    for (const [kind, qty, cost] of steps) {
      const r = kind === "in" ? enter(layer, qty, cost!) : exit(layer, qty, cost);
      const signed = kind === "in" ? r.amount : -r.amount;
      expect(r.after.value).toBeCloseTo(layer.value + signed, 10);
      sum += signed;
      layer = r.after;
    }
    expect(layer.value).toBeCloseTo(sum, 10);
  });
});

describe("reverse (the void of a cost event, Task 14)", () => {
  it("a sale issue voided right after it was valued leaves the layer as it was", () => {
    const stocked = enter(enter(EMPTY_LAYER, 10, 100).after, 10, 120).after;
    const issued = exit(stocked, 3);
    expect(issued.amount).toBe(330);
    const back = reverse(issued.after, -3, -330);
    expect(back).toEqual({ qty: 3, amount: 330, after: stocked });
  });

  it("a receipt voided takes out exactly its qty and amount; the average is read from what remains", () => {
    const first = enter(EMPTY_LAYER, 10, 100).after;
    const second = enter(first, 10, 120);
    const issued = exit(second.after, 5).after; // 15 units worth 1.650
    const back = reverse(issued, 10, second.amount);
    expect(back.after).toEqual({ qty: 5, value: 450, avgCost: 90 });
    expect(round(back.after.value - issued.value)).toBe(-1200);
  });

  it("a layer emptied by the void keeps its last average and holds no value", () => {
    const only = enter(EMPTY_LAYER, 4, 50);
    expect(reverse(only.after, 4, only.amount).after).toEqual({ qty: 0, value: 0, avgCost: 50 });
  });

  it("refuses a non-finite quantity or amount", () => {
    expect(() => reverse(EMPTY_LAYER, Number.NaN, 0)).toThrow(CostError);
  });
});

const round = (n: number) => Math.round(n * 100) / 100;

describe("exitEstimateFits (Task 44, R44-6 as amended)", () => {
  it("an estimated exit fits only when the layer holds no units", () => {
    expect(exitEstimateFits({ qty: 0, value: 0, avgCost: null }, 3, 100)).toBe(true);
    expect(exitEstimateFits({ qty: -2, value: -200, avgCost: null }, 1, 100)).toBe(true);
  });

  it("does not fit when the layer holds units, whatever their value (units held at value 0 leave at 0)", () => {
    expect(exitEstimateFits({ qty: 5, value: 0, avgCost: null }, 5, 100)).toBe(false);
    expect(exitEstimateFits({ qty: 5, value: 0, avgCost: null }, 2, 100)).toBe(false);
    expect(exitEstimateFits({ qty: 5, value: 300, avgCost: null }, 3, 100)).toBe(false);
  });

  it("an exit at an estimate on an empty layer takes qty × cost and does not invent an average", () => {
    const layer = { qty: 0, value: 0, avgCost: null };
    expect(exit(layer, 3, 100)).toMatchObject({ unitCost: 100, amount: 300, after: { qty: -3, value: -300 } });
  });

  it("refuses a bad quantity or cost", () => {
    expect(() => exitEstimateFits(EMPTY_LAYER, 0, 1)).toThrow(CostError);
    expect(() => exitEstimateFits(EMPTY_LAYER, 1, -1)).toThrow(CostError);
  });
});
