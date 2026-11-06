import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ProcessError, runnableProcesses, runProcess, withClaims, type Caller } from "@erp/kernel";
import type { CodeOption } from "@erp/ui";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";

// Server side of the parámetros pages of CRM and Ventas (plan 2B Task 14b): the session's caller, the consult as them (a refusal becomes the
// page's denial), the processes they may run and the company's price lists (core's masked view).

export async function settingsCaller(): Promise<Caller> {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  try {
    return await requireCaller();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
}

/** The consult's row, or the denial code (`forbidden`, `not_entitled`). */
export async function consultSettings(caller: Caller, process: string, input: Record<string, unknown> = {}): Promise<{ row: Record<string, unknown> } | { denied: "forbidden" | "not_entitled" }> {
  try {
    return { row: (await runProcess(processDeps(), caller, process, input)) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return { denied: error.code };
    throw error;
  }
}

export async function mayRun(caller: Caller, process: string): Promise<boolean> {
  const deps = processDeps();
  return (await runnableProcesses(deps.sql, deps.registry, caller.claims, [process])).has(process);
}

export async function priceLists(caller: Caller): Promise<CodeOption[]> {
  const deps = processDeps();
  const rows = await withClaims(deps.sql, caller.claims, (tx) => tx<{ id: string; name: string | null; currency_code: string | null }[]>`
    select id, name, currency_code from core.v_price_lists where coalesce(is_active, true) and status in ('saved', 'approved') order by name`);
  return rows.map((r) => ({ code: r.id, name: [r.name, r.currency_code].filter(Boolean).join(" · ") }));
}

/** A percent or amount as the box shows it: empty for none, the number with a decimal comma otherwise. */
export const boxText = (v: unknown): string => (v === null || v === undefined || v === "" ? "" : String(Number(v)).replace(".", ","));
