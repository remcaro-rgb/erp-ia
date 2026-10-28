import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The identity provider's admin side (rule 6: the interface, never a provider API in business code): the admin
 * process `kernel.admin.user.create` invites a person by e-mail and finds one who already has an account. The cloud
 * build uses Supabase Auth with the service role; it must only be created and used server-side (rule 12).
 */
export interface AuthAdmin {
  /** Sends the invitation e-mail (the person sets their password from its link) and answers the new user's id. */
  inviteUserByEmail(email: string, profile: { fullName: string }): Promise<{ id: string }>;
  /** The user with this e-mail (any case), or null. */
  getUserByEmail(email: string): Promise<{ id: string } | null>;
}

/** Supabase Auth implementation (service-role client). */
export class SupabaseAuthAdmin implements AuthAdmin {
  constructor(
    private readonly client: Pick<SupabaseClient, "auth">,
    /** Users read per page while looking one up by e-mail (the admin API lists, it does not search). */
    private readonly perPage = 1000,
  ) {}

  /** From `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, the server-side environment. */
  static fromEnv(env: Record<string, string | undefined> = process.env): SupabaseAuthAdmin {
    const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SupabaseAuthAdmin needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseAuthAdmin(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  }

  async inviteUserByEmail(email: string, profile: { fullName: string }): Promise<{ id: string }> {
    const { data, error } = await this.client.auth.admin.inviteUserByEmail(email, { data: { full_name: profile.fullName } });
    if (error || !data.user) throw new Error(`could not invite ${email}: ${error?.message ?? "no user returned"}`);
    return { id: data.user.id };
  }

  async getUserByEmail(email: string): Promise<{ id: string } | null> {
    const wanted = email.trim().toLowerCase();
    for (let page = 1; ; page++) {
      const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: this.perPage });
      if (error) throw new Error(`could not look up ${email}: ${error.message}`);
      const found = data.users.find((user) => user.email?.toLowerCase() === wanted);
      if (found) return { id: found.id };
      if (data.users.length < this.perPage) return null;
    }
  }
}
