import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Entregas (Documentos): what left the bodega for a confirmed pedido; Despachar takes it out of Existencias.
// Plan 2B Task 14b; the record opens at /r/sales.delivery/<id>.
export default function SalesDeliveriesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="sales.delivery" href="/sales/deliveries" />
    </Suspense>
  );
}
