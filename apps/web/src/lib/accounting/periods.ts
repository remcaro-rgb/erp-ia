import "server-only";
import { listYears, type YearSummary } from "@erp/module-accounting";
import { runnableProcesses, withClaims, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";

// What the Períodos page needs (accounting design §8), read as the caller: the fiscal years with their periods and what each holds,
// and which of the close and reopen processes the caller's roles may run (the buttons follow them; the step-up prompt follows the process).

const PROCESSES = ["accounting.period.close", "accounting.period.reopen", "accounting.year.close", "accounting.year.reopen"] as const;

export interface PeriodsPageData {
  years: YearSummary[];
  can: { closePeriod: boolean; reopenPeriod: boolean; closeYear: boolean; reopenYear: boolean };
  /** Today in the company's calendar, for the date picker of "Reabrir solo un día". */
  today: string;
}

export async function loadPeriodsPage(caller: Caller): Promise<PeriodsPageData> {
  const deps = processDeps();
  const [years, runnable, today] = await Promise.all([
    withClaims(deps.sql, caller.claims, (tx) => listYears(tx, caller.claims.active_company_id)),
    runnableProcesses(deps.sql, deps.registry, caller.claims, [...PROCESSES]),
    withClaims(deps.sql, caller.claims, async (tx) => {
      const [row] = await tx<{ today: string }[]>`select (now() at time zone coalesce((select timezone from kernel.v_companies where id = ${caller.claims.active_company_id}), 'America/Bogota'))::date::text as today`;
      return row!.today;
    }),
  ]);
  return {
    years,
    today,
    can: {
      closePeriod: runnable.has("accounting.period.close"),
      reopenPeriod: runnable.has("accounting.period.reopen"),
      closeYear: runnable.has("accounting.year.close"),
      reopenYear: runnable.has("accounting.year.reopen"),
    },
  };
}
