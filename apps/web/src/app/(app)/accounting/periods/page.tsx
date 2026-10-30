import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { loadPeriodsPage, type PeriodsPageData } from "@/lib/accounting/periods";
import { PeriodsScreen } from "./periods-screen";

// Períodos (accounting design §8): the fiscal years as cards, the periods of the chosen year with what each holds, and the close and
// reopen of a period or a whole year, each behind the TOTP dialog.
async function Periods() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let data: PeriodsPageData;
  try {
    data = await loadPeriodsPage(await requireCaller());
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (data.years.length === 0) {
    const t = await getTranslations("common.acc_pages.periods");
    return <p className="erp-muted">{t("none")}</p>;
  }
  return <PeriodsScreen data={data} />;
}

export default function PeriodsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Periods />
    </Suspense>
  );
}
