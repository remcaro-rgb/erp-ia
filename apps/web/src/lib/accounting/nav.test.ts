import { describe, expect, it } from "vitest";
import { accounting } from "@erp/module-accounting";
import { flattenNav } from "@erp/kernel";
import { hasOptionalMasters, hasPostingItem, hideOptionalMasters, withPostingBadge } from "./nav";

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

  it("the four sections of the bar stay in order; a section left with no item stays (its empty state)", () => {
    const bar = hideOptionalMasters(accounting.navigation, { openAuxiliaries: false, items: false, businessUnits: false }).map((i) => i.id);
    expect(bar).toEqual(["accounting.maestros", "accounting.documentos", "accounting.reportes", "accounting.parametros"]);
    const onlyOptional = accounting.navigation.map((i) => (i.id === "accounting.maestros" ? { ...i, children: i.children!.filter((c) => c.id === "accounting.items") } : i));
    const emptied = hideOptionalMasters(onlyOptional, { openAuxiliaries: false, items: false, businessUnits: false });
    expect(emptied.find((i) => i.id === "accounting.maestros")?.children).toEqual([]);
  });
});

describe("pending postings badge", () => {
  it("sits on Reglas contables only, and only while something is pending", () => {
    expect(hasPostingItem(accounting.navigation)).toBe(true);
    const badged = withPostingBadge(accounting.navigation, 3);
    expect(flattenNav(badged).filter((i) => i.badge !== undefined).map((i) => [i.id, i.badge])).toEqual([["accounting.posting", 3]]);
    expect(flattenNav(withPostingBadge(accounting.navigation, 0)).some((i) => i.badge !== undefined)).toBe(false);
  });
});
