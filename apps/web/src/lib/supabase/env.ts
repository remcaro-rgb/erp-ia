import "server-only";

// Supabase connection settings from the environment (`apps/web/.env.example` lists them).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The public URL and anon key, the only ones a user-session client may hold. */
export function publicSupabaseEnv() {
  return { url: required("NEXT_PUBLIC_SUPABASE_URL"), anonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY") };
}

/** URL and service-role key, for the admin API; server-only (rule 12). */
export function serviceSupabaseEnv() {
  return { url: required("NEXT_PUBLIC_SUPABASE_URL"), serviceKey: required("SUPABASE_SERVICE_ROLE_KEY") };
}
