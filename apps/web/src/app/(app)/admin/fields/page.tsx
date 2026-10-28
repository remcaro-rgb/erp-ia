import { Suspense } from "react";
import { loadFields } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { FieldsScreen } from "./fields-screen";

// Visibilidad de campos: each entity's fields × the company's roles (design §5.3, rule 14, prototype v5).
export default function FieldsPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadFields} render={(data) => <FieldsScreen data={data} />} />
    </Suspense>
  );
}
