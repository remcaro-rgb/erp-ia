/** How a failed call to Supabase Auth should be reported to the user. */
export type AuthFailure = "rate_limited" | "unavailable" | "rejected";

interface AuthErrorLike {
  status?: number;
  code?: string;
}

/**
 * 429 (or an `over_*_rate_limit` code) is Auth's own rate limit, not a wrong password or code; 5xx is the
 * service being down; anything else is the credentials or code being refused.
 */
export function authFailureOf(error: AuthErrorLike): AuthFailure {
  if (error.status === 429 || (typeof error.code === "string" && error.code.startsWith("over_") && error.code.endsWith("_rate_limit"))) return "rate_limited";
  if (error.status !== undefined && error.status >= 500) return "unavailable";
  return "rejected";
}
