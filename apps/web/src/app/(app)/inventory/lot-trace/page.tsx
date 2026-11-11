import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { lotTraceReportOptions } from "@/lib/inventory/lot-trace-report";
import { ReportRoute } from "../../_components/report-route";

// Trazabilidad de lotes (Inventario › Reportes; plan 2B.2 Task 28.4, PG §3.6; rules 14, 20, 21): pick a lot or a serial and, optionally, a
// date range; every movement that moved it with its customer and a link to the movement, then the stock by bodega, with the exports.
async function Report() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let options;
  try {
    options = await lotTraceReportOptions(await requireCaller());
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const t = await getTranslations("report.lot_trace");
  return (
    <>
      <p className="erp-small erp-muted">{t("intro")}</p>
      <ReportRoute id="inventory.lot_trace" options={options} />
    </>
  );
}

export default function LotTracePage() {
  // The session cookie and the address are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Report />
    </Suspense>
  );
}
