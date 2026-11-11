"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import type { ActionResult } from "@/lib/records/tab-actions";
import { processDeps } from "@/lib/server/runtime";

// «Traer TRM» on Tasas de cambio (plan 2B.2 Task 34.1, FX §12): core.exchange_rate.import_official run as the session's user (rule 1),
// origin ui. A feed failure is an answer (`failed` lists the currencies), not an error: the process raised its recommendation.

export async function importOfficialRateAction(): Promise<ActionResult<{ written: number; skipped: number; failed: string[] }>> {
  const caller = await requireCaller();
  try {
    const out = (await runProcess(processDeps(), caller, "core.exchange_rate.import_official", {})) as { written: number; skipped: unknown[]; failed: string[] };
    return { ok: true, written: out.written, skipped: out.skipped.length, failed: out.failed };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

export interface RateDraft {
  currency: string;
  rateDate: string;
  rate: number;
  note?: string;
}

/** A refusal with the module's code (the message leads with it: `official_rate_exists: …`) and its messages. */
export type RateOutcome = { ok: true } | { ok: false; code: string; reason: string | null; messages: string[] };

async function writeRate(processId: string, input: RateDraft, stepUpToken?: string): Promise<RateOutcome> {
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, processId, input);
    return { ok: true };
  } catch (error) {
    await signOutIfDisabled(error);
    if (!(error instanceof ProcessError)) throw error;
    const reason = /^([a-z_]+):/.exec(error.message)?.[1] ?? null;
    return { ok: false, code: error.code, reason, messages: issuesOf(error.details).map((d) => d.message) };
  }
}

const draftOf = (draft: RateDraft): RateDraft => ({
  currency: String(draft.currency ?? "").trim().toUpperCase(),
  rateDate: String(draft.rateDate ?? ""),
  rate: Number(draft.rate),
  ...(draft.note && String(draft.note).trim() !== "" ? { note: String(draft.note).trim() } : {}),
});

/** Registrar tasa: core.exchange_rate.set (a manual rate; refused with official_rate_exists on a TRM day). */
export async function setRateAction(draft: RateDraft): Promise<RateOutcome> {
  return writeRate("core.exchange_rate.set", draftOf(draft));
}

/** Reemplazar TRM: core.exchange_rate.override_official (step-up; the note is required). */
export async function overrideRateAction(draft: RateDraft, stepUpToken?: string): Promise<RateOutcome> {
  return writeRate("core.exchange_rate.override_official", draftOf(draft), stepUpToken);
}
