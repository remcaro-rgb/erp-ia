import { describe, expect, it } from "vitest";
import { kpiGridHref } from "../links";
import { kpiSchema } from "../kpis";

// UX-OD-7 (T13, owner 2026-10-31): a card leads to the grid that holds its work, with the card's filter in the `q` parameter the grids read.
describe("kpiGridHref", () => {
  it("a plain path stays plain; a filter goes in q, encoded once", () => {
    expect(kpiGridHref("/accounting/posting")).toBe("/accounting/posting");
    const href = kpiGridHref("/accounting/entries", [{ field: "status", op: "eq", value: "draft" }]);
    const q = new URL(href, "http://x").searchParams.get("q");
    expect(JSON.parse(q!)).toEqual({ filters: [{ field: "status", op: "eq", value: "draft" }], sort: [] });
    expect(href).not.toContain("%25");
  });
});

describe("kpiSchema href", () => {
  const base = { id: "a.b", label: "k", value: 1, unit: "count" as const };
  it("keeps an internal href and refuses an external or protocol-relative one", () => {
    expect(kpiSchema.parse({ ...base, href: "/parties" }).href).toBe("/parties");
    expect(() => kpiSchema.parse({ ...base, href: "https://evil.example" })).toThrow();
    expect(() => kpiSchema.parse({ ...base, href: "//evil.example" })).toThrow();
  });
});
