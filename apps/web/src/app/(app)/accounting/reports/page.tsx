import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { reportDenial } from "@erp/kernel";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { REPORT_ORDER } from "@/lib/accounting/reports";
import { processDeps } from "@/lib/server/runtime";
import { ReportCards } from "./report-cards";

// Informes (accounting design §8): a card for each report the caller may open; the card leads to the report page with its parameter bar.

async function Reports() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let caller;
  try {
    caller = await requireCaller();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const deps = processDeps();
  const t = await getTranslations();
  const defs = deps.registry.reports("accounting");
  const allowed = (
    await Promise.all(
      REPORT_ORDER.map(async (name) => {
        const def = defs.find((d) => d.id === `accounting.${name}`);
        return def && !(await reportDenial(deps, caller.claims, def)) ? { name, label: t(def.label as never) } : null;
      }),
    )
  ).filter((r): r is { name: (typeof REPORT_ORDER)[number]; label: string } => r !== null);
  if (allowed.length === 0) return <p className="erp-muted">{t("accounting.pages.reports.none")}</p>;
  return <ReportCards items={allowed.map((r) => ({ name: r.name, label: r.label, description: t(`accounting.pages.reports.desc.${r.name}`) }))} />;
}

export default function ReportsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Reports />
    </Suspense>
  );
}
