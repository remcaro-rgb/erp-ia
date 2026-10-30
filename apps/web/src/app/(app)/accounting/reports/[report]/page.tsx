import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getLocale } from "next-intl/server";
import { reportOf } from "@erp/kernel";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { accountingReportOptions } from "@/lib/accounting/report-options";
import { isReportName } from "@/lib/accounting/reports";
import { processDeps } from "@/lib/server/runtime";
import { ReportRoute } from "../../../_components/report-route";

// One accounting report (accounting design §8): the parameter bar generated from the report's schema, with the current period, the
// accounts, fuentes and analytic masters the caller may use, over the DataGrid with its totals footer and exports.
async function Report({ params }: { params: Promise<{ report: string }> }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const { report: name } = await params;
  if (!isReportName(name)) notFound();
  const def = reportOf(processDeps(), `accounting.${name}`);
  if (!def) notFound();
  let options;
  try {
    options = await accountingReportOptions(await requireCaller(), def, await getLocale());
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return <ReportRoute id={def.id} options={options} />;
}

export default function ReportPage({ params }: { params: Promise<{ report: string }> }) {
  // The session cookie and the address are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Report params={params} />
    </Suspense>
  );
}
