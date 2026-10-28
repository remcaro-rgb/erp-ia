import { required, type Env } from "./target";

// Durable work (rule 6: only through `workflow`). The same `"use workflow"` code runs on both targets; what differs is
// the World that stores the runs and delivers their queue messages (design §21):
//  - vercel: the Vercel-managed World, detected by the runtime inside a deployment (the Local World in `next dev`);
//  - docker: the Workflow Postgres World (`@workflow/world-postgres`) in the compose Postgres, selected by
//    `WORKFLOW_TARGET_WORLD` and `WORKFLOW_POSTGRES_URL` (node_modules/workflow/docs/worlds/postgres.mdx). Its
//    graphile-worker queue is consumed by the long-running worker container (apps/worker), which delivers every
//    workflow and step invocation to the web app's `/.well-known/workflow/v1/flow` route.

/** The Postgres World's package, the value `WORKFLOW_TARGET_WORLD` takes in Docker. */
export const POSTGRES_WORLD = "@workflow/world-postgres";

export interface DurableRunner {
  /** `vercel`: the platform's World; otherwise the World package in use. */
  readonly world: "vercel" | typeof POSTGRES_WORLD;
  /** Enqueues a run of a compiled `"use workflow"` function and answers its id (it does not wait for the run). */
  start<Args extends unknown[]>(workflow: (...args: Args) => Promise<unknown>, args: Args): Promise<{ runId: string }>;
  /**
   * Subscribes this process to the World's queue (`world.start()`): only a long-running worker does it, and only a
   * World with a background worker has anything to start (the Vercel World delivers over HTTP, so it is a no-op).
   */
  startWorld(): Promise<void>;
}

class WorkflowRunner implements DurableRunner {
  constructor(readonly world: DurableRunner["world"]) {}

  async start<Args extends unknown[]>(workflow: (...args: Args) => Promise<unknown>, args: Args): Promise<{ runId: string }> {
    const { start } = await import("workflow/api");
    const run = await start(workflow as never, args as never);
    return { runId: run.runId };
  }

  async startWorld(): Promise<void> {
    if (this.world === "vercel") return;
    const { getWorld } = await import("workflow/runtime");
    const world = await getWorld();
    await world.start?.();
  }
}

/** The cloud runner: the World the Workflow runtime selects by itself on Vercel. */
export function cloudDurableRunner(): DurableRunner {
  return new WorkflowRunner("vercel");
}

/** The Docker runner: the Postgres World; refuses to exist without its wiring, so a misconfigured worker fails at boot. */
export function dockerDurableRunner(env: Env = process.env): DurableRunner {
  const world = required(env, "WORKFLOW_TARGET_WORLD", `(set it to ${POSTGRES_WORLD} for ERP_TARGET=docker)`);
  if (world !== POSTGRES_WORLD) throw new Error(`WORKFLOW_TARGET_WORLD must be ${POSTGRES_WORLD} for ERP_TARGET=docker (got "${world}")`);
  required(env, "WORKFLOW_POSTGRES_URL", "for ERP_TARGET=docker (the Postgres World's database)");
  return new WorkflowRunner(POSTGRES_WORLD);
}
