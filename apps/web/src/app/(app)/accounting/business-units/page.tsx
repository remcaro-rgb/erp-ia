import { Suspense } from "react";
import { MasterRoute } from "../_components/master-route";

// Unidades de negocio (accounting design §8): the analytic master page, Tabla · Árbol.
export default function Page() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <MasterRoute entity="accounting.business_unit" href="/accounting/business-units" />
    </Suspense>
  );
}
