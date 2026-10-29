import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";

export interface CallerProfile {
  user: { id: string; name: string; email: string };
  /** Names of the caller's roles in the active company. */
  roles: string[];
  /** Every company of the caller's claims, by legal name. */
  companies: { id: string; name: string; taxId: string | null; /** IANA zone the company schedules and reports in. */ timeZone: string }[];
  /** False when the admin deactivated the caller's membership in the active company (design §22.16): the shell signs out. */
  active: boolean;
}

/**
 * Who the shell greets (design §19a top bar): the caller's name and e-mail, their role names in the active
 * company (the roles they still hold, `kernel.current_role_ids()`, 0024), the companies they may switch to and whether
 * their membership there is still active (`kernel.membership_inactive()`, 0027).
 * Read as the caller, under RLS.
 */
export async function callerProfile(sql: Sql, claims: JwtClaims): Promise<CallerProfile> {
  return withClaims(sql, claims, async (tx) => {
    const [user] = await tx<{ id: string; full_name: string | null; email: string }[]>`
      select id, full_name, email from kernel.users where id = ${claims.sub}`;
    const roles = await tx<{ name: string }[]>`
      select r.name from kernel.roles r
      where r.id = any (kernel.current_role_ids()) and r.company_id = ${claims.active_company_id}
      order by r.name`;
    const companies = await tx<{ id: string; legal_name: string; tax_id: string | null; timezone: string }[]>`
      select id, legal_name, tax_id, timezone from kernel.companies
      where id = any (${claims.company_ids}::uuid[]) order by legal_name`;
    const [state] = await tx<{ inactive: boolean }[]>`select kernel.membership_inactive() as inactive`;
    const email = user?.email ?? "";
    return {
      user: { id: claims.sub, name: user?.full_name?.trim() || email, email },
      roles: roles.map((r) => r.name),
      companies: companies.map((c) => ({ id: c.id, name: c.legal_name, taxId: c.tax_id, timeZone: c.timezone })),
      active: !state!.inactive,
    };
  });
}
