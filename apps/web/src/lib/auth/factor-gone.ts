import "server-only";
import { getServiceDb, hasVerifiedFactor } from "@erp/kernel";
import type { SessionState } from "./claims";

// A removed second step (design §22.19, owner decision 2026-10-30): the second-step processes end the user's sessions in
// Auth, but an access token already issued still verifies offline until it expires (10 minutes). Such a token still
// claims `mfa_enrolled`; one lookup tells whether the factor is really there. A token that claims no factor (every
// token issued after the removal) is never looked up.

/** Whether `state` claims a verified factor the user no longer has. */
export async function factorRemoved(state: Pick<SessionState, "userId" | "mfaEnrolled">): Promise<boolean> {
  if (!state.mfaEnrolled) return false;
  return !(await hasVerifiedFactor(getServiceDb(), state.userId));
}
