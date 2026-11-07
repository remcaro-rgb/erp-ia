import { describe, expect, it } from "vitest";
import { priceDateWarning } from "./price-date";

const text = (date: string) => `Los precios son del ${date}`;

describe("priceDateWarning", () => {
  it("is silent when the price date is today, absent or not readable", () => {
    expect(priceDateWarning("2026-11-06", "2026-11-06", text)).toBeNull();
    expect(priceDateWarning(new Date("2026-11-06T00:00:00Z"), "2026-11-06", text)).toBeNull();
    expect(priceDateWarning(null, "2026-11-06", text)).toBeNull();
    expect(priceDateWarning(undefined, "2026-11-06", text)).toBeNull();
    expect(priceDateWarning("no es fecha", "2026-11-06", text)).toBeNull();
  });
  it("names the price date when it is not today", () => {
    expect(priceDateWarning("2026-11-01", "2026-11-06", text)).toBe("Los precios son del 2026/11/01");
    expect(priceDateWarning(new Date("2026-10-31T00:00:00Z"), "2026-11-06", text)).toBe("Los precios son del 2026/10/31");
  });
});

describe("INVOICING_STEPS", () => {
  it("«Recalcular precios» runs invoicing.invoice.reprice on an invoice only", async () => {
    const { INVOICING_STEPS } = await import("./record");
    expect(INVOICING_STEPS["invoicing.invoice"]).toMatchObject({ reprice: "invoicing.invoice.reprice", issue: "invoicing.invoice.issue" });
    expect(INVOICING_STEPS["invoicing.note"]).not.toHaveProperty("reprice");
  });
});
