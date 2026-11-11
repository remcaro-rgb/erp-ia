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
  /**
   * The entity's role (`maestro`, `documento`, `lines`, `parametro` or `sistema`), required on every table entity and refused
   * on a query entity (entity types spec §2.1, D13, owner 2026-11-02). The lifecycle, access rules, snapshots and templates build on it.
   */
  entityType?: EntityType;
  /** Declarations that only a typed entity carries (entity types spec §5). */
  typed?: TypedDef;
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
  /**
   * Row-level masking (D20, entity types spec §10, owner 2026-11-03): the entity's masked view keeps a row the caller may not see
   * (a comprobante's line of a restricted account) with `flag` true and every one of `fields` null. The grid shows it as a «••••»
   * placeholder row (it counts in pagination); a filter or search on one of `fields` never matches it, a sort by one puts it last, and
   * an aggregate over one of `fields` is unknown (null) whenever such a row is in the filter, except `totals`: the sum of the lines of
   * one parent (the filter is exactly `parentField = id`) is the parent's own column, read from the parent's masked view `view`.
   */
  rowMask?: { flag: string; fields: string[]; totals?: { parentField: string; view: string; columns: Record<string, string> } };
}

/**
 * The role of a table entity (D13). Only `maestro` and `documento` are typed: they carry the lifecycle, Datos adicionales,
 * import and export. `lines` are the rows of a parent named by the parent's `typed.lines`; `parametro` is configuration
 * (listed under Parámetros); `sistema` covers logs, users, imports, exports and audit.
 */
export type EntityType = "maestro" | "documento" | "lines" | "parametro" | "sistema";

export interface TypedDef {
  /** Fields whose change after approval sends the record back through approval (each must be a field of the entity). */
  approvalFields?: string[];
  /** The `lines` entity holding the rows of this maestro or documento, and the field of it that points at the parent. */
  lines?: { entity: string; parentField: string };
  /** When the document takes its number: at save, when it posts, or never (documento only). */
  numbering?: "on_save" | "on_post" | "none";
  /**
   * Flags the entity sets itself instead of copying them from Parámetros (kernel.entity_type_settings): each names, as an i18n key,
   * where the flag comes from. The Configuración de tipos screen shows that note in place of the switch (Task 16).
   */
  ownFlags?: { requiresApproval?: string; posts?: string };
}

export interface GridParamDef {
  /** Lowercase identifier: the setting is `erp.param.<name>`. */
  name: string;
  type: "uuid" | "date" | "text";
  required?: boolean;
}

/** A resolved entity: `entityType` is present exactly when the entity is not a query entity. */
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
  validateTyped(def, names);
  if (!names.has(def.defaultSort.field)) {
    throw new Error(`entity ${def.id}: defaultSort.field ${def.defaultSort.field} is not a field`);
  }
  if (def.rowMask) {
    const { flag, fields: masked, totals } = def.rowMask;
    if (!IDENTIFIER.test(flag)) throw new Error(`entity ${def.id}: invalid rowMask flag "${flag}"`);
    for (const name of masked) if (!names.has(name)) throw new Error(`entity ${def.id}: rowMask field ${name} is not a field`);
    if (totals) {
      if (!names.has(totals.parentField)) throw new Error(`entity ${def.id}: rowMask parentField ${totals.parentField} is not a field`);
      if (!/^[a-z][a-z0-9_]*\.v_[a-z0-9_]+$/.test(totals.view)) throw new Error(`entity ${def.id}: rowMask view ${totals.view} is not a masked view`);
      for (const [name, column] of Object.entries(totals.columns)) {
        if (!masked.includes(name) || !IDENTIFIER.test(column)) throw new Error(`entity ${def.id}: rowMask total ${name} → ${column} is invalid`);
      }
    }
  }
  return { ...def, ...(def.typed ? { typed: { ...def.typed, ...(def.typed.approvalFields ? { approvalFields: [...def.typed.approvalFields] } : {}), ...(def.typed.lines ? { lines: { ...def.typed.lines } } : {}), ...(def.typed.ownFlags ? { ownFlags: { ...def.typed.ownFlags } } : {}) } } : {}), defaultSort: { ...def.defaultSort }, ...(def.gridParams ? { gridParams: def.gridParams.map((p) => ({ ...p })) } : {}), ...(def.cloneReset ? { cloneReset: [...def.cloneReset] } : {}), fields };
}

const ENTITY_TYPES = ["maestro", "documento", "lines", "parametro", "sistema"];
const NUMBERINGS = ["on_save", "on_post", "none"];

function validateTyped(def: EntityDef, names: Set<string>): void {
  if (def.kind === "query") {
    if (def.entityType !== undefined) throw new Error(`entity ${def.id}: query entities carry no entityType`);
    if (def.typed !== undefined) throw new Error(`entity ${def.id}: query entities carry no typed block`);
    return;
  }
  if (def.entityType === undefined) throw new Error(`entity ${def.id}: entityType is required`);
  if (!ENTITY_TYPES.includes(def.entityType)) throw new Error(`entity ${def.id}: entityType must be one of ${ENTITY_TYPES.join(", ")}`);
  const typed = def.typed;
  if (!typed) return;
  if (def.entityType !== "maestro" && def.entityType !== "documento") throw new Error(`entity ${def.id}: ${def.entityType} entities carry no typed block`);
  for (const name of typed.approvalFields ?? []) {
    if (!names.has(name)) throw new Error(`entity ${def.id}: typed.approvalFields ${name} is not a field`);
  }
  if (typed.lines) {
    if (!ENTITY_ID.test(typed.lines.entity)) throw new Error(`entity ${def.id}: typed.lines.entity must look like "module.name"`);
    // The parent field lives on the lines entity, which the registry may not hold yet; a self-referencing declaration is checked here.
    if (typed.lines.entity === def.id && !names.has(typed.lines.parentField)) {
      throw new Error(`entity ${def.id}: typed.lines.parentField ${typed.lines.parentField} is not a field`);
    }
  }
  if (typed.numbering !== undefined) {
    if (def.entityType !== "documento") throw new Error(`entity ${def.id}: typed.numbering is for documento`);
    if (!NUMBERINGS.includes(typed.numbering)) throw new Error(`entity ${def.id}: typed.numbering must be on_save, on_post or none`);
  }
}
