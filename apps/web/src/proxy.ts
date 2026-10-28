import { NextResponse, type NextRequest } from "next/server";
import { mfaStep, readSession, redirectPathFor, type SessionState } from "@/lib/auth/claims";
import { type CookieJar, type CookieOptions } from "@/lib/supabase/cookies";
import { createSupabase } from "@/lib/supabase/server";

// Next.js 16 `proxy` (the former middleware, Node.js runtime): one gate in front of every route.
//  1. Refreshes the Supabase session (`getClaims` renews an expired access token) and writes the renewed
//     cookies to the response, honouring the "remember me" mode.
//  2. Lets only the sign-in surface through without a session: /login, /mfa/*, /api/auth/* (assets are not matched).
//  3. Holds a session back until its MFA is complete: a verified TOTP factor with aal1 goes to /mfa/verify; a
//     role that requires MFA (hook claim) without a factor goes to /mfa/enroll.
//  4. Hands the user's locale to the render as the `x-erp-locale` request header (the i18n layer reads it).
// API paths answer 401 JSON instead of a redirect. Every handler and page still checks the session itself
// (`requireCaller`): the proxy is the first gate, not the only one.

export const LOCALE_HEADER = "x-erp-locale";
const DEFAULT_LOCALE = "es-419";

const isPublic = (path: string) => path === "/login" || path === "/mfa" || path.startsWith("/mfa/") || path.startsWith("/api/auth/");

interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

/** The cookie jar of this request: reads see the writes of the session refresh, and the writes are kept for the response. */
function requestJar(request: NextRequest, pending: PendingCookie[]): CookieJar {
  const set = (name: string, value: string, options: CookieOptions = {}) => {
    request.cookies.set(name, value);
    pending.push({ name, value, options });
  };
  return {
    getAll: () => request.cookies.getAll(),
    get: (name) => request.cookies.get(name),
    set,
    delete: (name) => set(name, "", { maxAge: 0 }),
  };
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const pending: PendingCookie[] = [];
  const state = await readSession(createSupabase(requestJar(request, pending)));
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const finish = (response: NextResponse): NextResponse => {
    for (const { name, value, options } of pending) response.cookies.set(name, value, options);
    if (pending.length > 0) response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return response;
  };
  const redirectTo = (path: string) => finish(NextResponse.redirect(new URL(path, request.url)));
  const deny = (code: string) => finish(NextResponse.json({ code, details: null }, { status: 401 }));

  if (isPublic(pathname)) {
    // A visitor who is fully signed in has no use for the sign-in page.
    if (pathname === "/login" && state?.claims && mfaStep(state) === null) return redirectTo("/");
    return finish(NextResponse.next());
  }

  if (!state) return isApi ? deny("unauthenticated") : redirectTo(redirectPathFor("no_session"));
  const step = mfaStep(state);
  if (step === "verify") return isApi ? deny("mfa_required") : redirectTo(redirectPathFor("mfa_required"));
  if (step === "enroll") return isApi ? deny("mfa_enrollment_required") : redirectTo(redirectPathFor("mfa_enrollment_required"));
  if (!state.claims) return isApi ? deny("unauthenticated") : redirectTo(redirectPathFor("no_company"));

  const headers = new Headers(request.headers);
  headers.set(LOCALE_HEADER, localeOf(state));
  return finish(NextResponse.next({ request: { headers } }));
}

const localeOf = (state: SessionState) => state.claims?.locale ?? DEFAULT_LOCALE;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
