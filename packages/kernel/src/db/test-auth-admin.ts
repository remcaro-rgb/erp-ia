import type { Sql } from "postgres";
import type { AuthAdmin } from "@erp/infra";

/**
 * Test double of the identity provider's admin API: an invitation inserts the Auth user straight into `auth.users`
 * (kernel.users references it) and is recorded in `invited`; no e-mail leaves. `cleanup` removes what it created.
 */
export class DbAuthAdmin implements AuthAdmin {
  readonly invited: string[] = [];
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

  /** Deletes the users it invited, with their memberships. */
  async cleanup(): Promise<void> {
    if (this.created.length === 0) return;
    await this.sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = any(${this.created}::uuid[]))`;
    await this.sql`delete from kernel.memberships where user_id = any(${this.created}::uuid[])`;
    await this.sql`delete from kernel.users where id = any(${this.created}::uuid[])`;
    await this.sql`delete from auth.users where id = any(${this.created}::uuid[])`;
  }
}
