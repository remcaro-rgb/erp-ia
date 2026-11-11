import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Prospectos (Comercial): the people and companies that may buy; Nuevo registers one, Convertir en cliente turns it into a tercero and an oportunidad.
// Plan 2B Task 14b; the record opens at /r/crm.lead/<id>.
export default function CrmLeadsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="crm.lead" href="/crm/leads" />
    </Suspense>
  );
}
