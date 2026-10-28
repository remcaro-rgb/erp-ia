// Tax inheritance from a product category (design §5.18). Pure: the product handlers load the
// category and the stored product, this decides the product's taxes and its tax_override flag.

export type Taxes = { ivaRate?: string; incRate: string | null; otherTaxes: string[] };

export interface TaxResolution {
  taxes: Taxes;
  /** True when the product's taxes differ from its category's. Always false without a category. */
  taxOverride: boolean;
}

/** Taxes given in the input; `incRate: null` explicitly means "no INC". */
export type ExplicitTaxes = { ivaRate?: string; incRate?: string | null; otherTaxes?: string[] };

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function sameTaxes(a: Taxes, b: Taxes): boolean {
  return a.ivaRate === b.ivaRate && a.incRate === b.incRate && sameSet(a.otherTaxes, b.otherTaxes);
}

function apply(base: Taxes, explicit: ExplicitTaxes): Taxes {
  return {
    ivaRate: explicit.ivaRate ?? base.ivaRate,
    incRate: explicit.incRate !== undefined ? explicit.incRate : base.incRate,
    otherTaxes: explicit.otherTaxes ?? base.otherTaxes,
  };
}

/**
 * - New product: starts from the category's taxes (or none) and applies the explicit ones.
 * - Existing product, same category, nothing explicit: unchanged (category edits never rewrite products).
 * - Existing product, category changed, nothing explicit: re-inherits the new category's taxes.
 * - Explicit taxes: applied over the category's (on a category change) or the stored ones.
 * The override flag compares the result with the category.
 */
export function resolveTaxes(args: {
  explicit: ExplicitTaxes;
  category: Taxes | null;
  current?: TaxResolution;
  categoryChanged: boolean;
}): TaxResolution {
  const { explicit, category, current, categoryChanged } = args;
  const hasExplicit = explicit.ivaRate !== undefined || explicit.incRate !== undefined || explicit.otherTaxes !== undefined;
  if (!category) {
    const base = current?.taxes ?? { incRate: null, otherTaxes: [] };
    return { taxes: apply(base, explicit), taxOverride: false };
  }
  if (current && !categoryChanged && !hasExplicit) return current;
  const base = current && !categoryChanged ? current.taxes : category;
  const taxes = apply(base, explicit);
  return { taxes, taxOverride: !sameTaxes(taxes, category) };
}
