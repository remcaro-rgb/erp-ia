import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serviceSupabaseEnv } from "./env";

/** The Auth admin API (service role). Server-side only, never in the browser (rule 12). */
export function serviceSupabase(): SupabaseClient {
  const { url, serviceKey } = serviceSupabaseEnv();
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
