// Shapes of the admin's custom fields (design §5.14), dependency-free so the browser can import them.

export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "bool", "list", "url", "email"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** One row of `kernel.custom_fields`, as the validators read it. Roles are `kernel.roles` ids. */
export interface CustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  /** Longest accepted value in characters; null for no limit. */
  maxLength: number | null;
  required: boolean;
  /** The allowed values of a `list` field. */
  options: readonly string[] | null;
  /** Roles that may fill the field while it is empty. */
  rolesEnter: readonly string[];
  /** Roles that may change a value that is already there. */
  rolesEdit: readonly string[];
  /** Roles that receive the value in consults. */
  rolesView: readonly string[];
}

/** Who is asking: the ids of the caller's roles in the active company. */
export interface CustomFieldCaller {
  roleIds: readonly string[];
}

/** `extra` of a record: custom field key -> value. */
export type ExtraData = Record<string, unknown>;

/** What `validateCustomFields` finds. `errors` block the save; `missing` (labels) count as missing data. */
export interface CustomFieldsResult {
  errors: string[];
  missing: string[];
}

/** Prefix of a missing custom field in `dian_missing` ("Dato adicional: Origen del café"); migration 0010 recomputes entries carrying it. */
export const CUSTOM_MISSING_PREFIX = "Dato adicional: ";
