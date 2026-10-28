import { describe, expect, it } from "vitest";
import { margin, productDraft, productInput, taxesOverridden, withCategory, withCategoryTaxes, type CategoryOption } from "../product-form-model";

// Category inheritance on the product form (design §5.18, prototype prSet / applyCategoryTax).

const cafe: CategoryOption = { id: "c1", name: "Café", ivaRate: "5", incRate: null, otherTaxes: [], defaultUom: "KGM", active: true };

describe("product form model", () => {
  it("a category hands down its taxes, and its unit to a new product only", () => {
    const fresh = withCategory(productDraft(null), cafe, true);
    expect(fresh).toMatchObject({ categoryId: "c1", ivaRate: "5", incRate: "", otherTaxes: [], uomCode: "KGM" });
    expect(taxesOverridden(fresh, cafe)).toBe(false);
    const stored = withCategory({ ...productDraft(null), uomCode: "94" }, cafe, false);
    expect(stored.uomCode).toBe("94");
  });

  it("changed taxes read as modified until reset to the category's", () => {
    const changed = { ...withCategory(productDraft(null), cafe, true), ivaRate: "19", otherTaxes: ["22"] };
    expect(taxesOverridden(changed, cafe)).toBe(true);
    expect(taxesOverridden(withCategoryTaxes(changed, cafe), cafe)).toBe(false);
  });

  it("builds the process input: empty codes left out, no INC as null, the cost only when visible", () => {
    const draft = { ...productDraft(null), sku: " CAF-500 ", description: "Café 500 g", listPrice: 31000, standardCost: 18000, minStock: "2,5" };
    expect(productInput(draft, { standardCostVisible: false })).toEqual({
      sku: "CAF-500",
      description: "Café 500 g",
      kind: "good",
      idScheme: "999",
      standardCode: "",
      brand: "",
      model: "",
      incRate: null,
      otherTaxes: [],
      listPrice: 31000,
      isFreeSample: false,
      trackStock: true,
      minStock: 2.5,
      categoryId: null,
      supplierId: null,
    });
    expect(productInput(draft, { standardCostVisible: true }).standardCost).toBe(18000);
    expect(margin(draft)).toBe(42);
  });
});
