import { Suspense } from "react";
import { GridRoute } from "../../_components/grid-route";

// Medios de pago (Maestros, plan 2B Task 24b): the grid of the medios de pago; Nuevo opens the medio's record (Duplicar, rule 37).
export default function PaymentsMethodsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="payments.method" href="/payments/methods" />
    </Suspense>
  );
}
