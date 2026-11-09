import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureRateFeed, type RateFeed } from "@erp/infra";
import { co } from "../index";
import { exchangeRates, parseTrmRow, trmUrl, TRM_DATASET } from "../exchange-rates";

// The Colombian official rate (plan 2B.2 Task 34.1, FX §2): the Superfinanciera TRM from the datos.gov.co dataset 32sa-8pi3 (fields
// valor, vigenciadesde, vigenciahasta), USD only. The fetch goes through the infra RateFeed; tests read the fixture files (RATE_FEED=fixture).

const FIXTURES = fileURLToPath(new URL("../__fixtures__/trm/", import.meta.url));

describe("co exchange rates", () => {
  it("the pack declares USD as its only official currency", () => {
    expect(co.exchangeRates).toBe(exchangeRates);
    expect(exchangeRates.officialCurrencies).toEqual(["USD"]);
  });

  it("the TRM query names dataset 32sa-8pi3 and the date's validity", () => {
    const url = trmUrl("2026-11-07");
    expect(TRM_DATASET).toBe("32sa-8pi3");
    expect(url.startsWith("https://www.datos.gov.co/resource/32sa-8pi3.json?")).toBe(true);
    expect(decodeURIComponent(url)).toContain("vigenciadesde <= '2026-11-07T00:00:00.000'");
    expect(decodeURIComponent(url)).toContain("vigenciahasta >= '2026-11-07T00:00:00.000'");
  });

  it("parses a dataset row into the rate and its validity range", () => {
    expect(parseTrmRow({ valor: "4123.45", unidad: "COP", vigenciadesde: "2026-11-07T00:00:00.000", vigenciahasta: "2026-11-09T00:00:00.000" })).toEqual({
      rate: 4123.45,
      validFrom: "2026-11-07",
      validTo: "2026-11-09",
    });
    expect(() => parseTrmRow({ valor: "x", vigenciadesde: "2026-11-07T00:00:00.000", vigenciahasta: "2026-11-09T00:00:00.000" })).toThrow();
    expect(() => parseTrmRow({ valor: "4123.45", vigenciadesde: "2026-11-09T00:00:00.000", vigenciahasta: "2026-11-07T00:00:00.000" })).toThrow();
  });

  it("reads the TRM published on Friday 2026-11-06 (valid Saturday to Monday) from the fixture", async () => {
    expect(await exchangeRates.officialRate("USD", "2026-11-07", fixtureRateFeed(FIXTURES))).toEqual({ rate: 4123.45, validFrom: "2026-11-07", validTo: "2026-11-09" });
  });

  it("answers null for EUR without calling the feed, and null when the dataset has no row for the date", async () => {
    const calls: string[] = [];
    const feed: RateFeed = { getJson: async (url) => (calls.push(url), []) };
    expect(await exchangeRates.officialRate("EUR", "2026-11-07", feed)).toBeNull();
    expect(calls).toEqual([]);
    expect(await exchangeRates.officialRate("USD", "2026-11-07", feed)).toBeNull();
    expect(calls).toEqual([trmUrl("2026-11-07")]);
  });

  it("a feed failure or a malformed answer is thrown, not taken for «no rate»", async () => {
    await expect(exchangeRates.officialRate("USD", "2026-11-12", fixtureRateFeed(FIXTURES))).rejects.toThrow();
    await expect(exchangeRates.officialRate("USD", "2026-11-07", { getJson: async () => ({ error: true }) })).rejects.toThrow();
  });
});
