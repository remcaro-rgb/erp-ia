import { Suspense } from "react";
import { loadMenuAccess } from "@/lib/parametros/load";
import { AdminRoute } from "../_components/admin-route";
import { MenuAccessScreen } from "./menu-access-screen";

// Acceso al menú (entity types spec §9.2, D7, D12; Task 16): which roles and users see each menu item of the company's modules.
export default function MenuAccessPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadMenuAccess} render={(data) => <MenuAccessScreen data={data} />} />
    </Suspense>
  );
}
