import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";

export interface StoredUserPref {
  value: unknown;
  updatedAt: Date;
}

/**
 * The caller's saved preferences among `keys` in the active company, by key (absent keys are left out).
 * A plain read under RLS (`own_prefs`: only the caller's rows): the shell loads it on every page, so it is not
 * a process and writes no audit row. Writes still go through `kernel.user_prefs.set`.
 */
export async function readUserPrefs(sql: Sql, claims: JwtClaims, keys: readonly string[]): Promise<Record<string, StoredUserPref>> {
  if (keys.length === 0) return {};
  const rows = await withClaims(sql, claims, (tx) => tx<{ key: string; value: unknown; updated_at: Date }[]>`
    select key, value, updated_at from kernel.user_prefs
    where user_id = ${claims.sub} and company_id = ${claims.active_company_id} and key = any (${[...keys]}::text[])`);
  return Object.fromEntries(rows.map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
}
