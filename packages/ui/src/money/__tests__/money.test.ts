import { describe, expect, it } from "vitest";
import { formatMoney, moneyEditText, parseMoney } from "../format";

// Money as rule 23 and design §5.8a want it: `$ 1.234.567,00` (es-CO, two decimals), raw digits while editing.

describe("formatMoney", () => {
  it("formats pesos with dots for thousands, a comma and two decimals", () => {
    expect(formatMoney(1234567, "COP")).toBe("$ 1.234.567,00");
    expect(formatMoney(0.5)).toBe("$ 0,50");
    expect(formatMoney(0)).toBe("$ 0,00");
    expect(formatMoney(999.995)).toBe("$ 1.000,00");
    expect(formatMoney(-1500.4)).toBe("-$ 1.500,40");
  });

  it("accepts the numeric strings the database returns, and shows nothing for no value", () => {
    expect(formatMoney("1234567.8900")).toBe("$ 1.234.567,89");
    expect(formatMoney(null)).toBe("");
    expect(formatMoney(undefined)).toBe("");
    expect(formatMoney("")).toBe("");
    expect(formatMoney("abc")).toBe("");
    expect(formatMoney(Number.NaN)).toBe("");
  });

  it("names other currencies", () => {
    expect(formatMoney(10, "USD")).toBe("US$ 10,00");
    expect(formatMoney(10, "EUR")).toBe("€ 10,00");
    expect(formatMoney(10, "MXN")).toBe("MXN 10,00");
  });
});

describe("parseMoney and moneyEditText", () => {
  it("reads what a person types or pastes", () => {
    expect(parseMoney("$ 1.234.567,00")).toBe(1234567);
    expect(parseMoney("1234567,5")).toBe(1234567.5);
    expect(parseMoney("1.234.567")).toBe(1234567);
    expect(parseMoney("1234567")).toBe(1234567);
    expect(parseMoney("-2.000,25")).toBe(-2000.25);
    // A lone dot with one or two digits after it is a decimal point; three digits are thousands.
    expect(parseMoney("1.5")).toBe(1.5);
    expect(parseMoney("1.50")).toBe(1.5);
    expect(parseMoney("1.234")).toBe(1234);
    expect(parseMoney("1.234,50")).toBe(1234.5);
    expect(parseMoney("1.234.56")).toBe(123456);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("  ")).toBeNull();
    expect(parseMoney("doce")).toBeNull();
  });

  it("edits as raw digits with a decimal comma", () => {
    expect(moneyEditText(1234567)).toBe("1234567");
    expect(moneyEditText(1234567.5)).toBe("1234567,5");
    expect(moneyEditText(null)).toBe("");
    expect(parseMoney(moneyEditText(1234567.25))).toBe(1234567.25);
  });
});
