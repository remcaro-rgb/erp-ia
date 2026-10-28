import { Suspense } from "react";
import { loadSensitive } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { SensitiveScreen } from "./sensitive-screen";

// Procesos sensibles: the processes that ask for a fresh TOTP step-up in this company (rule 15, prototype v5).
export default function SensitivePage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadSensitive} render={(data) => <SensitiveScreen data={data} />} />
    </Suspense>
  );
}
