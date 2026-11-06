import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Devoluciones (Documentos): what customers sent back from an entrega; Recibir puts it back in Existencias.
// Plan 2B Task 14b; the record opens at /r/sales.return/<id>.
export default function SalesReturnsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="sales.return" href="/sales/returns" />
    </Suspense>
  );
}
