import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Movimientos (accounting design §5.14, §8): one DataGrid over the ledger-line query entity. Where it starts (open period,
// posted lines, comprobante order, the columns of the design) comes from the entity's default state in `loadGridPage`
// (`defaultMovementsState`), after the user's own default view and a link's query.
export default function MovementsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="accounting.ledger_line" href="/accounting/movements" />
    </Suspense>
  );
}
