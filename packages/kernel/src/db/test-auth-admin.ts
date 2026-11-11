import type { Sql } from "postgres";
import type { AuthAdmin } from "@erp/infra";
import { revokeUserSessions } from "../users/sessions";

/**
 * Test double of the identity provider's admin API: an invitation inserts the Auth user straight into `auth.users`
 * (kernel.users references it) and is recorded in `invited`; no e-mail leaves. Removing a user's factors deletes their
 * TOTP rows of `auth.mfa_factors` (what the access-token hook reads) and records the user in `deletedFactorsOf`; ending
 * their sessions deletes their rows of `auth.refresh_tokens` and `auth.sessions` and records them in `signedOut`.
 * `cleanup` removes what it created.
 */
export class DbAuthAdmin implements AuthAdmin {
  readonly invited: string[] = [];
  /** The users whose factors were removed, one entry per call. */
  readonly deletedFactorsOf: string[] = [];
  /** The users whose sessions were ended, one entry per call. */
  readonly signedOut: string[] = [];
  private readonly created: string[] = [];

  constructor(private readonly sql: Sql) {}

  async inviteUserByEmail(email: string): Promise<{ id: string }> {
    const [row] = await this.sql<{ id: string }[]>`
      insert into auth.users (id, email, encrypted_password, raw_app_meta_data, invited_at)
      values (gen_random_uuid(), ${email}, '', '{}'::jsonb, now()) returning id`;
    this.invited.push(email);
    this.created.push(row!.id);
    return { id: row!.id };
  }

  async getUserByEmail(email: string): Promise<{ id: string } | null> {
    const [row] = await this.sql<{ id: string }[]>`select id from auth.users where lower(email) = lower(${email}) limit 1`;
    return row ? { id: row.id } : null;
  }

  async deleteFactors(userId: string): Promise<number> {
    const removed = await this.sql`delete from auth.mfa_factors where user_id = ${userId} and factor_type = 'totp' returning id`;
    this.deletedFactorsOf.push(userId);
    return removed.length;
  }

  /** The passwords set, by user id (the last one wins), for the tests to read; `verifyPassword` checks against them. */
  readonly passwords = new Map<string, string>();

  async setPassword(userId: string, password: string): Promise<void> {
    this.passwords.set(userId, password);
  }

  async verifyPassword(email: string, password: string): Promise<boolean> {
    const [row] = await this.sql<{ id: string }[]>`select id from auth.users where lower(email) = lower(${email}) limit 1`;
    return row !== undefined && this.passwords.get(row.id) === password;
  }

  /** Ends the user's sessions as the server does (the kernel's `revokeUserSessions`) and records the call. */
  async signOutUser(userId: string): Promise<void> {
    await revokeUserSessions(this.sql, userId);
    this.signedOut.push(userId);
  }

  /** Deletes the users it invited, with their memberships. */
  async cleanup(): Promise<void> {
    if (this.created.length === 0) return;
    await this.sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = any(${this.created}::uuid[]))`;
    await this.sql`delete from kernel.memberships where user_id = any(${this.created}::uuid[])`;
    await this.sql`delete from kernel.users where id = any(${this.created}::uuid[])`;
    await this.sql`delete from auth.users where id = any(${this.created}::uuid[])`;
  }
}
