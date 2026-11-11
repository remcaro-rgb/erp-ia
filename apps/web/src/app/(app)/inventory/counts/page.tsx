import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Conteos (Documentos): the physical counts; applying one posts its differences as one ajuste (step-up).
export default function InventoryCountsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="inventory.count" href="/inventory/counts" />
    </Suspense>
  );
}
