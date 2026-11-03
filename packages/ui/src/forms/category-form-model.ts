// The category form's pure rules (prototype `openCategoryForm` / `catCheck` / `renderCategoryForm`, design §5.18):
// a master with the taxes and unit new products inherit. The process refuses a duplicate name.

export interface CategoryDraft {
  name: string;
  /** Activo (`is_active`); the record's `status` is its lifecycle state (entity types, migration 0042). */
  isActive: boolean;
  ivaRate: string;
  incRate: string;
  otherTaxes: string[];
  defaultUom: string;
  incomeAccount: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function categoryDraft(record: Record<string, unknown> | null, defaultIva: string): CategoryDraft {
  return {
    name: str(record?.name),
    isActive: record?.is_active !== false,
    ivaRate: str(record?.iva_rate) || defaultIva,
    incRate: str(record?.inc_rate),
    otherTaxes: Array.isArray(record?.other_taxes) ? (record.other_taxes as unknown[]).map(String) : [],
    defaultUom: str(record?.default_uom),
    incomeAccount: str(record?.income_account),
  };
}

/** The prototype's checks: a PUC income account has 4 to 8 digits. */
export const incomeAccountProblem = (draft: Pick<CategoryDraft, "incomeAccount">): boolean => draft.incomeAccount !== "" && !/^\d{4,8}$/.test(draft.incomeAccount);

/** The name is still missing. */
export const nameMissing = (draft: Pick<CategoryDraft, "name">): boolean => draft.name.trim() === "";

/** The input of `core.category.create` / `core.category.update` ("" clears an optional code). */
export function categoryInput(draft: CategoryDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    isActive: draft.isActive,
    ivaRate: draft.ivaRate,
    incRate: draft.incRate || null,
    otherTaxes: draft.otherTaxes,
    defaultUom: draft.defaultUom,
    incomeAccount: draft.incomeAccount,
  };
}
