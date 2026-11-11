import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Costos pendientes (Reportes): the products moved without a cost; the grid starts on the open rows (loadGridPage default state).
export default function CostingMissingPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="costing.cost_missing" href="/costing/missing" />
    </Suspense>
  );
}
