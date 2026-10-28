import type { SupabaseClient } from "@supabase/supabase-js";
import { setRememberCookies, rememberMode, type CookieJar } from "@/lib/supabase/cookies";
import { createSupabase } from "@/lib/supabase/server";
import { recordLogin } from "./audit";
import { mfaStep, readSession, type SessionState } from "./claims";

// The sign-in sequence (design §6): e-mail + password, then the TOTP step the account demands. Each step
// answers where the browser goes next; the server actions only turn that into a redirect.

export type LoginError = "invalid_credentials" | "no_company" | "invalid_code" | "no_session" | "no_factor" | "mfa_required" | "unavailable";
export type StepResult<T = object> = ({ ok: true } & T) | { ok: false; error: LoginError };
export type Next = "/" | "/mfa/verify" | "/mfa/enroll";

const HOME = "/";

/** E-mail + password. A session is created at once; whether it is complete depends on the account's MFA. */
export async function loginWithPassword(jar: CookieJar, input: { email: string; password: string; remember: boolean }): Promise<StepResult<{ next: Next }>> {
  const email = input.email.trim().toLowerCase();
  const supabase = createSupabase(jar, { remember: input.remember });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: input.password });
  if (error || !data.session) return { ok: false, error: error?.status && error.status >= 500 ? "unavailable" : "invalid_credentials" };

  setRememberCookies(jar, input.remember, email);
  const state = await readSession(supabase, data.session.access_token);
  if (!state?.claims) {
    await supabase.auth.signOut();
    return { ok: false, error: "no_company" };
  }
  const step = mfaStep(state);
  if (step === "verify") return { ok: true, next: "/mfa/verify" };
  if (step === "enroll") return { ok: true, next: "/mfa/enroll" };
  await recordLogin(state.claims, { remember: input.remember, mfa: "none" });
  return { ok: true, next: HOME };
}

/** The user's verified TOTP factor, if any. */
async function verifiedTotpFactor(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return null;
  return data.totp[0]?.id ?? null;
}

/** Closes the login with a code check: upgrades the session to aal2 and records the sign-in. */
async function verifyCode(jar: CookieJar, supabase: SupabaseClient, factorId: string, code: string): Promise<StepResult<{ next: Next }>> {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error || !data) return { ok: false, error: error?.status && error.status >= 500 ? "unavailable" : "invalid_code" };
  const state: SessionState | null = await readSession(supabase, data.access_token);
  if (!state?.claims) return { ok: false, error: "no_company" };
  await recordLogin(state.claims, { remember: rememberMode(jar), mfa: "totp" });
  return { ok: true, next: HOME };
}

/** The second step of a sign-in for an account with a verified TOTP factor. */
export async function completeMfa(jar: CookieJar, input: { code: string }): Promise<StepResult<{ next: Next }>> {
  const supabase = createSupabase(jar);
  if (!(await readSession(supabase))) return { ok: false, error: "no_session" };
  const factorId = await verifiedTotpFactor(supabase);
  if (!factorId) return { ok: false, error: "no_factor" };
  return verifyCode(jar, supabase, factorId, input.code);
}

export interface Enrolment {
  factorId: string;
  /** `data:` URL of the QR image to scan with an authenticator app. */
  qrCode: string;
  /** The same key as text, to type by hand. */
  secret: string;
}

/**
 * Starts the enrolment of a TOTP factor for the signed-in user. Unfinished attempts of an earlier visit are
 * removed first, so a reload never piles up factors.
 */
export async function startEnrolment(jar: CookieJar): Promise<StepResult<Enrolment>> {
  const supabase = createSupabase(jar);
  if (!(await readSession(supabase))) return { ok: false, error: "no_session" };
  const { data: factors } = await supabase.auth.mfa.listFactors();
  // First enrolment only: an account that has a factor proves it (/mfa/verify) before changing its second step.
  if (factors?.totp.length) return { ok: false, error: "mfa_required" };
  for (const factor of factors?.all ?? []) {
    if (factor.factor_type === "totp" && factor.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "ERP-IA", friendlyName: `ERP-IA ${new Date().toISOString()}` });
  if (error || !data) return { ok: false, error: "unavailable" };
  const qr = data.totp.qr_code;
  return { ok: true, factorId: data.id, qrCode: qr.startsWith("data:") ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`, secret: data.totp.secret };
}

/** Finishes the enrolment with the first code from the app; that also completes the sign-in. */
export async function confirmEnrolment(jar: CookieJar, input: { factorId: string; code: string }): Promise<StepResult<{ next: Next }>> {
  const supabase = createSupabase(jar);
  if (!(await readSession(supabase))) return { ok: false, error: "no_session" };
  return verifyCode(jar, supabase, input.factorId, input.code);
}

/** Ends the session. */
export async function logout(jar: CookieJar): Promise<void> {
  await createSupabase(jar).auth.signOut({ scope: "local" });
}
