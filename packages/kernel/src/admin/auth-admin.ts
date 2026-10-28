import type { AuthAdmin } from "@erp/infra";

// The identity provider's admin API kernel.admin.user.create invites people through (rule 6: the interface, never a
// provider API): Supabase Auth from the server environment (service role) unless something else was installed (a
// test's fake, the Docker build's provider). Kept on globalThis like the file store: a bundle may load this module twice.

const GLOBAL_KEY = Symbol.for("erp.kernel.authAdmin");
const globals = globalThis as { [GLOBAL_KEY]?: AuthAdmin };

/** Installs the adapter kernel code uses; `undefined` goes back to the default. */
export function setAuthAdmin(adapter: AuthAdmin | undefined): void {
  globals[GLOBAL_KEY] = adapter;
}

/** The installed adapter, or Supabase Auth from `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (server side only). */
export async function authAdmin(): Promise<AuthAdmin> {
  const installed = globals[GLOBAL_KEY];
  if (installed) return installed;
  const { SupabaseAuthAdmin } = await import("@erp/infra");
  return (globals[GLOBAL_KEY] ??= SupabaseAuthAdmin.fromEnv());
}
