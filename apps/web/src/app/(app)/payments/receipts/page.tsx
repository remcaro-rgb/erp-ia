import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";
import type { QuickFilter } from "../../_components/grid-page";

// Recibos de caja (Documentos; plan 2B Task 24b, prototype 2B): the receipts through their masked view, with the quick filters by state
// (Contabilizado · Anulado), exports and Imprimir; «Nuevo recibo» opens «Registrar pago». No Importar: a receipt posts when it is received.
// The record opens at /r/payments.receipt/<id>.
async function Receipts() {
  await connection();
  const t = await getTranslations("grid.values.record_status");
  const quick: QuickFilter[] = (["posted", "voided"] as const).map((status) => ({ id: status, group: "status", label: t(status), filters: [{ field: "status", op: "eq" as const, value: status }] }));
  return <GridRoute entity="payments.receipt" href="/payments/receipts" quickFilters={quick} />;
}

export default function PaymentsReceiptsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Receipts />
    </Suspense>
  );
}
