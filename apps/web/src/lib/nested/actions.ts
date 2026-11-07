"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import type { ActionResult } from "@/lib/records/tab-actions";
import { processDeps, registrySynced } from "@/lib/server/runtime";

// The nested-run screens' server side (plan 2B Task 32, rule 1): the settings and the queue's two buttons run their registered process as the
// session's user. Pair, depth and retry are step-up processes (rule 15): the first answer is `step_up_required`, the screen asks for the code and
// calls again with the token. A refusal comes back as data (the code and the process's messages), never thrown.

const PROCESSES = {
  pair: "kernel.admin.nested_run.pair.set",
  depth: "kernel.admin.nested_run.depth.set",
  retry: "kernel.nested_failure.retry",
  dismiss: "kernel.nested_failure.dismiss",
} as const;

export type NestedActionKind = keyof typeof PROCESSES;

/** Runs the nested-run process `kind` (a fixed list: the client never names a process id) with the step-up token the screen just obtained. */
export async function nestedAction(kind: NestedActionKind, input: unknown, stepUpToken?: string): Promise<ActionResult<{ output: unknown }>> {
  if (!Object.hasOwn(PROCESSES, kind)) return { ok: false, code: "not_found", details: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  await registrySynced();
  try {
    return { ok: true, output: await runProcess(processDeps(), caller, PROCESSES[kind], input) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}
