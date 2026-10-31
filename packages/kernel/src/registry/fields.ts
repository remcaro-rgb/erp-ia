import type { CodeTable } from "../localization/country-pack";

export type FieldType =
  | "text"
  | "number"
  | "money"
  | "date"
  | "datetime"
  | "boolean"
  | "enum"
  | "uuid"
  | "json"
  | "ref";

export interface FieldDef {
  name: string;
  type: FieldType;
  /** i18n key. */
  label: string;
  required?: boolean;
  /** Required when `type` is `enum`. */
  enumValues?: string[];
  /** Required when `type` is `ref`: the target entity id and the field of it to display. */
  ref?: { entity: string; display: string };
  sensitivity?: "normal" | "confidential";
  /** Default true. */
  sortable?: boolean;
  /** Default true. */
  filterable?: boolean;
  /** Default true. */
  exportable?: boolean;
  /** Default false; searchable fields feed the entity lookup (magnifier). */
  searchable?: boolean;
  /** i18n key prefix of the labels of the field's values (`grid.values.party_kind` → `.customer`). */
  valuesKey?: string;
  /** The field holds a code of this country-pack table: its label comes from the pack (`CountryPack.codeLabel`). */
  codes?: CodeTable;
  /**
   * The masked view computes this column from this SQL expression instead of reading a stored column (a figure for the
   * period a grid param names, `accounting.period_figure`). The field is read-only: no create process takes it, and a
   * clone leaves it empty (list it in `cloneReset`). Declare it after the entity's stored fields so that a view can gain it
   * with `create or replace view`.
   */
  viewExpr?: string;
  /**
   * The value of a row already includes its descendants (`accounting.period_figure` on the hierarchical masters; the entity
   * has a `parent_id`). Its total is the sum over the rows with no ancestor in the result, never a generic sum (design §22.21).
   */
  rollup?: boolean;
  /** How this field reads when it is the display field of a record: `month` → `YYYY-MM` (a period named by its start). */
  displayFormat?: "month";
}

/** A field with every default applied. */
export type ResolvedFieldDef = FieldDef &
  Required<Pick<FieldDef, "required" | "sensitivity" | "sortable" | "filterable" | "exportable" | "searchable">>;

/** SQL identifier shape every schema, table and column name must have (they are emitted unquoted in views). */
export const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
/** Entity id: `<module>.<name>`, lowercase. */
export const ENTITY_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Validates one field of entity `entityId` and returns it with the defaults applied. */
export function resolveField(entityId: string, field: FieldDef): ResolvedFieldDef {
  const where = `entity ${entityId}, field ${field.name}`;
  if (!IDENTIFIER.test(field.name)) throw new Error(`${where}: invalid field name`);
  if (field.type === "enum" && !field.enumValues?.length) {
    throw new Error(`${where}: enum fields need enumValues`);
  }
  if (field.type !== "enum" && field.enumValues) {
    throw new Error(`${where}: enumValues only applies to enum fields`);
  }
  if (field.type === "ref") {
    if (!field.ref) throw new Error(`${where}: ref fields need ref`);
    if (!ENTITY_ID.test(field.ref.entity)) throw new Error(`${where}: ref.entity "${field.ref.entity}" is not an entity id`);
    if (!IDENTIFIER.test(field.ref.display)) throw new Error(`${where}: invalid ref.display`);
  } else if (field.ref) {
    throw new Error(`${where}: ref only applies to ref fields`);
  }
  return {
    ...field,
    required: field.required ?? false,
    sensitivity: field.sensitivity ?? "normal",
    sortable: field.sortable ?? true,
    filterable: field.filterable ?? true,
    exportable: field.exportable ?? true,
    searchable: field.searchable ?? false,
  };
}
