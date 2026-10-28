import { Suspense } from "react";
import { loadExtra } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { ExtraScreen } from "./extra-screen";

// Datos adicionales: the admin-defined fields of each entity (design §5.14, prototype v5).
export default function ExtraPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadExtra} render={(data) => <ExtraScreen data={data} />} />
    </Suspense>
  );
}
