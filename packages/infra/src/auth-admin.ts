import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The identity provider's admin side (rule 6: the interface, never a provider API in business code): the admin
 * process `kernel.admin.user.create` invites a person by e-mail and finds one who already has an account, and the
 * second-step processes (`kernel.user.mfa.disable`, `kernel.admin.user.mfa.set`) remove a user's factors. The cloud
 * build uses Supabase Auth with the service role; it must only be created and used server-side (rule 12).
 */
export interface AuthAdmin {
  /** Sends the invitation e-mail (the person sets their password from its link) and answers the new user's id. */
  inviteUserByEmail(email: string, profile: { fullName: string }): Promise<{ id: string }>;
  /** The user with this e-mail (any case), or null. */
  getUserByEmail(email: string): Promise<{ id: string } | null>;
  /** Removes every TOTP factor of the user (verified or not) and answers how many were removed (0 without one). */
  deleteFactors(userId: string): Promise<number>;
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

  async deleteFactors(userId: string): Promise<number> {
    const { data, error } = await this.client.auth.admin.mfa.listFactors({ userId });
    if (error || !data) throw new Error(`could not list the factors of ${userId}: ${error?.message ?? "no factors returned"}`);
    let removed = 0;
    for (const factor of data.factors.filter((f) => f.factor_type === "totp")) {
      const { error: failed } = await this.client.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
      if (failed) throw new Error(`could not remove factor ${factor.id} of ${userId}: ${failed.message}`);
      removed++;
    }
    return removed;
  }
}
