import { Suspense } from "react";
import { loadModules } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { ModulesScreen } from "./modules-screen";

// Módulos: the company's modules on and off, with their dependencies (design §5.12, prototype v5).
export default function ModulesPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadModules} render={(data) => <ModulesScreen data={data} />} />
    </Suspense>
  );
}
