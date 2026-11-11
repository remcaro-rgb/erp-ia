import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Empaques (Bodega › Documentos; plan 2B.2 Task 29.4, PG §4.4): read as the caller; a row opens its record.
export default function WarehousePacksPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="warehouse.pack" href="/warehouse/packs" />
    </Suspense>
  );
}
