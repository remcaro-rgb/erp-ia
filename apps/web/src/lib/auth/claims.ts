import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Caller, JwtClaims } from "@erp/kernel";
import { serverSupabase } from "@/lib/supabase/server";

// The session as the server sees it (design §5.1, §6): the claims the access token hook put in the JWT,
// verified by Supabase Auth. `getCallerClaims()` / `requireCaller()` are the only way route handlers and
// pages learn who is calling; they refuse a session that has not completed the MFA the account demands.

export type UnauthenticatedReason = "no_session" | "no_company" | "mfa_required" | "mfa_enrollment_required" | "account_disabled";

/** No usable session for this request. Route handlers map it to 401, pages to a redirect (`redirectPathFor`). */
export class Unauthenticated extends Error {
  readonly reason: UnauthenticatedReason;
  constructor(reason: UnauthenticatedReason) {
    super(`unauthenticated: ${reason}`);
    this.name = "Unauthenticated";
    this.reason = reason;
  }
}

/** Where an unauthenticated visitor goes to fix it. */
export function redirectPathFor(reason: UnauthenticatedReason): string {
  switch (reason) {
    case "mfa_required":
      return "/mfa/verify";
    case "mfa_enrollment_required":
      return "/mfa/enroll";
    case "no_company":
      return "/login?error=no_company";
    // The admin deactivated the membership (design §22.16): signed out by the route, then the sign-in page says why.
    case "account_disabled":
      return "/api/auth/disabled";
    default:
      return "/login";
  }
}

export interface SessionState {
  /** The authenticated user, also when they belong to no company. */
  userId: string;
  /** The kernel claims, or null for a signed-in user who belongs to no company. */
  claims: JwtClaims | null;
  aal: "aal1" | "aal2";
  /** One of the user's roles in the active company requires two-step verification (hook claim). */
  requiresMfa: boolean;
  /** The user has a verified TOTP factor (hook claim; read from the auth schema, not from the client). */
  mfaEnrolled: boolean;
  /** The company the user last chose (`app_metadata.active_company_id` when the token was issued), or null. */
  storedCompanyId: string | null;
  /** The company the hook passed over because the membership there is inactive (0027), or null. */
  inactiveCompanyId: string | null;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The session state in a verified JWT payload, or null when it has no subject. */
export function sessionStateOf(raw: Record<string, unknown>): SessionState | null {
  const { sub, tenant_id, company_ids, active_company_id, role_ids, locale, aal, requires_mfa, mfa_enrolled } = raw;
  if (typeof sub !== "string") return null;
  const hasCompany = typeof tenant_id === "string" && typeof active_company_id === "string" && strings(company_ids) && strings(role_ids);
  return {
    userId: sub,
    claims: hasCompany
      ? { sub, tenant_id, company_ids, active_company_id, role_ids, locale: typeof locale === "string" ? locale : "es-419" }
      : null,
    aal: aal === "aal2" ? "aal2" : "aal1",
    requiresMfa: requires_mfa === true,
    mfaEnrolled: mfa_enrolled === true,
    storedCompanyId: stringOrNull((raw.app_metadata as { active_company_id?: unknown } | undefined)?.active_company_id),
    inactiveCompanyId: stringOrNull(raw.inactive_company_id),
  };
}

/**
 * Why the session changed company without the user asking (design §22.16): `membership_inactive` when the membership in
 * the company the user had chosen (or stood in first) was deactivated, `membership_missing` when that company is no longer
 * one of theirs.
 */
export type CompanySwitchReason = "membership_inactive" | "membership_missing";

/**
 * The automatic company move a verified token carries, or null: the token's company differs from the one the user chose
 * because the access token hook passed over an inactive membership (0027), or the chosen one is gone. Pure: one compare
 * of claims, so the proxy can ask on every request.
 */
export function companyMove(state: SessionState): { from: string; reason: CompanySwitchReason } | null {
  if (!state.claims) return null;
  if (state.inactiveCompanyId) return { from: state.inactiveCompanyId, reason: "membership_inactive" };
  if (state.storedCompanyId && state.storedCompanyId !== state.claims.active_company_id) return { from: state.storedCompanyId, reason: "membership_missing" };
  return null;
}

/** The MFA page this session must pass through before it may use the app, or null when it is complete. */
export function mfaStep(state: Pick<SessionState, "aal" | "requiresMfa" | "mfaEnrolled">): "verify" | "enroll" | null {
  if (state.mfaEnrolled && state.aal !== "aal2") return "verify";
  if (!state.mfaEnrolled && state.requiresMfa) return "enroll";
  return null;
}

/**
 * The session of `supabase`, with its JWT verified by Supabase Auth (`getClaims`), or null without one.
 * Pass `jwt` to read a token that was just issued (sign-in, MFA verification) before its cookies exist.
 */
export async function readSession(supabase: SupabaseClient, jwt?: string): Promise<SessionState | null> {
  const { data, error } = await supabase.auth.getClaims(jwt);
  if (error || !data) return null;
  return sessionStateOf(data.claims as Record<string, unknown>);
}

/** The session of this request, whatever its MFA progress (for the sign-in pages), or null. */
export async function getSessionState(): Promise<SessionState | null> {
  return readSession(await serverSupabase());
}

/** Throws `Unauthenticated` unless the session is complete: signed in, in a company, MFA done. */
export function assertComplete(state: SessionState | null): JwtClaims {
  if (!state) throw new Unauthenticated("no_session");
  const step = mfaStep(state);
  if (step === "verify") throw new Unauthenticated("mfa_required");
  if (step === "enroll") throw new Unauthenticated("mfa_enrollment_required");
  if (!state.claims) throw new Unauthenticated("no_company");
  return state.claims;
}

/** The claims of the calling user for this request. Throws `Unauthenticated`. */
export async function getCallerClaims(): Promise<JwtClaims> {
  return assertComplete(await getSessionState());
}

/** The caller of this request as the kernel needs it (origin `ui`). Throws `Unauthenticated`. */
export async function requireCaller(): Promise<Caller> {
  return { claims: await getCallerClaims(), origin: "ui" };
}
