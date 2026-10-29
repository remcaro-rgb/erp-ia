import { importColumns } from "../import/columns";
import type { FieldMode } from "../query/run";
import type { Registry } from "../registry";
import { SECRET_COLUMNS, TECHNICAL_COLUMNS } from "../registry/columns";

// Cloning a record (rule 37, design §22.13). "Duplicar" starts the entity's create form from the source as the caller
// sees it (its consult row, masked fields null and hidden ones absent) without the record's unique and identity
// fields, and the save runs the entity's own create process with `sourceRowId`: the clone is validated, permissioned,
// stepped up and audited like any creation. Pure: no database, no React.

/** Columns the server keeps for every row (and the consecutive): a clone never carries them, whatever the entity declares. */
const SERVER_MANAGED: ReadonlySet<string> = new Set([...TECHNICAL_COLUMNS, "seq"]);
/** The record's admin-defined extra data: create input key → column. */
const EXTRA: Readonly<Record<string, string>> = { extra: "extra", extraFree: "extra_free" };

const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && value !== null && Object.keys(value).length === 0);

const copy = <T>(value: T): T => (typeof value === "object" && value !== null ? structuredClone(value) : value);

/**
 * The create process input a clone of `record` starts from: every key of the entity's create input whose field the
 * record shows (a non-empty value, `modes` visible), except the server-managed and secret columns and the entity's
 * `cloneReset` fields. Number columns arrive as text from Postgres (`numeric`) and go back as numbers. Contacts, files
 * and other child records are not fields of the record, so they are never part of it. Throws for an unknown entity
 * or one without a create process.
 */
export function cloneDraft(registry: Registry, entityId: string, record: Readonly<Record<string, unknown>>, modes: Readonly<Record<string, FieldMode>> = {}): Record<string, unknown> {
  const entity = registry.entity(entityId);
  const reset = new Set(entity.cloneReset ?? []);
  const copied = (field: string) => !SERVER_MANAGED.has(field) && !SECRET_COLUMNS.has(field) && !reset.has(field) && (modes[field] ?? "visible") === "visible" && entity.fields.some((f) => f.name === field);
  const draft: Record<string, unknown> = {};
  for (const column of importColumns(registry, entityId)) {
    const value = record[column.field];
    if (!copied(column.field) || isEmpty(value)) continue;
    if (column.type === "number") {
      const number = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(number)) draft[column.key] = number;
    } else draft[column.key] = copy(value);
  }
  // The extra data the caller sees (the consult already dropped the keys their roles may not view).
  const createKeys = new Set(Object.keys(createShape(registry, entityId)));
  for (const [key, field] of Object.entries(EXTRA)) {
    const value = record[field];
    if (createKeys.has(key) && copied(field) && !isEmpty(value)) draft[key] = copy(value);
  }
  return draft;
}

/** The draft by field name (`documentNumber` → `document_number`): the consult-row shape a record form starts from. */
export function draftValues(registry: Registry, entityId: string, draft: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fieldOf = new Map<string, string>([...importColumns(registry, entityId).map((c) => [c.key, c.field] as const), ...Object.entries(EXTRA)]);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    const field = fieldOf.get(key);
    if (field) values[field] = copy(value);
  }
  return values;
}

/** The keys of the entity's create process input. */
function createShape(registry: Registry, entityId: string): Record<string, unknown> {
  const entity = registry.entity(entityId);
  const process = registry.process(entity.processIds?.create ?? `${entity.id}.create`);
  return (process.input as unknown as { def: { shape?: Record<string, unknown> } }).def.shape ?? {};
}
