import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";

/**
 * Whether the admin deactivated the caller's membership in their active company (kernel.admin.user.update, design
 * §22.16; `kernel.membership_inactive()`, 0027). The sign-in refuses such a session; runProcess refuses its runs on its own.
 */
export async function membershipInactive(sql: Sql, claims: JwtClaims): Promise<boolean> {
  const [row] = await withClaims(sql, claims, (tx) => tx<{ inactive: boolean }[]>`select kernel.membership_inactive() as inactive`);
  return row?.inactive === true;
}
