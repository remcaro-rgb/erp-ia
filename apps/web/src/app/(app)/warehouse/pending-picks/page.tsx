import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { withClaims } from "@erp/kernel";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { ReportRoute } from "../../_components/report-route";

// Pendientes por alistar (Bodega › Reportes; plan 2B.2 Task 29.4, PG §4.4; rule 20): the confirmed pedidos with goods to deliver and no
// confirmed alistamiento, oldest first, with the parameter bar (Bodega, Desde, Hasta) and the PDF, Excel and CSV exports; read as the caller.
async function Report() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let warehouses;
  try {
    const caller = await requireCaller();
    const deps = processDeps();
    warehouses = await withClaims(deps.sql, caller.claims, (tx) => tx<{ id: string; code: string | null; name: string | null }[]>`
      select id, code, name from inventory.v_warehouses order by code`);
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const t = await getTranslations("report.pending_picks");
  return (
    <>
      <p className="erp-small erp-muted">{t("intro")}</p>
      <ReportRoute id="warehouse.pending_picks" options={{ paramOptions: { warehouseId: warehouses.map((w) => ({ value: w.id, label: [w.code, w.name].filter(Boolean).join(" · ") })) } }} />
    </>
  );
}

export default function WarehousePendingPicksPage() {
  // The session cookie and the address are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Report />
    </Suspense>
  );
}
