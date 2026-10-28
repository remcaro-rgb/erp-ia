import type { CodeOption } from "./save-model";

// The product form's pure rules (prototype `openProductForm` / `prSet` / `prOtro` / `applyCategoryTax`, design §5.8b,
// §5.18): a category hands its taxes (and, for a new product, its unit) to the product; the product may change them,
// which the form shows as "modificados respecto a <categoría>" with a reset. The process decides `tax_override` and
// validates everything with the country pack.

export interface IdSchemeOption extends CodeOption {
  kind: "own" | "gtin" | "digits";
  length: number;
  standardCodeLabel: string;
}

/** The country pack's item tables, built by the page. */
export interface ProductTables {
  idSchemes: readonly IdSchemeOption[];
  uoms: readonly CodeOption[];
  ivaRates: readonly CodeOption[];
  incRates: readonly CodeOption[];
  otherTaxes: readonly CodeOption[];
  priceTypes: readonly CodeOption[];
  limits: { sku: number; description: number; brand: number; model: number };
}

/** A category the product may take, with the taxes it hands down. */
export interface CategoryOption {
  id: string;
  name: string;
  ivaRate: string;
  incRate: string | null;
  otherTaxes: string[];
  defaultUom: string | null;
  active: boolean;
}

export interface ProductDraft {
  sku: string;
  description: string;
  kind: "good" | "service";
  categoryId: string;
  idScheme: string;
  standardCode: string;
  brand: string;
  model: string;
  uomCode: string;
  ivaRate: string;
  incRate: string;
  otherTaxes: string[];
  listPrice: number | null;
  isFreeSample: boolean;
  referencePriceType: string;
  referencePrice: number | null;
  standardCost: number | null;
  trackStock: boolean;
  minStock: string;
  supplierId: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const amount = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export function productDraft(record: Record<string, unknown> | null): ProductDraft {
  return {
    sku: str(record?.sku),
    description: str(record?.description),
    kind: record?.kind === "service" ? "service" : "good",
    categoryId: str(record?.category_id),
    idScheme: str(record?.id_scheme) || "999",
    standardCode: str(record?.standard_code),
    brand: str(record?.brand),
    model: str(record?.model),
    uomCode: str(record?.uom_code),
    ivaRate: str(record?.iva_rate),
    incRate: str(record?.inc_rate),
    otherTaxes: Array.isArray(record?.other_taxes) ? (record.other_taxes as unknown[]).map(String) : [],
    listPrice: amount(record?.list_price),
    isFreeSample: record?.is_free_sample === true,
    referencePriceType: str(record?.reference_price_type),
    referencePrice: amount(record?.reference_price),
    standardCost: amount(record?.standard_cost),
    trackStock: record ? record.track_stock === true : true,
    minStock: str(record?.min_stock),
    supplierId: str(record?.supplier_id),
  };
}

/** The category's taxes on the product (prototype `applyCategoryTax`). */
export function withCategoryTaxes(draft: ProductDraft, category: CategoryOption): ProductDraft {
  return { ...draft, ivaRate: category.ivaRate, incRate: category.incRate ?? "", otherTaxes: [...category.otherTaxes] };
}

/** Choosing a category hands its taxes down, and its unit to a new product (prototype `prSet('categoriaId')`). */
export function withCategory(draft: ProductDraft, category: CategoryOption | null, isNew: boolean): ProductDraft {
  if (!category) return { ...draft, categoryId: "" };
  const next = withCategoryTaxes({ ...draft, categoryId: category.id }, category);
  return isNew && category.defaultUom ? { ...next, uomCode: category.defaultUom } : next;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Whether the product's taxes differ from its category's (what the process stores as `tax_override`). */
export function taxesOverridden(draft: ProductDraft, category: CategoryOption): boolean {
  return draft.ivaRate !== category.ivaRate || (draft.incRate || null) !== (category.incRate || null) || !sameSet(draft.otherTaxes, category.otherTaxes);
}

/** A new scheme clears the standard code; a service never tracks stock. */
export function setProductField<K extends keyof ProductDraft>(draft: ProductDraft, key: K, value: ProductDraft[K]): ProductDraft {
  const next = { ...draft, [key]: value };
  if (key === "idScheme") next.standardCode = "";
  if (key === "kind" && value === "service") next.trackStock = false;
  if (key === "isFreeSample" && value === false) {
    next.referencePriceType = "";
    next.referencePrice = null;
  }
  return next;
}

export function toggleOtherTax(draft: ProductDraft, code: string, on: boolean): ProductDraft {
  const rest = draft.otherTaxes.filter((c) => c !== code);
  return { ...draft, otherTaxes: on ? [...rest, code] : rest };
}

/** Margin over the list price, in whole percent, when both are known. */
export function margin(draft: Pick<ProductDraft, "listPrice" | "standardCost">): number | null {
  if (!draft.listPrice || !draft.standardCost || draft.listPrice <= 0 || draft.standardCost <= 0) return null;
  return Math.round((1 - draft.standardCost / draft.listPrice) * 100);
}

/**
 * The input of `core.product.create` / `core.product.update`. Optional codes left empty are left out (the process
 * keeps or inherits them); the standard cost goes only when the role sees it.
 */
export function productInput(draft: ProductDraft, options: { standardCostVisible: boolean }): Record<string, unknown> {
  const minStock = draft.minStock.trim() === "" ? undefined : Number(draft.minStock.replace(",", "."));
  return {
    sku: draft.sku.trim(),
    description: draft.description,
    kind: draft.kind,
    idScheme: draft.idScheme,
    standardCode: draft.standardCode,
    brand: draft.brand,
    model: draft.model,
    ...(draft.uomCode ? { uomCode: draft.uomCode } : {}),
    ...(draft.ivaRate ? { ivaRate: draft.ivaRate } : {}),
    incRate: draft.incRate || null,
    otherTaxes: draft.otherTaxes,
    listPrice: draft.listPrice ?? 0,
    isFreeSample: draft.isFreeSample,
    ...(draft.isFreeSample && draft.referencePriceType ? { referencePriceType: draft.referencePriceType } : {}),
    ...(draft.isFreeSample && draft.referencePrice !== null ? { referencePrice: draft.referencePrice } : {}),
    ...(options.standardCostVisible && draft.standardCost !== null ? { standardCost: draft.standardCost } : {}),
    trackStock: draft.kind === "service" ? false : draft.trackStock,
    ...(minStock !== undefined && Number.isFinite(minStock) ? { minStock } : {}),
    categoryId: draft.categoryId || null,
    supplierId: draft.supplierId || null,
  };
}

/** Whether the form may be sent: the identity fields are there and the minimum stock is a number. */
export function productBlocked(draft: ProductDraft): boolean {
  return draft.sku.trim() === "" || (draft.minStock.trim() !== "" && !/^\d+([.,]\d+)?$/.test(draft.minStock.trim()));
}
