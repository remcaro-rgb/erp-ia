import { describe, expect, it } from "vitest";
import { gridEntities, gridHref } from "./hrefs";

describe("gridHref", () => {
  it("names the grid screen of the entities that have one", () => {
    expect(gridHref("core.party")).toBe("/parties");
    expect(gridHref("core.product_category")).toBe("/categories");
    expect(gridHref("accounting.ledger_line")).toBe("/accounting/movements");
    expect(gridHref("accounting.entry")).toBe("/accounting/entries");
  });
  it("is undefined for the rest, inherited keys included", () => {
    expect(gridHref("sales.invoice")).toBeUndefined();
    expect(gridHref("toString")).toBeUndefined();
    expect(gridEntities()).toEqual(["core.party", "core.product", "core.product_category", "accounting.entry", "accounting.ledger_line"]);
  });
});
