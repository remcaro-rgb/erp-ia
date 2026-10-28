import { Suspense } from "react";
import { loadPermissions } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { PermissionMatrix } from "./permission-matrix";

// Permisos: the process × role matrix (design §6, prototype v5 "Matriz proceso × rol").
export default function PermissionsPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadPermissions} render={(data) => <PermissionMatrix data={data} />} />
    </Suspense>
  );
}
