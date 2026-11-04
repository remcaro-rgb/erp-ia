import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Plantillas de comprobante (accounting design §4.10): a DataGrid of the templates; "Nuevo" opens the record page with its lines tab.
export default function EntryTemplatesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="accounting.entry_template" href="/accounting/entry-templates" />
    </Suspense>
  );
}
