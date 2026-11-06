import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Movimientos de inventario (Documentos): entradas, salidas, ajustes and the legs of traslados and deliveries; Nuevo registers an entrada, salida or ajuste.
export default function InventoryMovementsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="inventory.movement" href="/inventory/movements" />
    </Suspense>
  );
}
