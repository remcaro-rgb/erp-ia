import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Notas crédito y débito (Documentos; plan 2B Task 20, prototype 2B): the notes through their masked view (kind, the invoice they correct,
// the reason, the stage, the DIAN's answer, whether it annuls the invoice). A note is written from its invoice («Crear nota crédito /
// débito»), so this grid has no Nuevo; the record opens at /r/invoicing.note/<id>.
export default function InvoicingNotesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="invoicing.note" href="/invoicing/notes" />
    </Suspense>
  );
}
