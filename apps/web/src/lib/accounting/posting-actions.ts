"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import type { ActionResult } from "@/lib/records/tab-actions";
import { processDeps } from "@/lib/server/runtime";

// What the Reglas contables page and Configurar contabilidad ask of the server (accounting design §5.5, §5.9, §6, Task 29). Each change is
// a registered process run as the session's user (rule 1); the sensitive ones answer `step_up_required` until the page presents the token.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad: ActionResult<never> = { ok: false, code: "invalid_input", details: [] };

async function perform<O, T extends object>(processId: string, input: unknown, answer: (output: O) => T, stepUpToken?: string): Promise<ActionResult<T>> {
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    return { ok: true, ...answer((await runProcess(processDeps(), caller, processId, input)) as O) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

/** Configurar contabilidad: `accounting.chart.seed` (admin, step-up). Additive and idempotent. */
export async function seedChartAction(stepUpToken?: string): Promise<ActionResult<{ accounts: number; rules: number }>> {
  return perform<{ accounts: number; rules: number }, { accounts: number; rules: number }>("accounting.chart.seed", {}, (out) => ({ accounts: out.accounts, rules: out.rules }), stepUpToken);
}

/** Reintentar: the rule runs again on the stored event. A refusal again is an answer, not an error: the row keeps the new reason. */
export async function retryFailureAction(failureId: string): Promise<ActionResult<{ resolved: boolean; number?: string; code?: string; detail?: string }>> {
  if (!UUID.test(failureId)) return bad;
  return perform<{ resolved: boolean; number?: string; code?: string; detail?: string }, { resolved: boolean; number?: string; code?: string; detail?: string }>(
    "accounting.posting.retry",
    { failureId },
    (out) => ({ resolved: out.resolved, ...(out.number ? { number: out.number } : {}), ...(out.code ? { code: out.code } : {}), ...(out.detail ? { detail: out.detail } : {}) }),
  );
}

export async function dismissFailureAction(failureId: string, reason: string): Promise<ActionResult> {
  if (!UUID.test(failureId) || typeof reason !== "string" || reason.trim() === "") return bad;
  return perform<{ id: string }, object>("accounting.posting_failure.dismiss", { failureId, reason: reason.trim() }, () => ({}));
}

export interface MappingEdit {
  role: string;
  dimension: string | null;
  accountId: string | null;
}

/** Mapeo de cuentas: role → account, optionally per dimension; a null account removes the mapping. */
export async function saveMappingsAction(edits: readonly MappingEdit[], stepUpToken?: string): Promise<ActionResult<{ upserted: number; removed: number }>> {
  if (!Array.isArray(edits) || edits.length === 0 || edits.some((e) => typeof e.role !== "string" || (e.accountId !== null && !UUID.test(String(e.accountId))))) return bad;
  return perform<{ upserted: number; removed: number }, { upserted: number; removed: number }>(
    "accounting.account_role_mapping.update",
    { mappings: edits.map((e) => ({ role: e.role, dimension: e.dimension, accountId: e.accountId })) },
    (out) => out,
    stepUpToken,
  );
}

export interface ConceptEdit {
  format: string;
  concept: string;
  accountId: string;
  isActive: boolean;
}

/** Conceptos exógena: account → concept of a format. */
export async function saveConceptsAction(edits: readonly ConceptEdit[], stepUpToken?: string): Promise<ActionResult<{ upserted: number }>> {
  if (!Array.isArray(edits) || edits.length === 0 || edits.some((e) => !UUID.test(String(e.accountId)) || typeof e.concept !== "string" || typeof e.format !== "string")) return bad;
  return perform<{ upserted: number }, { upserted: number }>("accounting.fiscal_concept_mapping.update", { mappings: edits.map((e) => ({ format: e.format, concept: e.concept, accountId: e.accountId, isActive: e.isActive })) }, (out) => out, stepUpToken);
}

export interface SettingsEdit {
  useOpenAuxiliaries: boolean;
  useItems: boolean;
  useBusinessUnits: boolean;
  requireApprovalOnManual: boolean;
  requireAttachmentOnManual: boolean;
  roundingTolerance: number;
  manualJournalId: string;
  niifGroup: "1" | "2" | "3";
  ruleStaleDays: number;
  postingAlertMinutes: number;
}

/** Configuración: `accounting.settings.update` (admin, step-up). */
export async function saveSettingsAction(edit: SettingsEdit, stepUpToken?: string): Promise<ActionResult> {
  if (!edit || !UUID.test(String(edit.manualJournalId)) || !["1", "2", "3"].includes(edit.niifGroup) || typeof edit.roundingTolerance !== "number" || !Number.isInteger(edit.ruleStaleDays) || edit.ruleStaleDays < 1 || edit.ruleStaleDays > 3650 || !Number.isInteger(edit.postingAlertMinutes) || edit.postingAlertMinutes < 5 || edit.postingAlertMinutes > 10080) return bad;
  return perform<{ id: string }, object>("accounting.settings.update", edit, () => ({}), stepUpToken);
}

/** Mapeo de cuentas, modo de contabilización: `accounting.posting_mode.set` (step-up). Switching rewrites nothing; the answer carries what still awaits the ledger. */
export async function setPostingModeAction(mode: string, stepUpToken?: string): Promise<ActionResult<{ mode: string; previous: string; pendingDocuments: number; pendingFailures: number }>> {
  if (mode !== "inline_strict" && mode !== "asynchronous") return bad;
  return perform<{ mode: string; previous: string; pendingDocuments: number; pendingFailures: number }, { mode: string; previous: string; pendingDocuments: number; pendingFailures: number }>(
    "accounting.posting_mode.set",
    { mode },
    (out) => ({ mode: out.mode, previous: out.previous, pendingDocuments: out.pendingDocuments, pendingFailures: out.pendingFailures }),
    stepUpToken,
  );
}
