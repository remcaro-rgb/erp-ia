import { validateEmail } from "../validation";
import { roleIn } from "./visibility";
import type { CustomFieldCaller, CustomFieldDef, CustomFieldsResult, ExtraData } from "./types";

// Validation of the admin-defined fields of a record (design §5.14). The messages are the prototype's
// (`cfErr`), in Spanish (es-419), and the same function runs in the processes and in the form.

/** No value: absent, null or only spaces. */
export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

const NUMBER = /^-?\d+([.,]\d+)?$/;
const URL = /^https?:\/\/[^\s]+\.[^\s]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Why `value` does not fit the definition's type, length and options, or null. An empty value always fits (required is `missing`, not an error). */
export function validateCustomValue(def: CustomFieldDef, value: unknown): string | null {
  if (isEmptyValue(value)) return null;
  if (def.type === "bool") return value === true || value === false || value === "Sí" || value === "No" ? null : "Debe ser Sí o No";
  if (def.type === "number") {
    const ok = typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && NUMBER.test(value.trim());
    if (!ok) return "Debe ser un número";
  } else if (typeof value !== "string") {
    return "Debe ser texto";
  }
  const text = String(value);
  if (def.maxLength !== null && text.length > def.maxLength) return `Máximo ${def.maxLength} caracteres`;
  switch (def.type) {
    case "date":
      return isCalendarDate(text) ? null : "Fecha AAAA-MM-DD";
    case "url":
      return URL.test(text) ? null : "URL con http(s)://";
    case "email":
      return validateEmail(text) === null ? null : "Correo inválido";
    case "list":
      return def.options?.includes(text) ? null : "Elige un valor de la lista";
    default:
      return null;
  }
}

const same = (a: unknown, b: unknown): boolean => (isEmptyValue(a) && isEmptyValue(b)) || String(a ?? "").trim() === String(b ?? "").trim();

/**
 * Checks `extra` (the whole record's custom data after the write) against the company's definitions.
 *
 * - `errors` (block the save): a changed value that does not fit its type, length or options; a changed
 *   value for a key nobody defined; a changed value the caller's roles may not enter (the field was
 *   empty) or edit (it had a value). Errors read "<label>: <reason>".
 * - `missing` (the labels of required fields with no value) counts as missing data, never as an error:
 *   a field made required after records exist marks them, it does not break their next update.
 *
 * `previous` is what the record held before; values that did not change are not re-checked (they were
 * accepted once, or predate the definition) and need no role. Without it every value counts as new.
 */
export function validateCustomFields(
  defs: readonly CustomFieldDef[],
  extra: ExtraData | null | undefined,
  caller: CustomFieldCaller,
  previous: ExtraData | null | undefined = {},
): CustomFieldsResult {
  const current = extra ?? {};
  const before = previous ?? {};
  const errors: string[] = [];
  const missing: string[] = [];
  for (const def of defs) {
    const value = current[def.key];
    if (def.required && isEmptyValue(value)) missing.push(def.label);
    if (same(value, before[def.key])) continue;
    const problem = validateCustomValue(def, value);
    if (problem) errors.push(`${def.label}: ${problem}`);
    else if (!roleIn(caller, isEmptyValue(before[def.key]) ? def.rolesEnter : def.rolesEdit)) {
      errors.push(`${def.label}: tu rol no puede modificar este dato`);
    }
  }
  const defined = new Set(defs.map((def) => def.key));
  for (const key of Object.keys(current)) {
    if (!defined.has(key) && !same(current[key], before[key])) errors.push(`${key}: dato adicional no definido`);
  }
  return { errors, missing };
}
