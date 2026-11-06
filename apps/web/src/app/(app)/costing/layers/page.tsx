import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Capas de costo (Reportes): the weighted average of every product per bodega (quantity, value, average cost; costs are confidential fields).
export default function CostingLayersPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="costing.cost_layer" href="/costing/layers" />
    </Suspense>
  );
}
