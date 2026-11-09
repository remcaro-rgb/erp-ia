import { describe, expect, it } from "vitest";
import { rateWarning } from "./rate-warning";

// The record's chip of R34-8 (Task 34.4, owner item 123): «La tasa difiere de la TRM del día (4.123,45)» on an issued foreign-currency
// invoice whose frozen rate is more than 0,005 % off the TRM of its issue date. Never a refusal; silent when anything is unknown.
const text = (trm: string) => `La tasa difiere de la TRM del día (${trm})`;

describe("rateWarning", () => {
  it("names the TRM when the invoice's rate is more than 0,005 % off it", () => {
    expect(rateWarning("4164.68", 4123.45, text)).toBe("La tasa difiere de la TRM del día (4.123,45)");
    expect(rateWarning(4000, 4123.45, text)).toBe("La tasa difiere de la TRM del día (4.123,45)");
  });
  it("is silent at the TRM, within the tolerance, without a TRM or a readable rate", () => {
    expect(rateWarning("4123.45", 4123.45, text)).toBeNull();
    expect(rateWarning("4123.65", 4123.45, text)).toBeNull();
    expect(rateWarning("4164.68", null, text)).toBeNull();
    expect(rateWarning(null, 4123.45, text)).toBeNull();
    expect(rateWarning("••••", 4123.45, text)).toBeNull();
  });
});
