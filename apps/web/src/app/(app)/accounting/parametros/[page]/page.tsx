import { Suspense } from "react";
import { ParametrosRoute } from "../../../[module]/parametros/_components/parametros-route";

// Contabilidad's Parámetros of the entity types (Task 16): the accounting folder is a static segment, so the shared screens are routed here too.
export default function AccountingParametrosPage({ params }: { params: Promise<{ page: string }> }) {
  return (
    <Suspense fallback={null}>
      <ParametrosRoute params={params} moduleId="accounting" />
    </Suspense>
  );
}
