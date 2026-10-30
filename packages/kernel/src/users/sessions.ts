import type { Sql } from "postgres";

// The sessions of a user in Supabase Auth's own store (design §22.19, owner decision 2026-10-30). Removing a factor only
// downgrades the user's sessions to aal1, and the Auth admin API signs out by JWT, never by user id: the second-step
// processes end the sessions here, over the service connection (the same one the web app's session gates use), through
// the AuthAdmin adapter's `signOutUser`.

/**
 * Ends every session of the user: the refresh tokens first, then the sessions (the tokens also cascade with them), in
 * one transaction. A refresh then fails at once; an access token already issued stays signed until it expires
 * (`jwt_expiry`, 10 minutes), and the web app's gate refuses one that still claims a factor the user no longer has.
 */
export async function revokeUserSessions(sql: Sql, userId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from auth.refresh_tokens where user_id = ${userId}`;
    await tx`delete from auth.sessions where user_id = ${userId}`;
  });
}

/** Whether the user has a verified TOTP factor right now (the identity provider's store, service connection). */
export async function hasVerifiedFactor(sql: Sql, userId: string): Promise<boolean> {
  const [row] = await sql<{ enrolled: boolean }[]>`
    select exists (select 1 from auth.mfa_factors where user_id = ${userId} and factor_type = 'totp' and status = 'verified') as enrolled`;
  return row?.enrolled === true;
}
