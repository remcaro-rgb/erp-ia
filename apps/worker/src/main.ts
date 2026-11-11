import { hostname } from "node:os";
import { infra, runEvery } from "@erp/infra";
import { translate } from "@erp/i18n";
import { getServiceDb, loadModules, registerCatalogue, registry, syncRegistry } from "@erp/kernel";
import { logDeliveries } from "./delivery-log";
import { checkWorkerModules, resolveModuleCheckMode } from "./module-check";
import { WORKER_MODULES } from "./modules";
import { tickOutbox } from "./tick";

// The Docker worker (design §21, rule 6): the long-running process the Workflow Postgres World needs and Vercel does
// not. It
//  0. checks its module list against kernel.manifest_hashes (module-check.ts: refuse in production, warn elsewhere, WORKER_MODULE_CHECK);
//  1. loads the modules the web app ships (modules.ts: the web runtime's list, kept equal by its test) and registers their manifests in SQL, as the web
//     app's instrumentation does at boot (design §5.2);
//  2. starts the Postgres World (`world.start()`, node_modules/workflow/docs/worlds/postgres.mdx): its graphile runner
//     claims queued workflow and step jobs (outbox dispatch, import, export, assistant turn) and delivers each to the
//     web app's /.well-known/workflow/v1/flow route (`WORKFLOW_LOCAL_BASE_URL`), where the compiled workflow code
//     runs. In world-postgres 5 every process that enqueues also starts a runner, so the web app consumes too; the
//     worker is the consumer that is always on (retries, runs re-enqueued at start, no web traffic). Each delivery it
//     makes is logged with its name (delivery-log.ts);
//  3. ticks the outbox every 30 s through the web app's POST /api/internal/outbox/tick (backing off while it fails).
// Its healthcheck is `workflow health --backend @workflow/world-postgres`: a message through the queue to the flow
// route and back.

const TICK_INTERVAL_MS = Number(process.env.OUTBOX_TICK_INTERVAL_MS ?? 30_000);
const SYNC_RETRY_MS = 2_000;
const SYNC_ATTEMPTS = 30;

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the worker`);
  return value;
}

const log = (message: string, extra?: unknown) => console.log(`[worker] ${message}`, ...(extra === undefined ? [] : [extra]));

/** Registers the manifests, retrying while the database is still coming up. */
async function syncManifests(): Promise<void> {
  loadModules(registry, WORKER_MODULES);
  // What the kernel prints or mails outside a screen (PDF labels and page numbers, the state e-mails' subject and body) reads the app's
  // catalogue (rule 24), as the web runtime registers it: any kernel code this process runs speaks Spanish, not catalogue keys.
  registerCatalogue(translate);
  for (let attempt = 1; ; attempt++) {
    try {
      await syncRegistry(getServiceDb(), registry);
      log(`registry synced: ${registry.modules().map((m) => m.id).join(", ")}`);
      return;
    } catch (error) {
      if (attempt >= SYNC_ATTEMPTS) throw error;
      log(`registry sync failed (attempt ${attempt}), retrying`, error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_MS));
    }
  }
}

async function main(): Promise<void> {
  if (infra.target() !== "docker") throw new Error("the worker runs with ERP_TARGET=docker only (Vercel needs none)");
  const runner = infra.durableRunner();
  const webUrl = env("WORKFLOW_LOCAL_BASE_URL");
  const token = env("INTERNAL_TOKEN");

  // Before the worker's own sync overwrites the picture: is this image as new as what is deployed? (Task 48, WORKER_MODULE_CHECK)
  await checkWorkerModules({ sql: getServiceDb(), workerIds: WORKER_MODULES.map((m) => m.id), mode: resolveModuleCheckMode(process.env) });
  await syncManifests();
  logDeliveries(process.env.WORKER_NAME?.trim() || hostname());
  await runner.startWorld();
  log(`Postgres World started; delivering to ${webUrl}/.well-known/workflow/v1/flow`);

  const stop = runEvery(
    TICK_INTERVAL_MS,
    async () => {
      const dispatched = await tickOutbox({ webUrl, token });
      if (dispatched > 0) log(`outbox tick: ${dispatched} dispatch run(s) started`);
    },
    (error) => log("outbox tick failed", error instanceof Error ? error.message : error),
  );
  // graphile-worker handles SIGTERM/SIGINT itself (graceful stop of the queue); the tick loop stops with it.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, stop);
}

main().catch((error: unknown) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
