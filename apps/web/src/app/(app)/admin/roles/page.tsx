import { Suspense } from "react";
import { loadRoles } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { RolesScreen } from "./roles-screen";

// Roles: the company's roles with their party scope, permissions and users (design §6, prototype v5 "Roles").
export default function RolesPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadRoles} render={(data) => <RolesScreen data={data} />} />
    </Suspense>
  );
}
