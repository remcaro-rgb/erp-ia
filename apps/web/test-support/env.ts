// Local Supabase defaults (`supabase start`): the keys below are the public demo keys every local
// stack ships with, not secrets. Tests read the real environment first and fall back to them.
export const LOCAL_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
} as const;

/** The environment the app and the tests run with: the process environment over the local defaults. */
export function testEnv(): Record<keyof typeof LOCAL_ENV, string> {
  const env = {} as Record<keyof typeof LOCAL_ENV, string>;
  for (const key of Object.keys(LOCAL_ENV) as (keyof typeof LOCAL_ENV)[]) env[key] = process.env[key] ?? LOCAL_ENV[key];
  return env;
}

/** Fills the missing variables of this process from the local defaults (vitest setup). */
export function applyLocalEnv(): void {
  Object.assign(process.env, testEnv());
}
