"use server";

import { cloneDraft, draftValues, gridPageAccess, ProcessError, runnableProcesses, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { gridEntity } from "@/lib/grid/access";
import { processDeps } from "@/lib/server/runtime";
import { recordEntity } from "./entities";
import { gridRows } from "./load";

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
  const entity = recordEntity(entityId);
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
  const carry = Object.fromEntries(Object.entries(draft).filter(([key]) => key === "extra" || key === "extraFree"));
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
