import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { ProcessError, runnableProcesses, runProcess } from "@erp/kernel";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { CostingSettingsForm } from "./settings-form";

// Parámetros › Costeo (plan 2B Tasks 9–10, OD-5): the company's costing method, read with costing.settings.consult and saved with
// costing.settings.update, a sensitive process (the form asks for the step-up code). Weighted average only; FIFO is phase 3.
async function Settings() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let caller;
  try {
    caller = await requireCaller();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const deps = processDeps();
  let settings: { method: string; configured: boolean };
  try {
    settings = (await runProcess(deps, caller, "costing.settings.consult", {})) as { method: string; configured: boolean };
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) {
      const t = await getTranslations("grid.denied");
      return (
        <div role="alert" className="erp-dian erp-dian--bad">
          {t(error.code === "forbidden" ? "forbidden" : "not_entitled")}
        </div>
      );
    }
    throw error;
  }
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["costing.settings.update"]);
  return <CostingSettingsForm method={settings.method} configured={settings.configured} canSave={runnable.has("costing.settings.update")} />;
}

export default function CostingSettingsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
