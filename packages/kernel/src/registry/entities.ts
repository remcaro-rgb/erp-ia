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
}

export type ResolvedEntityDef = Omit<EntityDef, "fields"> & { fields: ResolvedFieldDef[] };

/**
 * Validates an entity declaration and returns it with every field default applied. Throws on
 * malformed identifiers, duplicate field names, an unknown `displayField` / `defaultSort.field`,
 * `ref` fields without a valid target and `enum` fields without values.
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
  if (!names.has(def.defaultSort.field)) {
    throw new Error(`entity ${def.id}: defaultSort.field ${def.defaultSort.field} is not a field`);
  }
  return { ...def, defaultSort: { ...def.defaultSort }, fields };
}
