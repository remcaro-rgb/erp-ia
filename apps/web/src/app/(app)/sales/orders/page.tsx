import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Pedidos de venta (Documentos): what customers ordered; Nuevo writes one (or Crear pedido from an accepted cotización), Confirmar reserves the stock.
// Plan 2B Task 14b; the record opens at /r/sales.order/<id>.
export default function SalesOrdersPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="sales.order" href="/sales/orders" />
    </Suspense>
  );
}
