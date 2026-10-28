import type { Caller } from "@erp/kernel";
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
