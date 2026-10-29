"use server";

import { cloneDraft, draftValues, gridPageAccess, ProcessError, runnableProcesses, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { gridEntity } from "@/lib/grid/access";
import { processDeps } from "@/lib/server/runtime";
import { recordEntity } from "./entities";
import { gridRows } from "./load";

/** What a copy is read and created through: the record pages' entities, and support tickets (their own frame). */
interface CloneTarget {
  id: string;
  consult: string;
  create: string;
  /** Column of the consult row that names the record ("Copia de <nombre>"). */
  titleField: string;
}

const TICKET: CloneTarget = { id: "support.ticket", consult: "support.ticket.consult", create: "support.ticket.create", titleField: "title" };

const cloneTarget = (entityId: string): CloneTarget | null => recordEntity(entityId) ?? (entityId === TICKET.id ? TICKET : null);

// "Duplicar" (rule 37, design §22.13): the source is read through the entity's consult as the session's user (company
// RLS, party scope and field masking apply, so a field the caller cannot see is never copied) and turned into the
// create form's starting data by the kernel's `cloneDraft` (without the entity's `cloneReset` fields and the
// server-managed ones). Nothing is written here: the form saves through the entity's create process with the source.

export type CloneResult =
  | {
      ok: true;
      entity: string;
      sourceRowId: string;
      /** The source's name, for the banner "Copia de <nombre>". */
      sourceTitle: string;
      /** What the create form starts from, by field name (the consult-row shape). */
      values: Record<string, unknown>;
      /** The create input's extra data (datos adicionales), which the form does not edit but the save sends. */
      carry: Record<string, unknown>;
      /** How each copied reference reads (`supplier_id` → the supplier's name), for the form's lookups. */
      refLabels: Record<string, string>;
    }
  | { ok: false; code: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function cloneRecordAction(entityId: string, id: string): Promise<CloneResult> {
  const entity = cloneTarget(entityId);
  if (!entity || typeof id !== "string" || !UUID.test(id)) return { ok: false, code: "invalid_input" };
  const caller = await requireCaller();
  const deps = processDeps();
  const registered = gridEntity(deps.registry, entity.id);
  if (!registered) return { ok: false, code: "invalid_input" };
  // The copy is a creation: offered only to who may run the entity's create process (the save checks it again).
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, [entity.create]);
  if (!runnable.has(entity.create)) return { ok: false, code: "forbidden" };
  let record: Record<string, unknown>;
  try {
    record = (await runProcess(deps, caller, entity.consult, { id })) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProcessError) return { ok: false, code: error.code };
    throw error;
  }
  const { modes } = await gridPageAccess(deps.sql, caller.claims, registered);
  const draft = cloneDraft(deps.registry, entity.id, record, modes);
  const values = draftValues(deps.registry, entity.id, draft);
  const carry = await enterable(caller, entity.id, draft);
  const refLabels: Record<string, string> = {};
  for (const field of registered.fields) {
    const value = values[field.name];
    if (field.type !== "ref" || !field.ref || typeof value !== "string") continue;
    const found = await gridRows(caller, field.ref.entity, { filters: [{ field: "id", op: "eq", value }], sort: [], page: 1, pageSize: 1, columns: [field.ref.display] });
    const label = found.rows[0]?.[field.ref.display];
    if (label !== null && label !== undefined) refLabels[field.name] = String(label);
  }
  const title = record[entity.titleField];
  return { ok: true, entity: entity.id, sourceRowId: id, sourceTitle: title === null || title === undefined || title === "" ? id : String(title), values, carry, refLabels };
}

/**
 * The copy's datos adicionales the caller may also enter: a create counts every value as new, so a value their roles
 * may view but not enter would be refused (and the create form cannot show it). The free pairs anyone may add.
 */
async function enterable(caller: Awaited<ReturnType<typeof requireCaller>>, entityId: string, draft: Record<string, unknown>): Promise<Record<string, unknown>> {
  const carry: Record<string, unknown> = {};
  if (Array.isArray(draft.extraFree)) carry.extraFree = draft.extraFree;
  const extra = draft.extra;
  if (typeof extra !== "object" || extra === null || Object.keys(extra).length === 0) return carry;
  let defs: { key: string; canEnter: boolean }[];
  try {
    defs = (await runProcess(processDeps(), caller, "kernel.custom_field.list", { entity: entityId })) as { key: string; canEnter: boolean }[];
  } catch (error) {
    // Without the definitions nothing proves the caller may enter a value: none is carried.
    if (error instanceof ProcessError) return carry;
    throw error;
  }
  const allowed = new Set(defs.filter((def) => def.canEnter).map((def) => def.key));
  const kept = Object.fromEntries(Object.entries(extra).filter(([key]) => allowed.has(key)));
  if (Object.keys(kept).length > 0) carry.extra = kept;
  return carry;
}
