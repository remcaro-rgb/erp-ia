import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Costos en destino (Documentos): freight, duties or insurance allocated to a receipt; Nuevo allocates one (with an idempotency key, Task 9).
export default function CostingLandedCostsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="costing.landed_cost" href="/costing/landed-costs" />
    </Suspense>
  );
}
