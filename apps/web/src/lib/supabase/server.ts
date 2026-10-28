import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { publicSupabaseEnv } from "./env";
import { rememberMode, sessionCookieOptions, type CookieJar } from "./cookies";

/**
 * A Supabase client bound to the session cookies of `jar`. Every cookie it writes follows the remember
 * mode (explicit at sign-in, otherwise read from the jar). Where cookies cannot be written (a Server
 * Component render) the write is skipped: the proxy has already refreshed the session for the request.
 */
export function createSupabase(jar: CookieJar, options: { remember?: boolean } = {}): SupabaseClient {
  const { url, anonKey } = publicSupabaseEnv();
  const remember = options.remember ?? rememberMode(jar);
  return createServerClient(url, anonKey, {
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
  return createSupabase(await cookies(), options);
}
