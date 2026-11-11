import { Suspense } from "react";
import { loadNestedRuns } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { NestedRunsScreen } from "./nested-runs-screen";

// Ejecuciones anidadas (plan 2B Task 32): the depth, the configured pairs (parent → nested process) with their step-up coverage and what a failure does.
export default function NestedRunsPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadNestedRuns} render={(data) => <NestedRunsScreen data={data} />} />
    </Suspense>
  );
}
