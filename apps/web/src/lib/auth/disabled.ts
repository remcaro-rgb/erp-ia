import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isMembershipInactive } from "@erp/kernel";
import { logout } from "./login";

// A session whose membership the admin deactivated (kernel.admin.user.update, design §22.16) ends at the first thing it
// tries: runProcess refuses it (`forbidden`, reason membership_inactive) and the server action that ran it signs the
// session out and sends the browser to the sign-in page, which says "Cuenta desactivada. Contacta a un administrador.".
// A page render cannot change cookies: the layout sends it through GET /api/auth/disabled instead (`redirectPathFor`).

/** Where a deactivated session lands: the sign-in page with the reason. */
export const ACCOUNT_DISABLED_LOGIN = "/login?error=account_disabled";

/** In a server action's catch: signs the session out and redirects when `error` is the refusal of an inactive membership. */
export async function signOutIfDisabled(error: unknown): Promise<void> {
  if (!isMembershipInactive(error)) return;
  await logout(await cookies());
  redirect(ACCOUNT_DISABLED_LOGIN);
}
