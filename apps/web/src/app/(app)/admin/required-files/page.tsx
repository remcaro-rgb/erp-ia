import { Suspense } from "react";
import { loadRequiredFiles } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { RequiredFilesScreen } from "./required-files-screen";

// Archivos obligatorios: the files each entity requires (design §5.13, §5.17, prototype v5).
export default function RequiredFilesPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadRequiredFiles} render={(data) => <RequiredFilesScreen data={data} />} />
    </Suspense>
  );
}
