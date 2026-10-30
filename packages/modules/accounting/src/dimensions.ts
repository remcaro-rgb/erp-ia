// The four analytic dimensions (design §4.5): one shape, four masters. Used by the entry validation, the process factory
// (Task 15), the reports and the settings that hide the three optional ones.

export const DIMENSIONS = ["cost_center", "open_auxiliary", "item", "business_unit"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface DimensionDef {
  dimension: Dimension;
  /** Entity id, `accounting.<dimension>`. */
  entity: string;
  /** Table in schema `accounting`. */
  table: string;
  /** Column on lines, templates and rules referencing a node. */
  column: string;
  /** Account flag that makes the dimension mandatory on a line (§4.1). */
  requiresFlag: string;
  /** `settings` column that turns the dimension on; the cost center is always on. */
  settingsFlag: string | null;
  /** Spanish noun for refusals; the UI copy goes through the catalogue. */
  noun: string;
}

export const DIMENSION_DEFS: Record<Dimension, DimensionDef> = {
  cost_center: { dimension: "cost_center", entity: "accounting.cost_center", table: "cost_centers", column: "cost_center_id", requiresFlag: "requires_cost_center", settingsFlag: null, noun: "centro de costo" },
  open_auxiliary: { dimension: "open_auxiliary", entity: "accounting.open_auxiliary", table: "open_auxiliaries", column: "open_auxiliary_id", requiresFlag: "requires_open_auxiliary", settingsFlag: "use_open_auxiliaries", noun: "auxiliar abierto" },
  item: { dimension: "item", entity: "accounting.item", table: "items", column: "item_id", requiresFlag: "requires_item", settingsFlag: "use_items", noun: "ítem" },
  business_unit: { dimension: "business_unit", entity: "accounting.business_unit", table: "business_units", column: "business_unit_id", requiresFlag: "requires_business_unit", settingsFlag: "use_business_units", noun: "unidad de negocio" },
};
