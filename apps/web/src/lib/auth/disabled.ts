import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isMembershipInactive } from "@erp/kernel";
import { createSupabase } from "@/lib/supabase/server";
import { getSessionState } from "./claims";
import { leaveInactiveCompany } from "./inactive";
import { logout } from "./login";

// A session whose membership the admin deactivated (kernel.admin.user.update, design §22.16) ends at the first thing it
// tries: runProcess refuses it (`forbidden`, reason membership_inactive) and the server action that ran it moves the
// session to another company where the person is still active (and goes home), or, with none left, signs it out and
// sends the browser to the sign-in page, which says "Cuenta desactivada. Contacta a un administrador.".
// A page render cannot change cookies: the layout sends it through GET /api/auth/disabled instead (`redirectPathFor`).

/** Where a deactivated session lands: the sign-in page with the reason. */
export const ACCOUNT_DISABLED_LOGIN = "/login?error=account_disabled";

/**
 * Where a session whose active company's membership is inactive goes: home, moved into another company where the person
 * is active; or, with none left, signed out to the sign-in page with the reason. Needs writable cookies (an action, a
 * route handler).
 */
export async function leaveDisabledCompany(): Promise<string> {
  const jar = await cookies();
  const state = await getSessionState();
  if (state?.claims && (await leaveInactiveCompany(createSupabase(jar)))) return "/";
  await logout(jar);
  return ACCOUNT_DISABLED_LOGIN;
}

/** In a server action's catch: when `error` is the refusal of an inactive membership, leaves that company and redirects. */
export async function signOutIfDisabled(error: unknown): Promise<void> {
  if (!isMembershipInactive(error)) return;
  redirect(await leaveDisabledCompany());
}
