import { Suspense } from "react";
import { ParametrosRoute } from "../_components/parametros-route";

// Parámetros of a module's maestros and documentos (Task 16): Configuración de tipos, Destinatarios por estado, Plantillas PDF.
export default function ParametrosPage({ params }: { params: Promise<{ module: string; page: string }> }) {
  return (
    <Suspense fallback={null}>
      <ParametrosRoute params={params} />
    </Suspense>
  );
}
