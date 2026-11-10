"use server";

import { ProcessError, runProcess, runnableProcesses, withClaims } from "@erp/kernel";
import { yearPreview, type YearPreview } from "@erp/module-accounting";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import type { ActionResult } from "@/lib/records/tab-actions";
import { processDeps } from "@/lib/server/runtime";

// What the Períodos page asks of the server (accounting design §5.7, §8, Task 29). Each change is a registered process run as the
// session's user (rule 1); the four are step-up processes, so the page runs them again with the token the TOTP dialog produced (rule 15).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
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

export interface CloseCheckResult {
  check: string;
  passed: boolean;
  note: string;
  /** A warning (FX §5 «Diferencia en cambio no calculada») is shown but never keeps the period open. */
  severity?: "warning";
}

/** Cerrar un período: runs the close checks; a failed check keeps it open and the answer lists them (the process records the attempt). */
export async function closePeriodAction(periodId: string, stepUpToken?: string): Promise<ActionResult<{ closed: boolean; checks: CloseCheckResult[] }>> {
  if (!UUID.test(periodId)) return bad;
  return perform<{ closed: boolean; checks: CloseCheckResult[] }, { closed: boolean; checks: CloseCheckResult[] }>(
    "accounting.period.close",
    { periodId },
    (out) => ({ closed: out.closed, checks: out.checks.map((c) => ({ check: c.check, passed: c.passed, note: c.note, ...(c.severity ? { severity: c.severity } : {}) })) }),
    stepUpToken,
  );
}

/** Reabrir un período, whole or only for one day (`date`). */
export async function reopenPeriodAction(periodId: string, date: string | null, stepUpToken?: string): Promise<ActionResult<{ reopenedFor: string | null }>> {
  if (!UUID.test(periodId) || (date !== null && !DAY.test(date))) return bad;
  return perform<{ reopenedFor: string | null }, { reopenedFor: string | null }>("accounting.period.reopen", { periodId, ...(date ? { date } : {}) }, (out) => ({ reopenedFor: out.reopenedFor }), stepUpToken);
}

export async function closeYearAction(fiscalYearId: string, stepUpToken?: string): Promise<ActionResult<{ result: number; entries: number }>> {
  if (!UUID.test(fiscalYearId)) return bad;
  return perform<{ result: number; closingEntryIds: string[] }, { result: number; entries: number }>(
    "accounting.year.close",
    { fiscalYearId },
    (out) => ({ result: out.result, entries: out.closingEntryIds.length }),
    stepUpToken,
  );
}

export async function reopenYearAction(fiscalYearId: string, stepUpToken?: string): Promise<ActionResult<{ reversed: number }>> {
  if (!UUID.test(fiscalYearId)) return bad;
  return perform<{ reversedEntryIds: string[] }, { reversed: number }>("accounting.year.reopen", { fiscalYearId }, (out) => ({ reversed: out.reversedEntryIds.length }), stepUpToken);
}

/** The closing preview of a year: only for a caller whose roles may close or reopen it. */
export async function yearPreviewAction(fiscalYearId: string): Promise<{ ok: true; preview: YearPreview } | { ok: false }> {
  if (!UUID.test(fiscalYearId)) return { ok: false };
  const caller = await requireCaller();
  const deps = processDeps();
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.year.close", "accounting.year.reopen"]);
  if (runnable.size === 0) return { ok: false };
  const preview = await withClaims(deps.sql, caller.claims, (tx) => yearPreview(tx, { companyId: caller.claims.active_company_id, fiscalYearId }));
  return preview ? { ok: true, preview } : { ok: false };
}
