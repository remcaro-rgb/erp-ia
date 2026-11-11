import { describe, expect, it } from "vitest";
import { formatMoney } from "../format";

// Task 34.2 (FX design §10, owner item 129, extends rule 23): COP keeps `$ 1.234.567,00`; any other currency prints its
// ISO code, a space and the same es-CO digits.

describe("formatMoney with the currency (item 129)", () => {
  it("prints the ISO code of a currency other than COP", () => {
    expect(formatMoney(12500, "USD")).toBe("USD 12.500,00");
    expect(formatMoney(980.5, "EUR")).toBe("EUR 980,50");
  });

  it("keeps COP as $ 1.234.567,00", () => {
    expect(formatMoney(1234567, "COP")).toBe("$ 1.234.567,00");
  });

  it("puts the minus sign first, as today", () => {
    expect(formatMoney(-1000, "COP")).toBe("-$ 1.000,00");
    expect(formatMoney(-1000, "USD")).toBe("-USD 1.000,00");
  });

  it("prints the code, never $, when the company currency is not COP", () => {
    expect(formatMoney(1000, "COP", "USD")).toBe("COP 1.000,00");
    expect(formatMoney(1000, "USD", "USD")).toBe("USD 1.000,00");
  });
});
