import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Transferencias (Documentos): the traslados between bodegas, requested, in transit or received.
export default function InventoryTransfersPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="inventory.transfer" href="/inventory/transfers" />
    </Suspense>
  );
}
