"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { SaveResult } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { recordEntity } from "./entities";

// Saving a record form (rule 1): the entity's create process for a new record, its update process otherwise, run as
// the session's user with the step-up token when the user just verified one. A refusal comes back with the process's
// messages (the country pack's `invalid_input` details) for the form to show.

/** The messages of a refusal: the pack's strings as they are, Zod issues as `path: message`. */
function messagesOf(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.map((d) => {
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && "message" in d) {
      const path = Array.isArray((d as { path?: unknown }).path) ? ((d as { path: unknown[] }).path).join(".") : "";
      return path ? `${path}: ${String((d as { message: unknown }).message)}` : String((d as { message: unknown }).message);
    }
    return String(d);
  });
}

export async function saveRecordAction(entityId: string, input: Record<string, unknown>, stepUpToken?: string): Promise<SaveResult> {
  const entity = recordEntity(entityId);
  if (!entity || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", details: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  const process = typeof input.id === "string" ? entity.update : entity.create;
  try {
    const { id } = (await runProcess(processDeps(), caller, process, input)) as { id: string };
    return { ok: true, id };
  } catch (error) {
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: messagesOf(error.details) };
    throw error;
  }
}
