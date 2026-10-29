import { getServiceDb, MEMBERSHIP_INACTIVE, membershipInactive, type Caller } from "@erp/kernel";
import { requireCaller, Unauthenticated } from "./claims";

/** The 401 answer of a route handler for a request with no usable session. */
export function unauthenticatedResponse(error: Unauthenticated): Response {
  return Response.json({ code: error.reason === "mfa_required" || error.reason === "mfa_enrollment_required" ? error.reason : "unauthenticated", details: null }, { status: 401 });
}

/** The caller of this request, or the 401 response to return (`if (caller instanceof Response) return caller`). */
export async function callerOrResponse(): Promise<Caller | Response> {
  try {
    return await requireCaller();
  } catch (error) {
    if (error instanceof Unauthenticated) return unauthenticatedResponse(error);
    throw error;
  }
}

/**
 * The 403 answer for a session whose membership in its active company the admin deactivated (design §22.16): the same
 * body runProcess's gate refusal gets (`forbidden`, `details.reason` MEMBERSHIP_INACTIVE), so a client follows the
 * disabled path (GET /api/auth/disabled) whichever of the two refused it.
 */
export function membershipInactiveResponse(): Response {
  return Response.json({ code: "forbidden", details: { reason: MEMBERSHIP_INACTIVE } }, { status: 403 });
}

/**
 * Like `callerOrResponse`, and also refuses (403, `membershipInactiveResponse`) a caller whose membership in the active
 * company is inactive, through the same kernel check runProcess's gate makes. For the routes that write or call a model
 * without a process run (the assistant's: rule 17, design §22.16): call it before anything else.
 */
export async function activeCallerOrResponse(): Promise<Caller | Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  if (await membershipInactive(getServiceDb(), caller.claims)) return membershipInactiveResponse();
  return caller;
}
