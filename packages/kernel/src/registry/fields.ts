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
