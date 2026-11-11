import postgres, { type Sql, type TransactionSql } from "postgres";
import { ProcessError } from "../process/errors";

/** The transaction handle processes and kernel helpers receive from `withClaims` / `sql.begin`. */
export type Tx = TransactionSql;

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
  // DB_TRACE=1 logs every statement with its start time, to see the order and the round trips of a request (a diagnosis, not a feature).
  const trace = process.env.DB_TRACE === "1";
  return postgres(url, {
    prepare: false,
    // DB_POOL_MAX overrides it (12 was tried on the hosted project and was no faster).
    max: Number(process.env.DB_POOL_MAX) > 0 ? Number(process.env.DB_POOL_MAX) : 5,
    ...(trace ? { debug: (connection: number, query: string) => console.log(`SQLTRACE ${Date.now()} c${connection} ${query.replace(/\s+/g, " ").slice(0, 90)}`) } : {}),
  });
}

/** Actor of every process an event consumer or a scheduled check runs; audit rows of `event` origin carry it (re-exported by events/consumers). */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Whether `sub` names the kernel's system user in any spelling Postgres reads as the nil uuid (`uuid_in` accepts braces, no hyphens, a
 * hyphen after any group of four digits, either case): the database sees the claim through `(sub)::uuid`, so the guards compare the
 * same way (plan 2B Task 52.3, fix round 1, review I-1).
 */
export function isSystemSub(sub: string): boolean {
  return sub.replace(/[{}-]/g, "").toLowerCase() === "0".repeat(32);
}

/** `details.reason` of the refusal of the system user's claims where they are not allowed (plan 2B Task 52.3, owner item 100). */
export const SYSTEM_CLAIMS_REFUSED = "system_claims_refused";

export interface WithClaimsOptions {
  /**
   * The claims may be the kernel's system user (`SYSTEM_USER_ID`). Off by default: only the callers that act as the system user on
   * purpose pass it (runProcess for origin `event` or `scheduler`, tests through their helper). Ruling R52-4.
   */
  allowSystem?: boolean;
}

/**
 * Runs `fn` in a transaction as the `authenticated` role with `claims` as the request JWT, so
 * `auth.uid()` and the `kernel.current_*` helpers see them and RLS applies exactly as for a user.
 * Claims naming the system user are refused (`forbidden`, `details.reason` SYSTEM_CLAIMS_REFUSED) unless `options.allowSystem`:
 * a defence in depth, user claims come from a verified JWT (plan 2B Task 52.3).
 */
export async function withClaims<T>(sql: Sql, claims: JwtClaims, fn: (tx: Tx) => Promise<T>, options: WithClaimsOptions = {}): Promise<T> {
  if (isSystemSub(claims.sub) && options.allowSystem !== true) {
    throw new ProcessError("forbidden", "the system user's claims are not allowed here", { details: { reason: SYSTEM_CLAIMS_REFUSED }, stage: "gate" });
  }
  const result = await sql.begin(async (tx) => {
    // One statement sets the claims and the role (`set_config('role', ..., true)` is `set local role`), and it is sent without waiting
    // for its answer: the first query of `fn` goes right behind it in the same round trip. If it failed the transaction would be
    // aborted and every query of `fn` would fail with it, so nothing can run outside the role; its error is raised below.
    const setup = tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true), set_config('role', 'authenticated', true)`.execute();
    const [, value] = await Promise.all([setup, fn(tx)]);
    return value;
  });
  return result as T;
}
