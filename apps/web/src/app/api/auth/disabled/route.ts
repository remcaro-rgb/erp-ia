import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getServiceDb, membershipInactive } from "@erp/kernel";
import { getSessionState } from "@/lib/auth/claims";
import { ACCOUNT_DISABLED_LOGIN } from "@/lib/auth/disabled";
import { logout } from "@/lib/auth/login";

// GET /api/auth/disabled: where a page render sends a session whose membership the admin deactivated (design §22.16).
// A render cannot clear cookies; this handler can: it signs the session out and opens the sign-in page with the reason.
// It acts only on a session that really is deactivated (a link to it signs nobody else out); anyone else goes home.
export async function GET(request: Request): Promise<Response> {
  const state = await getSessionState();
  if (state?.claims && (await membershipInactive(getServiceDb(), state.claims))) {
    await logout(await cookies());
    return NextResponse.redirect(new URL(ACCOUNT_DISABLED_LOGIN, request.url), 303);
  }
  return NextResponse.redirect(new URL("/", request.url), 303);
}
