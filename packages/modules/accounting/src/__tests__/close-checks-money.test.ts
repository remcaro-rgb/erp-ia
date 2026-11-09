import { describe, expect, it } from "vitest";
import { money } from "../processes/close-checks";

// Task 34.2 (item 129): the close checks' notes print company amounts as rule 23 wants, with the sign first.

describe("close-checks money", () => {
  it("COP as $ 1.234.567,00, the sign before the symbol, another currency by its ISO code", () => {
    expect(money(1234567)).toBe("$ 1.234.567,00");
    expect(money(-1000)).toBe("-$ 1.000,00");
    expect(money(12500, "USD")).toBe("USD 12.500,00");
  });
});
