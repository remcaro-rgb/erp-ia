import { describe, expect, it } from "vitest";
import { cellText, moneyText, rateText } from "../format";
import type { ExportColumn } from "../types";

// Task 34.2 (FX design §10, owner item 129, extends rule 23): money text names its currency; rates print up to six decimals.

describe("moneyText", () => {
  it("COP is $ 1.234.567,00; any other currency its ISO code", () => {
    expect(moneyText(1234567)).toBe("$ 1.234.567,00");
    expect(moneyText(1234567, "COP")).toBe("$ 1.234.567,00");
    expect(moneyText(12500, "USD")).toBe("USD 12.500,00");
    expect(moneyText(980.5, "EUR")).toBe("EUR 980,50");
  });

  it("puts the minus sign first, as today", () => {
    expect(moneyText(-1000)).toBe("-$ 1.000,00");
    expect(moneyText(-1000, "USD")).toBe("-USD 1.000,00");
    expect(moneyText(-0.001, "USD")).toBe("USD 0,00");
  });
});

describe("rateText", () => {
  it("prints up to six decimals with es-CO separators, trailing zeros dropped down to two", () => {
    expect(rateText(4123.45)).toBe("4.123,45");
    expect(rateText(4123.456789)).toBe("4.123,456789");
    expect(rateText(4123)).toBe("4.123,00");
    expect(rateText(4123.4)).toBe("4.123,40");
    expect(rateText(1.0000004)).toBe("1,00");
    expect(rateText(0.000251)).toBe("0,000251");
  });
});

describe("cellText on paper with a currency", () => {
  const column: ExportColumn = { field: "total", label: "Total", type: "money" };
  it("prints the currency's code for a USD value and $ for COP", () => {
    expect(cellText(column, "12500.0000", { paper: true, currency: "USD" })).toBe("USD 12.500,00");
    expect(cellText(column, "12500.0000", { paper: true })).toBe("$ 12.500,00");
  });
});
