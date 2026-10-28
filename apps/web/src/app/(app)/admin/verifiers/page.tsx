import { Suspense } from "react";
import { loadVerifiers } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { VerifiersScreen } from "./verifiers-screen";

// Verificadores: the external verification provider per kind of datum (design §5.16, prototype v5).
export default function VerifiersPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadVerifiers} render={(data) => <VerifiersScreen data={data} />} />
    </Suspense>
  );
}
