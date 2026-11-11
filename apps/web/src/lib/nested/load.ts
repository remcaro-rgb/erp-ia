import "server-only";
import { NESTED_RETRY_PROCESS, withClaims } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps, registrySynced } from "@/lib/server/runtime";

// What the nested-run failure queue shows (plan 2B Task 32, R32-7): read as the caller from `kernel.v_nested_run_failures`, the view without the
// stored `input` (rule 14; the authenticated role has no grant on that column). Its audience is the company admin and any role granted the
// process `kernel.nested_failure.retry` or `kernel.nested_failure.dismiss` (the audience of the table's policy since migration 0127); anyone else
// gets `null` and the screen says so. The buttons follow the processes: Reintentar for a retry holder, Descartar for a dismiss holder.

export const DISMISS_PROCESS = "kernel.nested_failure.dismiss";
/** How many rows the screen lists (pending ones first, then the newest of the rest). */
export const QUEUE_LIMIT = 200;

export interface NestedFailureRow {
  id: string;
  parentProcess: string;
  nestedProcess: string;
  reason: string;
  /** The name of who ran the parent, when the caller may read it; null otherwise. */
  actor: string | null;
  createdAt: string;
  status: "pending" | "resolved" | "dismissed";
  attempts: number;
}

export interface NestedFailuresData {
  rows: NestedFailureRow[];
  /** Whether more rows exist than the list shows. */
  truncated: boolean;
  /** Reintentar shows (the caller may run the retry; an admin always may). */
  canRetry: boolean;
  canDismiss: boolean;
  /** What each process of the rows does, in Spanish (the registry's description), for the names the catalogue has no label for. */
  descriptions: Record<string, string>;
  /** The company admin also sees the way to the settings. */
  isAdmin: boolean;
}

interface Row {
  id: string;
  parent_process: string;
  nested_process: string;
  reason: string;
  actor_user_id: string;
  actor_name: string | null;
  created_at: Date | string;
  status: string;
  attempts: number;
}

export async function loadNestedFailures(): Promise<NestedFailuresData | null> {
  const caller = await requireCaller();
  const deps = processDeps();
  await registrySynced();
  return withClaims(deps.sql, caller.claims, async (tx) => {
    const [who] = await tx<{ admin: boolean; retry: boolean; dismiss: boolean }[]>`
      select kernel.is_company_admin() as admin, kernel.can_run_process(${NESTED_RETRY_PROCESS}) as retry, kernel.can_run_process(${DISMISS_PROCESS}) as dismiss`;
    if (!who || !(who.admin || who.retry || who.dismiss)) return null;
    const rows = await tx<Row[]>`
      select f.id, f.parent_process, f.nested_process, f.reason, f.actor_user_id, u.full_name as actor_name, f.created_at, f.status, f.attempts
      from kernel.v_nested_run_failures f
      left join kernel.users u on u.id = f.actor_user_id
      where f.company_id = kernel.current_company_id()
      order by (f.status = 'pending') desc, f.created_at desc, f.id desc
      limit ${QUEUE_LIMIT + 1}`;
    const shown = rows.slice(0, QUEUE_LIMIT);
    const descriptions: Record<string, string> = {};
    for (const r of shown) {
      for (const id of [r.parent_process, r.nested_process]) {
        if (!(id in descriptions) && deps.registry.processes().some((p) => p.id === id)) descriptions[id] = deps.registry.process(id).description;
      }
    }
    return {
      descriptions,
      rows: shown.map((r) => ({
        id: r.id,
        parentProcess: r.parent_process,
        nestedProcess: r.nested_process,
        reason: r.reason,
        actor: r.actor_name,
        createdAt: new Date(r.created_at).toISOString(),
        status: r.status === "resolved" || r.status === "dismissed" ? r.status : "pending",
        attempts: Number(r.attempts),
      })),
      truncated: rows.length > QUEUE_LIMIT,
      canRetry: who.retry,
      canDismiss: who.dismiss,
      isAdmin: who.admin,
    };
  });
}
