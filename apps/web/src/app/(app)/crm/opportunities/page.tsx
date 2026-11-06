import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Oportunidades (Documentos): the deals in their etapa; Nuevo opens one, Mover de etapa takes it along its embudo.
// Plan 2B Task 14b; the record opens at /r/crm.opportunity/<id>.
export default function CrmOpportunitiesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="crm.opportunity" href="/crm/opportunities" />
    </Suspense>
  );
}
