import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Bodegas (Maestros, plan 2B Task 10): the grid of the bodegas; Nuevo opens the bodega's record.
export default function InventoryWarehousesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="inventory.warehouse" href="/inventory/warehouses" />
    </Suspense>
  );
}
