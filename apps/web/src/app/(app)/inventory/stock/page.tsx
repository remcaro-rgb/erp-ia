import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Existencias (Reportes): on hand per product, bodega and ubicación, read from the masked view inventory.v_stock_levels (Task 6).
export default function InventoryStockPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="inventory.stock_level" href="/inventory/stock" />
    </Suspense>
  );
}
