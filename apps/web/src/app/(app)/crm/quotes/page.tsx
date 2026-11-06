import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Cotizaciones (Documentos): what was offered a customer; Nuevo writes one, Enviar, Aceptar and Crear pedido take it on.
// Plan 2B Task 14b; the record opens at /r/crm.quote/<id>.
export default function CrmQuotesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="crm.quote" href="/crm/quotes" />
    </Suspense>
  );
}
