import { describe, expect, it } from "vitest";
import { accounting } from "@erp/module-accounting";
import { flattenNav } from "@erp/kernel";
import { hasOptionalMasters, hideOptionalMasters } from "./nav";

const ids = (nav: ReturnType<typeof hideOptionalMasters>) => flattenNav(nav).map((i) => i.id);

describe("optional masters in the menu", () => {
  it("with the three settings off, Maestros keeps the chart, the cost centers and the fuentes; each setting brings its master back", () => {
    expect(hasOptionalMasters(accounting.navigation)).toBe(true);
    const off = ids(hideOptionalMasters(accounting.navigation, { openAuxiliaries: false, items: false, businessUnits: false }));
    expect(off).toEqual(expect.arrayContaining(["accounting.accounts", "accounting.cost_centers", "accounting.journals"]));
    expect(off.filter((id) => ["accounting.open_auxiliaries", "accounting.items", "accounting.business_units"].includes(id))).toEqual([]);

    const items = ids(hideOptionalMasters(accounting.navigation, { openAuxiliaries: false, items: true, businessUnits: false }));
    expect(items).toContain("accounting.items");
    expect(items).not.toContain("accounting.business_units");
    expect(ids(hideOptionalMasters(accounting.navigation, { openAuxiliaries: true, items: true, businessUnits: true }))).toEqual(ids(accounting.navigation));
  });

  it("the six items of the bar stay in order", () => {
    const bar = hideOptionalMasters(accounting.navigation, { openAuxiliaries: false, items: false, businessUnits: false }).map((i) => i.id);
    expect(bar).toEqual(["accounting.entries", "accounting.movements", "accounting.masters", "accounting.periods", "accounting.reports", "accounting.posting"]);
  });
});
