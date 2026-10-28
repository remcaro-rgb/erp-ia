import { Suspense } from "react";
import { loadCompany } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { CompanyScreen } from "./company-screen";

// Empresa: the active company's names and time zone (design §5.1, §6).
export default function CompaniesPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadCompany} render={(data) => <CompanyScreen data={data} />} />
    </Suspense>
  );
}
