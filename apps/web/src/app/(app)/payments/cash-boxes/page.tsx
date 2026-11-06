import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Cajas (Maestros, plan 2B Task 24b): the grid of the cajas where cash is received; Nuevo opens the caja's record.
export default function PaymentsCashBoxesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="payments.cash_box" href="/payments/cash-boxes" />
    </Suspense>
  );
}
