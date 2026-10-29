import { ENTITY_ID, IDENTIFIER, resolveField, type FieldDef, type ResolvedFieldDef } from "./fields";

export interface EntityDef {
  /** `<module>.<name>`, e.g. `core.party`. */
  id: string;
  module: string;
  /** Postgres schema and table the entity lives in. */
  schema: string;
  table: string;
  /** i18n key. */
  label: string;
  fields: FieldDef[];
  displayField: string;
  defaultSort: { field: string; dir: "asc" | "desc" };
  /**
   * Processes acting on the entity whose id does not follow `<entity id>.<verb>`: `create` is the process the
   * importer creates records through (default `<entity id>.create`); `attach` is the process a caller must be
   * able to run to attach files to a record (default `<entity id>.update`).
   */
  processIds?: { create?: string; attach?: string };
  /**
   * Fields that identify a record among the company's (its unique key): an import refuses a row that repeats an
   * earlier row of the same file on them, in the preview as in the run.
   */
  importKey?: string[];
  /**
   * Fields a clone leaves empty (rule 37, design §22.13): the record's unique and identity fields (document number and
   * its DV, SKU, consecutive) and the state the server derives (DIAN status, invoice readiness). "Duplicar" starts the
   * entity's create form from the source's visible data without them; the server-managed columns (id, seq, company,
   * timestamps, actors), secret columns, files and child records are never copied whatever this lists.
   */
  cloneReset?: string[];
  /**
   * The entity's records have a page of their own that a link can open (rule 21, design §22.15): the record frame at
   * /r/<entity id>/<id>, or for the kernel's users their page under Administración › Usuarios (`recordHref`).
   */
  recordPage?: boolean;
}

export type ResolvedEntityDef = Omit<EntityDef, "fields"> & { fields: ResolvedFieldDef[] };

/**
 * Validates an entity declaration and returns it with every field default applied. Throws on
 * malformed identifiers, duplicate field names, an unknown `displayField` / `defaultSort.field`,
 * `ref` fields without a valid target, `enum` fields without values and `importKey` / `cloneReset` names that are not
 * fields.
 */
export function defineEntity(def: EntityDef): ResolvedEntityDef {
  if (!ENTITY_ID.test(def.id)) throw new Error(`entity ${def.id}: id must look like "module.name"`);
  for (const [what, value] of [["module", def.module], ["schema", def.schema], ["table", def.table]] as const) {
    if (!IDENTIFIER.test(value)) throw new Error(`entity ${def.id}: invalid ${what} "${value}"`);
  }
  const fields = def.fields.map((field) => resolveField(def.id, field));
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`entity ${def.id}: duplicate field ${field.name}`);
    names.add(field.name);
  }
  if (!names.has(def.displayField)) throw new Error(`entity ${def.id}: displayField ${def.displayField} is not a field`);
  for (const key of def.importKey ?? []) {
    if (!names.has(key)) throw new Error(`entity ${def.id}: importKey ${key} is not a field`);
  }
  for (const name of def.cloneReset ?? []) {
    if (!names.has(name)) throw new Error(`entity ${def.id}: cloneReset ${name} is not a field`);
  }
  if (!names.has(def.defaultSort.field)) {
    throw new Error(`entity ${def.id}: defaultSort.field ${def.defaultSort.field} is not a field`);
  }
  return { ...def, defaultSort: { ...def.defaultSort }, ...(def.cloneReset ? { cloneReset: [...def.cloneReset] } : {}), fields };
}
