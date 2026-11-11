"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { SaveResult } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";
import { recordEntity } from "./entities";
import { issuesOf } from "./issues";

// Saving a record form (rule 1): the entity's create process for a new record, its update process otherwise, run as
// the session's user with the step-up token when the user just verified one. A refusal comes back with the process's
// messages (the country pack's `invalid_input` details, and Zod issues with their field) for the form to show.
// A record created from a copy ("Duplicar", rule 37) names its source: the create run records it as `source_row_id`
// once the caller has read the source through the entity's consult (a source they cannot see is refused the same way).

export async function saveRecordAction(entityId: string, input: Record<string, unknown>, stepUpToken?: string, options?: { sourceRowId?: string }): Promise<SaveResult> {
  const entity = recordEntity(entityId);
  if (!entity || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", details: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  const creating = typeof input.id !== "string";
  const process = creating ? entity.create : entity.update;
  // An entity with no such form (a Período is only shown; a Regla contable is created elsewhere) answers like any other refusal.
  if (!process) return { ok: false, code: "forbidden", details: [] };
  const sourceRowId = creating && typeof options?.sourceRowId === "string" ? options.sourceRowId : undefined;
  try {
    if (sourceRowId) await runProcess(processDeps(), caller, entity.consult, { id: sourceRowId });
    const { id, updatedAt, status } = (await runProcess(processDeps(), caller, process, input, sourceRowId ? { sourceRowId } : {})) as { id: string; updatedAt?: string; status?: unknown };
    // `status`: where the save left a documento whose create process already records it (a cotización or a pedido that waits for
    // approval answers pending): the bar then has no Grabar to run (Task 14b).
    return { ok: true, id, ...(typeof updatedAt === "string" ? { updatedAt } : {}), ...(typeof status === "string" ? { status } : {}) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}
