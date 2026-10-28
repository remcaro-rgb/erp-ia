import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { publicSupabaseEnv } from "./env";
import { rememberMode, sessionCookieOptions, type CookieJar } from "./cookies";

/**
 * A Supabase client bound to the session cookies of `jar`. Every cookie it writes follows the remember
 * mode (explicit at sign-in, otherwise read from the jar). Where cookies cannot be written (a Server
 * Component render) the write is skipped: the proxy has already refreshed the session for the request.
 */
export function createSupabase(jar: CookieJar, options: { remember?: boolean; clientIp?: string } = {}): SupabaseClient {
  const { url, anonKey } = publicSupabaseEnv();
  const remember = options.remember ?? rememberMode(jar);
  return createServerClient(url, anonKey, {
    // Auth rate-limits per IP and would otherwise see only this server's: tell it who is really calling.
    // `X-Forwarded-For` is what self-hosted Auth reads, `sb-forwarded-for` what hosted Supabase reads.
    ...(options.clientIp ? { global: { headers: { "X-Forwarded-For": options.clientIp, "sb-forwarded-for": options.clientIp } } } : {}),
    cookies: {
      getAll: () => jar.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options: cookieOptions } of list) jar.set(name, value, sessionCookieOptions(cookieOptions ?? {}, remember));
        } catch {
          // Read-only cookie store (Server Component).
        }
      },
    },
  });
}

/** The client for the current request, over Next's cookie store. */
export async function serverSupabase(options: { remember?: boolean } = {}): Promise<SupabaseClient> {
  return createSupabase(await cookies(), { ...options, clientIp: await requestClientIp() });
}

/**
 * The address of the person behind this request: the first hop of `X-Forwarded-For` (set by the platform proxy;
 * a self-hosted deployment must put a proxy in front that sets it), else `X-Real-IP`.
 */
export function clientIpOf(source: Pick<Headers, "get">): string | undefined {
  const forwarded = source.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || source.get("x-real-ip")?.trim() || undefined;
}

export async function requestClientIp(): Promise<string | undefined> {
  return clientIpOf(await headers());
}
