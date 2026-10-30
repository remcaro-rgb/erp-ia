import "server-only";
import { runnableProcesses, withClaims, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";

// Whether the company has run Configurar contabilidad (accounting design §5.9): the settings row `chart.seed` writes. Until it exists every
// accounting page leads to the single action that creates it.

export async function isConfigured(caller: Caller): Promise<boolean> {
  const deps = processDeps();
  const [row] = await withClaims(deps.sql, caller.claims, (tx) => tx<{ n: number }[]>`select count(*)::int as n from accounting.v_settings where company_id = ${caller.claims.active_company_id}`);
  return (row?.n ?? 0) > 0;
}

/** Whether the caller's roles may run `chart.seed` (the action is the admin's, under step-up). */
export async function canConfigure(caller: Caller): Promise<boolean> {
  const deps = processDeps();
  return (await runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.chart.seed"])).has("accounting.chart.seed");
}
