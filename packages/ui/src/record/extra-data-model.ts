// Types, default copy and pure rules of the "Datos adicionales" tab (design §5.14). The validation is the
// kernel's own (`@erp/kernel/custom-fields`, dependency-free), so the form and the process agree.

import { isEmptyValue, validateCustomValue, type CustomFieldType } from "@erp/kernel/custom-fields";

/** A custom field as `kernel.custom_field.list` returns it to a form: the definition plus what the caller's roles may do. */
export interface ExtraFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  maxLength: number | null;
  required: boolean;
  options: readonly string[] | null;
  canEnter: boolean;
  canEdit: boolean;
  canView: boolean;
}

/** A free name / value pair (`extra_free`). */
export interface FreeItem {
  name: string;
  value: string;
}

/** What the tab reports on every change: the whole documents, ready for the update process. */
export interface ExtraDataValue {
  extra: Record<string, unknown>;
  extraFree: FreeItem[];
}

export interface ExtraDataLabels {
  definedTitle: string;
  definedHint: string;
  noDefs: string;
  freeTitle: string;
  freeHint: string;
  noFree: string;
  name: string;
  value: string;
  add: string;
  remove: string;
  required: string;
  readOnlyForRole: string;
  hiddenTitle: string;
  none: string;
  yes: string;
  no: string;
  types: Record<CustomFieldType, string>;
  maxLength: (n: number) => string;
}

/** Spanish (es-419) until Task 11 wires packages/i18n; every string can be replaced through the `labels` prop. */
export const DEFAULT_EXTRA_LABELS: ExtraDataLabels = {
  definedTitle: "Definidos por el administrador",
  definedHint: "Administración › Datos adicionales",
  noDefs: "El administrador no ha definido datos adicionales para esta entidad.",
  freeTitle: "Datos libres",
  freeHint: "nombre y valor que cualquier usuario puede agregar",
  noFree: "Sin datos libres.",
  name: "Nombre",
  value: "Valor",
  add: "+ Agregar dato",
  remove: "Quitar",
  required: "obligatorio",
  readOnlyForRole: "solo lectura para tu rol",
  hiddenTitle: "Tu rol no puede ver este dato",
  none: "—",
  yes: "Sí",
  no: "No",
  types: { text: "Texto", number: "Número", date: "Fecha", bool: "Sí / No", list: "Lista", url: "URL", email: "Correo" },
  maxLength: (n) => `máx. ${n}`,
};

/** Placeholder a masked field shows instead of its value. */
export const MASK = "••••••";

/** Why the value does not fit the definition, or null (an empty value always fits: required is pending, not an error). */
export function fieldProblem(def: ExtraFieldDef, value: unknown): string | null {
  return validateCustomValue({ ...def, rolesEnter: [], rolesEdit: [], rolesView: [] }, value);
}

/** Whether the caller may change the field: an empty one needs the enter right, a filled one the edit right. */
export const canWrite = (def: ExtraFieldDef, value: unknown, readOnly: boolean): boolean =>
  !readOnly && def.canView && (isEmptyValue(value) ? def.canEnter : def.canEdit);

/** `extra` with `key` set to `value`; an empty value removes the key. */
export function withValue(extra: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const { [key]: _removed, ...rest } = extra;
  void _removed;
  return isEmptyValue(value) ? rest : { ...rest, [key]: value };
}

/** The select value of a bool: stored as true / false, shown as Sí / No. */
export const boolText = (value: unknown, labels: Pick<ExtraDataLabels, "yes" | "no">): string =>
  value === true || value === "Sí" ? labels.yes : value === false || value === "No" ? labels.no : "";

/** The tab badge: how many items it holds and how many of the caller's visible fields are pending (invalid or required and empty). */
export function extraTabCounts(defs: readonly ExtraFieldDef[], extra: Record<string, unknown>, extraFree: readonly FreeItem[]): { count: number; warn: number } {
  const warn = defs.filter((def) => def.canView && (fieldProblem(def, extra[def.key]) !== null || (def.required && isEmptyValue(extra[def.key])))).length;
  return { count: defs.length + extraFree.length, warn };
}
