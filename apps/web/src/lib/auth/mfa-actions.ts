"use server";

import { cookies } from "next/headers";
import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import type { ActionResult } from "@/lib/records/tab-actions";
import { processDeps, registrySynced } from "@/lib/server/runtime";
import { logout } from "./login";
import { MFA_DISABLED_LOGIN } from "./notices";

// The second step's server actions (design §22.19, rules 1 and 15): kernel.user.mfa.disable from the user menu and
// kernel.admin.user.mfa.set from a user's page, run as the session's user with the step-up token the screen just
// obtained (both are sensitive: the first answer is `step_up_required`). A refusal comes back as data.
//
// Auth ends every session of a user whose verified factor is removed. When that user is the caller (their own disable,
// or an admin resetting themselves), this session is already dead: its cookies are cleared here (as signing out does) and
// the action answers where the browser goes, the sign-in page with the notice. No `refreshSession()`: the refresh token
// was revoked with the sessions. An admin resetting someone else keeps their own session; the target's sessions end.

/** `next`: the page to load once the action succeeded (the sign-in notice), or null to stay and refresh. */
export type MfaActionResult = ActionResult<{ next: string | null }>;

async function run<O>(processId: string, input: unknown, stepUpToken: string | undefined): Promise<{ ok: true; output: O; sub: string } | Extract<MfaActionResult, { ok: false }>> {
  const base = await requireCaller();
  const caller = { ...base, ...(stepUpToken ? { stepUpToken } : {}) };
  await registrySynced();
  try {
    return { ok: true, output: (await runProcess(processDeps(), caller, processId, input)) as O, sub: base.claims.sub };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

/** Ends this session (Auth already revoked it) and answers the sign-in notice. */
async function signedOut(): Promise<MfaActionResult> {
  await logout(await cookies());
  return { ok: true, next: MFA_DISABLED_LOGIN };
}

/** Turns off the caller's own second step (kernel.user.mfa.disable). */
export async function disableOwnMfaAction(stepUpToken?: string): Promise<MfaActionResult> {
  const result = await run<{ removed: number }>("kernel.user.mfa.disable", {}, stepUpToken);
  if (!result.ok) return result;
  return result.output.removed > 0 ? signedOut() : { ok: true, next: null };
}

/** Removes a member's factor (`reset`) and/or sets their exemption from the admin role's requirement (kernel.admin.user.mfa.set). */
export async function setUserMfaAction(userId: string, change: { reset?: boolean; exempt?: boolean }, stepUpToken?: string): Promise<MfaActionResult> {
  // The input is built from the named arguments only: whatever else a tampered call puts in `change` (a userId) is dropped.
  const input = { userId, ...(change.reset !== undefined ? { reset: change.reset } : {}), ...(change.exempt !== undefined ? { exempt: change.exempt } : {}) };
  const result = await run<{ userId: string; removed: number; exempt: boolean }>("kernel.admin.user.mfa.set", input, stepUpToken);
  if (!result.ok) return result;
  // Whose factor went is what the process answers, not what the browser asked.
  return result.output.removed > 0 && result.output.userId === result.sub ? signedOut() : { ok: true, next: null };
}
