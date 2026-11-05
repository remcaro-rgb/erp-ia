import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";
import type { Registry } from "../registry";

/**
 * The processes among `processIds` the caller may run in the active company, by the rule `runProcess`
 * applies (rule 13): a role of theirs allows it (`kernel.can_run_process`), or the process is self-service
 * (`permission: "none"`) and they belong to the company; nothing for a deactivated membership. Ids the registry does not
 * know are left out.
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
  const answers = await askRunnable(sql, claims, known);
  const rows = known.map((id) => ({ id, ...answers.get(id)! }));
  return new Set(rows.filter((r) => (registry.process(r.id).permission === "none" ? r.member : r.allowed)).map((r) => r.id));
}

type Answer = { allowed: boolean; member: boolean };
type Batch = { ids: Set<string>; answers: Promise<Map<string, Answer>> };
const batches = new WeakMap<Sql, Map<string, Batch>>();

/**
 * One page asks this from a dozen loaders at once (the shell, the record, each tab). Callers of the same user in the same
 * event-loop turn share one transaction: their ids are joined and each gets the answers for its own. Nothing is kept after the answer, so
 * a permission changed a moment later is read afresh by the next call.
 */
function askRunnable(sql: Sql, claims: JwtClaims, ids: readonly string[]): Promise<Map<string, Answer>> {
  const bySql = batches.get(sql) ?? new Map<string, Batch>();
  batches.set(sql, bySql);
  const key = JSON.stringify(claims);
  let batch = bySql.get(key);
  if (!batch) {
    const joined = new Set<string>();
    const answers = new Promise<Map<string, Answer>>((resolve, reject) => {
      setImmediate(() => {
        bySql.delete(key);
        withClaims(sql, claims, (tx) => tx<{ id: string; allowed: boolean; member: boolean }[]>`
          select id, allowed, member from kernel.runnable_processes(${[...joined]}::text[])`)
          .then((rows) => resolve(new Map(rows.map((r) => [r.id, { allowed: r.allowed, member: r.member }]))), reject);
      });
    });
    batch = { ids: joined, answers };
    bySql.set(key, batch);
  }
  for (const id of ids) batch.ids.add(id);
  return batch.answers;
}
