import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";
import type { QuickFilter } from "../../_components/grid-page";

// Aplicaciones de anticipo (Documentos; plan 2B.2 Task 36): the applications of a customer's advance to its invoices through their masked view,
// with the quick filters by state (Contabilizado · Anulado) and the exports. An application is made from the receipt that holds the advance
// («Aplicar a facturas» on its page), so the list has no Importar. The record opens at /r/payments.advance_application/<id>.
async function AdvanceApplications() {
  await connection();
  const t = await getTranslations("grid.values.record_status");
  const quick: QuickFilter[] = (["posted", "voided"] as const).map((status) => ({ id: status, group: "status", label: t(status), filters: [{ field: "status", op: "eq" as const, value: status }] }));
  return <GridRoute entity="payments.advance_application" href="/payments/advance-applications" quickFilters={quick} />;
}

export default function PaymentsAdvanceApplicationsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <AdvanceApplications />
    </Suspense>
  );
}
