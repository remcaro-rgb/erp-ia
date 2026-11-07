import type { Sql } from "postgres";

// Startup module-list check (plan 2B Task 48, owner item 40, Ruling R48-1). The deployed list is kernel.manifest_hashes, written by
// whichever runtime synced last; the worker reads it BEFORE its own syncRegistry. A deployed module the worker image lacks means its
// outbox events would not be processed by this worker (a stale image after the 2B modules shipped).

export type ModuleCheckMode = "refuse" | "warn" | "off";

export function compareModuleLists(workerIds: readonly string[], deployedIds: readonly string[]): { missing: string[]; extra: string[] } {
  const worker = new Set(workerIds);
  const deployed = new Set(deployedIds);
  return {
    missing: [...deployed].filter((id) => !worker.has(id)).sort(),
    extra: [...worker].filter((id) => !deployed.has(id)).sort(),
  };
}

/** WORKER_MODULE_CHECK = refuse | warn | off; default refuse when NODE_ENV is production, else warn. */
export function resolveModuleCheckMode(env: Record<string, string | undefined>): ModuleCheckMode {
  const raw = env.WORKER_MODULE_CHECK?.trim().toLowerCase();
  if (!raw) return env.NODE_ENV === "production" ? "refuse" : "warn";
  if (raw === "refuse" || raw === "warn" || raw === "off") return raw;
  throw new Error(`WORKER_MODULE_CHECK must be refuse, warn or off (got "${raw}")`);
}

export interface ModuleCheckOptions {
  sql: Sql;
  workerIds: readonly string[];
  mode: ModuleCheckMode;
  log?: (message: string) => void;
}

/** Throws in `refuse` mode when a deployed module is missing from the worker; logs in `warn`; skips the query in `off`. */
export async function checkWorkerModules({ sql, workerIds, mode, log = (m) => console.warn(m) }: ModuleCheckOptions): Promise<void> {
  if (mode === "off") return;
  const rows = await sql<{ module_id: string }[]>`select module_id from kernel.manifest_hashes`;
  if (rows.length === 0) return; // first boot: nothing deployed yet
  const { missing, extra } = compareModuleLists(workerIds, rows.map((r) => r.module_id));
  if (missing.length === 0) return;
  const detail = `deployed modules missing from this worker image: ${missing.join(", ")}${extra.length ? ` (extra in the worker: ${extra.join(", ")})` : ""}; rebuild the worker image`;
  if (mode === "refuse") throw new Error(`worker module list differs: ${detail}`);
  log(`[worker] WARNING module list differs: ${detail}`);
}
