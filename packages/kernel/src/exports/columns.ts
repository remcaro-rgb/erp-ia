import type { CustomFieldType } from "../custom-fields/types";
import type { EntityDef } from "../registry/entities";
import type { FieldType } from "../registry/fields";
import { QueryError } from "../query/errors";
import { EXTRA_PREFIX } from "../query/grid-state";
import type { GridAccess } from "../query/run";
import type { ExportColumn, ExportType } from "./types";

// Which columns an export has (rules 14 and 20): exactly the ones the grid shows the caller, in the order of the grid
// state — visible ones as they are, masked ones flagged (they print `••••••`), hidden ones left out. What the caller
// may see is decided here from the server's own access check, never from the client's idea of its columns.

/** What the caller's screen calls things: headers and value labels. Cosmetic only, it never widens access. */
export interface ExportPresentation {
  /** Header by field (`legal_name` → "Razón social"); the field name when absent. */
  labels?: Record<string, string>;
  /** Value labels by field (`kind` → { customer: "Cliente" }). */
  values?: Record<string, Record<string, string>>;
}

const TYPE: Record<FieldType, ExportType> = {
  text: "text",
  number: "number",
  money: "money",
  date: "date",
  datetime: "datetime",
  boolean: "boolean",
  enum: "enum",
  uuid: "text",
  ref: "text",
  json: "json",
};

const CUSTOM_TYPE: Record<CustomFieldType, ExportType> = {
  text: "text",
  url: "text",
  email: "text",
  number: "number",
  date: "date",
  bool: "boolean",
  list: "enum",
};

/** Raw JSON documents (`extra`, `extra_free`) are not columns: their values come as `extra.<key>`. */
const RAW_JSON = new Set(["extra", "extra_free"]);

/**
 * The export columns of `entity` for a caller with `access`, from the grid state's column list (every visible field
 * and admin-defined value when the state names none). The technical `id` is never a column. Throws `QueryError`
 * (`unknown_field`) for a field the entity does not have.
 */
export function exportColumns(entity: EntityDef, access: GridAccess, state: { columns?: string[] }, presentation: ExportPresentation = {}): ExportColumn[] {
  const fields = new Map(entity.fields.map((f) => [f.name, f]));
  const extraShown = (access.modes.extra ?? "visible") === "visible";
  const extras = access.extras.filter((e) => e.viewable);
  const label = (field: string, fallback: string) => presentation.labels?.[field] ?? fallback;

  const registryColumn = (name: string): ExportColumn | null => {
    const field = fields.get(name)!;
    const mode = access.modes[name] ?? "visible";
    if (mode === "hidden" || field.exportable === false) return null;
    const options = presentation.values?.[name];
    return {
      field: name,
      label: label(name, name),
      type: TYPE[field.type],
      ...(mode === "masked" ? { masked: true } : {}),
      ...(options ? { options } : {}),
    };
  };
  const extraColumns = (key?: string): ExportColumn[] => {
    if (!extraShown) return [];
    return extras
      .filter((e) => key === undefined || e.key === key)
      .map((e) => {
        const field = `${EXTRA_PREFIX}${e.key}`;
        const options = presentation.values?.[field];
        return { field, label: label(field, e.label), type: CUSTOM_TYPE[e.type], ...(options ? { options } : {}) };
      });
  };

  const names = state.columns ?? [...entity.fields.map((f) => f.name).filter((n) => !RAW_JSON.has(n)), "extra"];
  const out: ExportColumn[] = [];
  const seen = new Set<string>();
  const add = (column: ExportColumn | null) => {
    if (column && !seen.has(column.field)) {
      seen.add(column.field);
      out.push(column);
    }
  };
  for (const name of names) {
    if (name === "id") continue;
    if (name === "extra" && fields.has("extra")) extraColumns().forEach(add);
    else if (name.startsWith(EXTRA_PREFIX)) extraColumns(name.slice(EXTRA_PREFIX.length)).forEach(add);
    else if (fields.has(name)) add(registryColumn(name));
    else throw new QueryError("unknown_field", name);
  }
  return out;
}

/** The registry columns the select must return for `columns` (admin-defined values travel inside `extra`). */
export function selectColumns(columns: readonly ExportColumn[]): string[] {
  return [...new Set(columns.map((c) => (c.field.startsWith(EXTRA_PREFIX) ? "extra" : c.field)))];
}
