import type { z } from "zod";
import { ENTITY_ID } from "../registry/fields";
import type { ReportDef } from "./types";

const ACTION_ID = /^[a-z][a-z0-9_]*$/;
const NUMERIC = new Set(["money", "number"]);

/**
 * Validates a report definition and returns it. Throws when: the id is not `<module>.<name>` in the report's module;
 * there is no column or a field repeats; a `totals` field (or a column marked `total`) is not a money or number column; a file action repeats an id.
 * That the consult exists and is a consult process is checked when modules load (`loadModules`).
 */
export function defineReport<P extends z.ZodObject>(def: ReportDef<P>): ReportDef<P> {
  if (!ENTITY_ID.test(def.id) || !def.id.startsWith(`${def.module}.`)) throw new Error(`report ${def.id} must be named "${def.module}.<name>"`);
  if (def.columns.length === 0) throw new Error(`report ${def.id} has no column`);
  const columns = new Map<string, ReportDef["columns"][number]>();
  for (const column of def.columns) {
    if (columns.has(column.field)) throw new Error(`report ${def.id}: duplicate column ${column.field}`);
    columns.set(column.field, column);
  }
  for (const field of def.totals ?? []) {
    const column = columns.get(field);
    if (!column) throw new Error(`report ${def.id}: totals names ${field}, which is not a column`);
    if (!NUMERIC.has(column.type)) throw new Error(`report ${def.id}: totals column ${field} must be money or number`);
  }
  const actions = new Set<string>();
  for (const action of def.fileActions ?? []) {
    if (!ACTION_ID.test(action.id)) throw new Error(`report ${def.id}: file action id "${action.id}" must be lower snake case`);
    if (actions.has(action.id)) throw new Error(`report ${def.id}: duplicate file action ${action.id}`);
    actions.add(action.id);
  }
  return def;
}
