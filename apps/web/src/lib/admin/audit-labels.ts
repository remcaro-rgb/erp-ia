import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { countryPackOf, withClaims, type ValueLabels } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";

// What the audit viewer reads values with (design §22.14): the request's catalogue, the company's country pack (its codes)
// and the company's time zone (its dates), for the kernel's shared label helper.

export async function auditLabels(): Promise<ValueLabels> {
  const [t, locale, caller] = await Promise.all([getTranslations(), getLocale(), requireCaller()]);
  // processDeps registers the country packs on first use.
  const { sql } = processDeps();
  const [company] = await withClaims(
    sql,
    caller.claims,
    (tx) => tx<{ country_code: string | null; timezone: string | null }[]>`
      select country_code, timezone from kernel.v_companies where id = kernel.current_company_id()`,
  );
  return {
    t: (key) => (t.has(key) ? t(key) : undefined),
    locale,
    pack: countryPackOf(company?.country_code),
    timeZone: company?.timezone ?? undefined,
  };
}
