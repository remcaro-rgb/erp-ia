import postgres, { type Sql, type TransactionSql } from "postgres";

/** Claims the custom access token hook puts in every session JWT (design §5.1). */
export type JwtClaims = {
  sub: string;
  tenant_id: string;
  company_ids: string[];
  active_company_id: string;
  role_ids: string[];
  locale: string;
};

/** `prepare: false` keeps the client compatible with the Supabase transaction pooler. */
export function createDb(url: string): Sql {
  return postgres(url, { prepare: false, max: 5 });
}

/**
 * Runs `fn` in a transaction as the `authenticated` role with `claims` as the request JWT, so
 * `auth.uid()` and the `kernel.current_*` helpers see them and RLS applies exactly as for a user.
 */
export async function withClaims<T>(sql: Sql, claims: JwtClaims, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  });
  return result as T;
}
