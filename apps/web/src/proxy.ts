import { NextResponse, type NextRequest } from "next/server";
import { companyMove, mfaStep, readSession, redirectPathFor, type SessionState } from "@/lib/auth/claims";
import { LOCALE_HEADER } from "@/i18n/constants";
import { MFA_DISABLED_LOGIN } from "@/lib/auth/notices";
import { type CookieJar, type CookieOptions } from "@/lib/supabase/cookies";
import { clientIpOf, createSupabase } from "@/lib/supabase/server";

// Next.js 16 `proxy` (the former middleware, Node.js runtime): one gate in front of every route.
//  1. Refreshes the Supabase session (`getClaims` renews an expired access token) and writes the renewed
//     cookies to the response, honouring the "remember me" mode.
//  2. Lets only the sign-in surface through without a session: /login, /mfa/*, /api/auth/* (assets are not matched).
//  3. Holds a session back until its MFA is complete: a verified TOTP factor with aal1 goes to /mfa/verify; a
//     role that requires MFA (hook claim) without a factor goes to /mfa/enroll.
//  3a. Signs out a session whose token still claims a second-step factor the user no longer has (design §22.19).
//  3b. Settles an automatic company move the access token hook made on a renewal (lib/auth/inactive.ts).
//  4. Hands the user's locale to the render as the `x-erp-locale` request header (the i18n layer reads it);
//     a header of that name sent by the client is always discarded, so only a verified claim can set it.
//  5. Refuses a screen whose menu item the company's rules hide for the caller (kernel.menu_access, entity types spec §9.2): the
//     forbidden screen is rendered at the same address (a rewrite to /forbidden, status 403). Pages only; the item's processes, which
//     every API route runs, are refused by runProcess. The decoded path is matched; no request header skips the check.
// API paths answer 401 JSON instead of a redirect. Every handler and page still checks the session itself
// (`requireCaller`): the proxy is the first gate, not the only one.

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
  const supabase = createSupabase(requestJar(request, pending), { clientIp: clientIpOf(request.headers) });
  let state = await readSession(supabase);
  // A renewed token whose company the hook changed (the chosen membership was deactivated, 0027): the move is stored and
  // audited once, and the token reissued, so a later reactivation does not move the session back unseen (design §22.16).
  // One compare of two claims per request; the write only on a move, and never before the second factor.
  if (state && mfaStep(state) === null && companyMove(state)) {
    const { settleCompany } = await import("@/lib/auth/inactive");
    state = await settleCompany(supabase, state);
  }
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const finish = (response: NextResponse): NextResponse => {
    for (const { name, value, options } of pending) response.cookies.set(name, value, options);
    if (pending.length > 0) response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return response;
  };
  const redirectTo = (path: string) => finish(NextResponse.redirect(new URL(path, request.url)));
  const deny = (code: string) => finish(NextResponse.json({ code, details: null }, { status: 401 }));

  // What the render sees: the request with the cookies the refresh just renewed (`request.cookies.set` rewrites
  // its Cookie header) and, once the user is known, their locale.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.delete(LOCALE_HEADER);
    if (state?.claims) headers.set(LOCALE_HEADER, localeOf(state));
    return NextResponse.next({ request: { headers } });
  };

  if (isPublic(pathname)) {
    // A visitor who is fully signed in has no use for the sign-in page.
    if (pathname === "/login" && state?.claims && mfaStep(state) === null) return redirectTo("/");
    return finish(forward());
  }

  if (!state) return isApi ? deny("unauthenticated") : redirectTo(redirectPathFor("no_session"));
  // A token issued before the user's factor was removed (design §22.19): signed out here, the sign-in page says why.
  // Only a token that claims a factor costs the lookup.
  if (state.mfaEnrolled) {
    const { factorRemoved } = await import("@/lib/auth/factor-gone");
    if (await factorRemoved(state)) {
      await supabase.auth.signOut({ scope: "local" });
      return isApi ? deny("unauthenticated") : redirectTo(MFA_DISABLED_LOGIN);
    }
  }
  const step = mfaStep(state);
  if (step === "verify") return isApi ? deny("mfa_required") : redirectTo(redirectPathFor("mfa_required"));
  if (step === "enroll") return isApi ? deny("mfa_enrollment_required") : redirectTo(redirectPathFor("mfa_enrollment_required"));
  if (!state.claims) return isApi ? deny("unauthenticated") : redirectTo(redirectPathFor("no_company"));

  // Every page request is checked, prefetches and RSC requests included: their headers come from the client and could be forged, so
  // none of them skips the guard (review N1).
  if (!isApi && pathname !== FORBIDDEN_PATH) {
    // The rules name decoded addresses: `/r/accounting%2Eaccount/…` is matched as `/r/accounting.account/…`. An address that does not
    // decode is answered with the forbidden screen, without a lookup. One lookup per request at most.
    const decoded = decodePath(pathname);
    const hidden = decoded === null || (await (await import("@/lib/shell/menu-guard")).menuHides(state.claims, decoded));
    if (hidden) {
      const headers = new Headers(request.headers);
      headers.delete(LOCALE_HEADER);
      headers.set(LOCALE_HEADER, localeOf(state));
      return finish(NextResponse.rewrite(new URL(FORBIDDEN_PATH, request.url), { request: { headers }, status: 403 }));
    }
  }

  return finish(forward());
}

/** The forbidden screen, inside the shell: what a hidden menu item's screen answers. */
const FORBIDDEN_PATH = "/forbidden";

/** The pathname with its percent-escapes decoded, or null when it does not decode. */
function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

const localeOf = (state: SessionState) => state.claims?.locale ?? DEFAULT_LOCALE;

export const config = {
  // `.well-known/workflow/` carries the Workflow runtime's own requests (queue deliveries), never a user's; so does
  // `api/internal/` (the outbox tick of Vercel Cron and the Docker worker), which checks its own secret.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/|api/internal/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
