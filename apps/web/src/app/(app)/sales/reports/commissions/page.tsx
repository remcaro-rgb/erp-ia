import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { commissionReportOptions } from "@/lib/sales/commission-report";
import { ReportRoute } from "../../../_components/report-route";

// Comisiones por vendedor (Reportes) (plan 2B.2 Task 30.4, PG §5.5; rule 20): the parameter bar (Desde, Hasta, Beneficiario, Estado) over the
// report's grid with its totals and the PDF, Excel and CSV exports; read as the caller (a salesperson sees only their plans' lines).
async function Report() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let options;
  try {
    options = await commissionReportOptions(await requireCaller());
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const t = await getTranslations("sales.commission");
  return (
    <>
      <p className="erp-small erp-muted">{t("report_intro")}</p>
      <ReportRoute id="sales.commissions" options={options} />
    </>
  );
}

export default function SalesCommissionReportPage() {
  // The session cookie and the address are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Report />
    </Suspense>
  );
}
