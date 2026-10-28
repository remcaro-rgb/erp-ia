import { createServerClient } from "@supabase/ssr";
import type { Caller, JwtClaims } from "@erp/kernel";
import { cookies } from "next/headers";

// Minimal session -> Caller bridge for the first route handlers. Task 10 replaces it with requireCaller().

/** The claims the access token hook puts in every session JWT (design §5.1), or null when any is missing. */
function claimsOf(raw: Record<string, unknown>): JwtClaims | null {
  const { sub, tenant_id, company_ids, active_company_id, role_ids, locale } = raw;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
  if (typeof sub !== "string" || typeof tenant_id !== "string" || typeof active_company_id !== "string") return null;
  if (!strings(company_ids) || !strings(role_ids)) return null;
  return { sub, tenant_id, company_ids, active_company_id, role_ids, locale: typeof locale === "string" ? locale : "es-419" };
}

/**
 * The caller of this request, from the Supabase session cookie, or null without a valid session. The
 * JWT is verified by Supabase Auth (`getClaims`), never trusted as read from the cookie.
 */
export async function sessionCaller(): Promise<Caller | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  const cookieStore = await cookies();
  const supabase = createServerClient(url, anonKey, {
    // A route handler that only reads the session never writes cookies back.
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  const claims = claimsOf(data.claims);
  return claims ? { claims, origin: "ui" } : null;
}
