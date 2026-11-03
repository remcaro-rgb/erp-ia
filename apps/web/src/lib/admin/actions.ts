"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import type { ActionResult } from "@/lib/records/tab-actions";
import { processDeps, registrySynced } from "@/lib/server/runtime";

// Every change on the administration screens (rule 1): one of the admin processes, run as the session's user with the
// step-up token the screen just obtained (they are all sensitive, rule 15). A refusal comes back as data (the code and
// the process's messages) for the screen to show in place; the first answer of a sensitive process is
// `step_up_required`, which makes the screen ask for the code and call again with the token.

/**
 * The processes these screens run: the admin's own, the custom field definitions (Datos adicionales), and the Parámetros of the entity
 * types (Configuración de tipos, Destinatarios por estado, Plantillas PDF, Acceso al menú; Task 16).
 */
const ADMIN_PROCESS =
  /^kernel\.(admin\.[a-z_]+\.[a-z_]+|required_file\.(set|remove)|verifier\.set|custom_field\.(set|remove)|entity_type_settings\.update|state_recipients\.update|menu_access\.set|doc_template\.(save|set_default))$/;

export async function adminAction(processId: string, input: unknown, stepUpToken?: string): Promise<ActionResult<{ output: unknown }>> {
  if (!ADMIN_PROCESS.test(processId)) return { ok: false, code: "not_found", details: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  await registrySynced();
  try {
    return { ok: true, output: await runProcess(processDeps(), caller, processId, input) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}
