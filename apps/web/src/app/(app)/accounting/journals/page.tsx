import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Fuentes (accounting design §8, §10b.18): a plain DataGrid of the journals with their consecutivo; the journal master is Fuente in every screen.
export default function JournalsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="accounting.journal" href="/accounting/journals" />
    </Suspense>
  );
}
