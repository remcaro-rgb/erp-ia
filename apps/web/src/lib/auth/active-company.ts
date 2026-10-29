"use server";

import { getServiceDb, membershipInactive, ProcessError } from "@erp/kernel";
import { cookies } from "next/headers";
import { serviceSupabase } from "@/lib/supabase/service";
import { createSupabase } from "@/lib/supabase/server";
import { recordCompanySwitch } from "./audit";
import { getCallerClaims, readSession } from "./claims";

/**
 * Moves the session to another company of the user (design §5.1): checks the membership in the current
 * claims and that it is active in the database (a token issued before a deactivation still lists the company, §22.16),
 * stores the choice in `app_metadata.active_company_id` (service role), then refreshes the session
 * so the access token hook issues claims for the new company. Audited as `auth.company.switch`.
 */
export async function setActiveCompany(companyId: string): Promise<void> {
  const claims = await getCallerClaims();
  if (!claims.company_ids.includes(companyId)) {
    throw new ProcessError("forbidden", "the user is not a member of that company");
  }
  if (companyId === claims.active_company_id) return;
  if (await membershipInactive(getServiceDb(), { ...claims, active_company_id: companyId })) {
    throw new ProcessError("forbidden", "the user's membership in that company is inactive");
  }

  const { error } = await serviceSupabase().auth.admin.updateUserById(claims.sub, { app_metadata: { active_company_id: companyId } });
  if (error) throw new ProcessError("handler_failed", "could not store the active company", { cause: error });

  const supabase = createSupabase(await cookies());
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) throw new ProcessError("handler_failed", "could not refresh the session", { cause: refreshed.error });
  const state = await readSession(supabase, refreshed.data.session.access_token);
  if (!state?.claims || state.claims.active_company_id !== companyId) {
    throw new ProcessError("handler_failed", "the refreshed session is not in the requested company");
  }
  await recordCompanySwitch(state.claims, claims.active_company_id);
}
