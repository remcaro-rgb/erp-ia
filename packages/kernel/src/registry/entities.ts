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
  /**
   * `table` (default) is a base table with a create process; `query` is a read-only entity over a view that joins other tables
   * (`table` names the view's stem: its masked view is `v_<table>`). A query entity has no create process, so the importer, the
   * clone and "Nuevo" skip it, and its grid consult is `<entity id>.list`.
   */
  kind?: "table" | "query";
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
  /**
   * Parameters the entity's view reads (design §9, gaps plan Task 7): a grid state may carry a value for each in `params`, and
   * the query sets it as the transaction setting `erp.param.<name>` before reading, so a view can compute a column for the
   * period or date the screen shows (`accounting.period_figure`). An entity without any refuses every param.
   */
  gridParams?: GridParamDef[];
}

export interface GridParamDef {
  /** Lowercase identifier: the setting is `erp.param.<name>`. */
  name: string;
  type: "uuid" | "date" | "text";
  required?: boolean;
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
  const rolled = fields.find((f) => f.rollup);
  if (rolled && !names.has("parent_id")) throw new Error(`entity ${def.id}: rollup field ${rolled.name} needs a parent_id field`);
  if (!names.has(def.displayField)) throw new Error(`entity ${def.id}: displayField ${def.displayField} is not a field`);
  for (const key of def.importKey ?? []) {
    if (!names.has(key)) throw new Error(`entity ${def.id}: importKey ${key} is not a field`);
  }
  for (const name of def.cloneReset ?? []) {
    if (!names.has(name)) throw new Error(`entity ${def.id}: cloneReset ${name} is not a field`);
  }
  const params = new Set<string>();
  for (const param of def.gridParams ?? []) {
    if (!IDENTIFIER.test(param.name)) throw new Error(`entity ${def.id}: invalid grid param name "${param.name}"`);
    if (params.has(param.name)) throw new Error(`entity ${def.id}: duplicate grid param ${param.name}`);
    params.add(param.name);
  }
  if (!names.has(def.defaultSort.field)) {
    throw new Error(`entity ${def.id}: defaultSort.field ${def.defaultSort.field} is not a field`);
  }
  return { ...def, defaultSort: { ...def.defaultSort }, ...(def.gridParams ? { gridParams: def.gridParams.map((p) => ({ ...p })) } : {}), ...(def.cloneReset ? { cloneReset: [...def.cloneReset] } : {}), fields };
}
