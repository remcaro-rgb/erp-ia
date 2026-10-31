import { describe, expect, it, vi } from "vitest";
import { paramsFromSearch, paramsToSearch, quickRanges, hasDateRange, reportFetcher } from "../report-model";
import type { ParamSpec } from "../report-model";

describe("report-model", () => {
  it("params round-trip through the URL", () => {
    expect(paramsFromSearch(paramsToSearch({ from: "2026-10-01", level: 4 }))).toEqual({ from: "2026-10-01", level: 4 });
    expect(paramsFromSearch(`?${paramsToSearch({ posted: true, account: "x y&z" })}`)).toEqual({ posted: true, account: "x y&z" });
  });

  it("leaves unset params out of the URL and reads garbage as no params", () => {
    expect(paramsToSearch({})).toBe("");
    expect(paramsFromSearch("")).toEqual({});
    expect(paramsFromSearch("p=%7Bnot-json")).toEqual({});
    expect(paramsFromSearch("p=%5B1%5D")).toEqual({});
  });

  it("offers quick ranges only when the schema has from and to dates", () => {
    const date = (name: string): ParamSpec => ({ name, label: name, type: "date" });
    expect(hasDateRange([date("from"), date("to")])).toBe(true);
    expect(hasDateRange([date("from")])).toBe(false);
    expect(hasDateRange([{ name: "from", label: "f", type: "text" }, date("to")])).toBe(false);
  });

  it("computes Hoy, Este período and Este año", () => {
    const ranges = quickRanges("2026-10-30", { from: "2026-10-01", to: "2026-10-31" });
    expect(ranges).toEqual({ today: { from: "2026-10-30", to: "2026-10-30" }, period: { from: "2026-10-01", to: "2026-10-31" }, year: { from: "2026-01-01", to: "2026-12-31" } });
    expect(quickRanges("2026-02-10").period).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("reportFetcher keeps the details of a 403", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "forbidden", details: ["Sin acceso"] }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(reportFetcher("accounting.account_detail", {})({ page: 1, pageSize: 10, sort: [], filters: [] } as never)).rejects.toMatchObject({ code: "forbidden", status: 403, details: ["Sin acceso"] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
