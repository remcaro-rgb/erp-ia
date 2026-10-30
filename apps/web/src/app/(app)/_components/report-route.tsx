import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadReportPage, type LoadReportOptions } from "@/lib/reports/load";
import { ReportScreen } from "./report-screen";

/** The body of the page of report `id`, read as the caller; a report the caller may not open says why. */
export async function ReportRoute({ id, options }: { id: string; options?: LoadReportOptions }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let result;
  try {
    result = await loadReportPage(id, options);
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (!result.ok) {
    const t = await getTranslations("report.denied");
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(result.denial)}
      </div>
    );
  }
  return <ReportScreen data={result.data} />;
}
