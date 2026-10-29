import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceDb, membershipInactive, type JwtClaims } from "@erp/kernel";
import { serviceSupabase } from "@/lib/supabase/service";
import { recordCompanySwitch } from "./audit";
import { readSession, type SessionState } from "./claims";

// Deactivation is per company (design §22.16, review of Task 7): a session whose membership in its active company the
// admin deactivated moves to another company where the person is still active, and is signed out only when none is left.
// The access token hook (0027) does the choosing: a fresh token names an active membership whenever one exists.

/**
 * Reissues the session's token and answers its new state when it now stands in a company where the membership is active
 * (the choice is stored in `app_metadata.active_company_id`, so a later reactivation does not move the person back, and
 * audited as `auth.company.switch`); null when the person has no active membership left (or the refresh fails).
 */
export async function leaveInactiveCompany(supabase: SupabaseClient, from: JwtClaims): Promise<SessionState | null> {
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) return null;
  const state = await readSession(supabase, refreshed.data.session.access_token);
  if (!state?.claims || (await membershipInactive(getServiceDb(), state.claims))) return null;
  if (state.claims.active_company_id !== from.active_company_id) {
    const { error } = await serviceSupabase().auth.admin.updateUserById(state.claims.sub, { app_metadata: { active_company_id: state.claims.active_company_id } });
    if (error) return null;
    await recordCompanySwitch(state.claims, from.active_company_id);
  }
  return state;
}
