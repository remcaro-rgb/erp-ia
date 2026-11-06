import { Suspense } from "react";
import { ParametrosRoute } from "../../../[module]/parametros/_components/parametros-route";

// The Parámetros of the entity types (Task 16) for payments: the folder is a static segment, so the shared screens are routed here too.
export default function PaymentsParametrosPage({ params }: { params: Promise<{ page: string }> }) {
  return (
    <Suspense fallback={null}>
      <ParametrosRoute params={params} moduleId="payments" />
    </Suspense>
  );
}
