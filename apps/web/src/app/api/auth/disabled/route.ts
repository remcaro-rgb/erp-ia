import { NextResponse } from "next/server";
import { getServiceDb, membershipInactive } from "@erp/kernel";
import { getSessionState } from "@/lib/auth/claims";
import { leaveDisabledCompany } from "@/lib/auth/disabled";

// GET /api/auth/disabled: where a page render sends a session whose membership in its active company the admin
// deactivated (design §22.16). A render cannot change cookies; this handler can: it moves the session to another company
// where the person is still active, or, with none left, signs it out and opens the sign-in page with the reason. It acts
// only on a session that really stands in an inactive membership (a link to it changes nobody else's session); anyone
// else goes home.
export async function GET(request: Request): Promise<Response> {
  const state = await getSessionState();
  const inactive = state?.claims ? await membershipInactive(getServiceDb(), state.claims) : false;
  return NextResponse.redirect(new URL(inactive ? await leaveDisabledCompany() : "/", request.url), 303);
}
