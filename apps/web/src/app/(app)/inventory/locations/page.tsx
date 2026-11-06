import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Ubicaciones (Maestros): the ubicaciones of every bodega; the transit one (TRANSITO) is the traslados' own.
export default function InventoryLocationsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="inventory.location" href="/inventory/locations" />
    </Suspense>
  );
}
