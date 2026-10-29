import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceDb, membershipInactive, writeAudit } from "@erp/kernel";
import { companySwitchEntry } from "./audit";
import { companyMove, mfaStep, readSession, type SessionState } from "./claims";

// Deactivation is per company (design §22.16, review of Task 7): a session whose membership in its active company the
// admin deactivated moves to another company where the person is still active, and is signed out only when none is left.
// The access token hook (0027) does the choosing; the web app makes each automatic move durable and visible: it stores
// the new company as the user's choice (`app_metadata.active_company_id`, so a later reactivation does not move the
// session back unseen) and audits it as `auth.company.switch` with its reason.

/**
 * Makes the automatic move of `state` durable: stores the token's company as the user's choice, audits the switch, and
 * reissues the token so the session no longer carries the move (once per move). Nothing is written before the session
 * is complete (second factor done, rule 15), and never a move into a company whose membership is inactive (a
 * `membership_missing` move the hook made with no active membership left): that session goes down the disabled path.
 * Idempotent: the stored choice is read and written in one transaction holding the user's row, with the audit row,
 * so concurrent requests carrying the same move (tabs, prefetches) store and audit it once; each still reissues its
 * token. Answers the session as it now is (`state` when there is nothing to do or the store fails).
 */
export async function settleCompany(supabase: SupabaseClient, state: SessionState): Promise<SessionState> {
  const move = companyMove(state);
  if (!move || !state.claims || mfaStep(state) !== null) return state;
  const claims = state.claims;
  const sql = getServiceDb();
  if (await membershipInactive(sql, claims)) return state;
  try {
    await sql.begin(async (tx) => {
      const [user] = await tx<{ stored: string | null }[]>`
        select raw_app_meta_data ->> 'active_company_id' as stored from auth.users where id = ${claims.sub} for update`;
      // Already the user's choice: another request settled this move first.
      if (!user || user.stored === claims.active_company_id) return;
      await tx`
        update auth.users
        set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('active_company_id', ${claims.active_company_id}::text),
            updated_at = now()
        where id = ${claims.sub}`;
      await writeAudit(tx, companySwitchEntry(claims, move.from, move.reason));
    });
  } catch {
    return state;
  }
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) return state;
  return (await readSession(supabase, refreshed.data.session.access_token)) ?? state;
}

/**
 * Reissues the session's token (the hook then picks an active membership) and answers its state when it now stands in
 * a company where the membership is active, the move settled; null when the person has no active membership left (or
 * the refresh fails).
 */
export async function leaveInactiveCompany(supabase: SupabaseClient): Promise<SessionState | null> {
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) return null;
  const state = await readSession(supabase, refreshed.data.session.access_token);
  if (!state?.claims || (await membershipInactive(getServiceDb(), state.claims))) return null;
  return settleCompany(supabase, state);
}
