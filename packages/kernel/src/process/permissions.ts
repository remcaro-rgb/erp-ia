import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";
import type { Registry } from "../registry";

/**
 * The processes among `processIds` the caller may run in the active company, by the rule `runProcess`
 * applies (rule 13): a role of theirs allows it (`kernel.can_run_process`), or the process is self-service
 * (`permission: "none"`) and they belong to the company. Ids the registry does not know are left out.
 * For menus and the command palette; `runProcess` still checks every run. Entitlements are not checked here.
 */
export async function runnableProcesses(sql: Sql, registry: Registry, claims: JwtClaims, processIds: readonly string[]): Promise<Set<string>> {
  const known = processIds.filter((id) => {
    try {
      registry.process(id);
      return true;
    } catch {
      return false;
    }
  });
  if (known.length === 0) return new Set();
  const rows = await withClaims(sql, claims, (tx) => tx<{ id: string; allowed: boolean; member: boolean }[]>`
    select p.id, kernel.can_run_process(p.id) as allowed,
           coalesce(kernel.current_company_id() = any (kernel.current_company_ids()), false) as member
    from unnest(${known}::text[]) as p(id)`);
  return new Set(rows.filter((r) => (registry.process(r.id).permission === "none" ? r.member : r.allowed)).map((r) => r.id));
}
