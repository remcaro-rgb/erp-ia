import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Actividades: calls, meetings, notes and tasks logged against an oportunidad, a prospecto or a tercero, and the payments invoicing logs.
// Plan 2B Task 14b; the record opens at /r/crm.activity/<id>.
export default function CrmActivitiesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="crm.activity" href="/crm/activities" />
    </Suspense>
  );
}
