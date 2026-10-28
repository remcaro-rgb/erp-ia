// Cookie rules of the session (design §6, "remember me"). The Supabase session lives in cookies written
// by `@supabase/ssr`, which always stamps them with a 400-day Max-Age. The user decides at sign-in:
// not remembered -> a session cookie (no Max-Age, gone when the browser closes); remembered -> 30 days.
// The decision is kept in the `erp.remember` cookie so every later refresh of the session (proxy, route
// handlers, server actions) writes the cookies the same way.

/** The cookie operations the app needs; Next's `cookies()` and `NextRequest.cookies` satisfy them. */
export interface CookieReader {
  get(name: string): { name?: string; value: string } | undefined;
}

export interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  expires?: Date;
}

export interface CookieJar extends CookieReader {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string): void;
}

/** `1` while the user chose "Recordarme en este dispositivo"; absent otherwise. */
export const REMEMBER_COOKIE = "erp.remember";
/** The e-mail to prefill on the sign-in form of a remembered device. */
export const REMEMBER_EMAIL_COOKIE = "erp.remember_email";
export const REMEMBER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function rememberMode(jar: CookieReader): boolean {
  return jar.get(REMEMBER_COOKIE)?.value === "1";
}

/** Options for a Supabase session cookie under the chosen mode. A removal (Max-Age 0) stays a removal. */
export function sessionCookieOptions(options: CookieOptions, remember: boolean): CookieOptions {
  const rest = { ...options };
  delete rest.maxAge;
  delete rest.expires;
  // httpOnly: the browser never reads the session (no browser Supabase client); only the server does.
  const base = { ...rest, httpOnly: true, ...(process.env.NODE_ENV === "production" ? { secure: true } : {}) };
  if (options.maxAge === 0) return { ...base, maxAge: 0 };
  return remember ? { ...base, maxAge: REMEMBER_MAX_AGE_SECONDS } : base;
}

/** Options for the app's own remember cookies: server-only, 30 days. */
export function rememberCookieOptions(): CookieOptions {
  return { path: "/", httpOnly: true, sameSite: "lax", maxAge: REMEMBER_MAX_AGE_SECONDS, ...(process.env.NODE_ENV === "production" ? { secure: true } : {}) };
}

/** Writes or clears the two remember cookies after a successful password sign-in. */
export function setRememberCookies(jar: CookieJar, remember: boolean, email: string): void {
  if (remember) {
    jar.set(REMEMBER_COOKIE, "1", rememberCookieOptions());
    jar.set(REMEMBER_EMAIL_COOKIE, email, rememberCookieOptions());
  } else {
    jar.delete(REMEMBER_COOKIE);
    jar.delete(REMEMBER_EMAIL_COOKIE);
  }
}
