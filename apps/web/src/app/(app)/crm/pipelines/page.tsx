import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Embudos (Parámetros): the etapas an oportunidad goes through, with their probability.
// Plan 2B Task 14b; the record opens at /r/crm.pipeline/<id>.
export default function CrmPipelinesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="crm.pipeline" href="/crm/pipelines" />
    </Suspense>
  );
}
