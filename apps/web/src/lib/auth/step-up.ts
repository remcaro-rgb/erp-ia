import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceDb, type JwtClaims } from "@erp/kernel";

// Step-up (design §6, rule 15): a sensitive process asks for a fresh TOTP code. A correct code is turned
// into a one-time token bound to the verifying user and company, valid 5 minutes (`kernel.step_up_verifications`).
// Only the service role may insert it: the user's own connection cannot mint one.

export class StepUpError extends Error {
  readonly code: "invalid_code" | "no_factor" | "unavailable";
  constructor(code: StepUpError["code"]) {
    super(`step-up failed: ${code}`);
    this.name = "StepUpError";
    this.code = code;
  }
}

/**
 * Checks `code` against the user's verified TOTP factor and, when right, records the verification and returns
 * its token. A wrong code records nothing.
 */
export async function issueStepUp(supabase: SupabaseClient, claims: JwtClaims, code: string): Promise<string> {
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) throw new StepUpError("unavailable");
  const factor = factors.totp[0];
  if (!factor) throw new StepUpError("no_factor");

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) throw new StepUpError(error.status !== undefined && error.status >= 500 ? "unavailable" : "invalid_code");

  const token = randomBytes(32).toString("base64url");
  await getServiceDb()`
    insert into kernel.step_up_verifications (user_id, company_id, token)
    values (${claims.sub}, ${claims.active_company_id}, ${token})`;
  return token;
}
