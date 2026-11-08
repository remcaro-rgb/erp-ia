"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import { processDeps } from "@/lib/server/runtime";

// Parámetros › Facturación electrónica (plan 2B Task 19, rule 1): every button of the page runs a registered process as the session's user,
// with the step-up token when the user just verified one (all but «Reintentar todos» are sensitive, rule 15; the checklist's tick and confirm too). The page names WHAT it saves;
// the server picks the process from this list (the client never names a process). A refusal comes back as data for the form, its messages
// in Spanish; `step_up_required` makes the page ask for the code and send the same input again. The certificate and the PIN go from the
// form to their process and no further: nothing here logs or answers them (rule 12).

const ACTIONS = {
  settings: "invoicing.settings.update",
  sequence: "core.document_sequence.register",
  certificate: "invoicing.certificate.upload",
  pin: "invoicing.software_pin.set",
  resubmit: "invoicing.invoice.resubmit_failed",
  // Task 35: the DIAN verification checklist (its screen) and the confirmation of the defaults.
  tick: "invoicing.dian_checklist.tick",
  confirm: "invoicing.dian_defaults.confirm",
} as const;

export type InvoicingSettingsAction = keyof typeof ACTIONS;

export type InvoicingOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; messages: string[] };

export async function runInvoicingSettingsAction(action: InvoicingSettingsAction, input: Record<string, unknown>, stepUpToken?: string): Promise<InvoicingOutcome> {
  if (!Object.hasOwn(ACTIONS, action) || typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    const data = (await runProcess(processDeps(), caller, ACTIONS[action], input)) as Record<string, unknown>;
    // What comes back is metadata only (the processes never answer a secret); the certificate's dates as text for the client.
    return { ok: true, data: JSON.parse(JSON.stringify(data ?? {})) as Record<string, unknown> };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) {
      const messages = issuesOf(error.details).map((i) => i.message);
      return { ok: false, code: error.code, messages: messages.length > 0 ? messages : error.code === "invalid_input" || error.code === "invalid_state" ? [error.message.replace(/^[a-z_]+: /, "")] : [] };
    }
    throw error;
  }
}
