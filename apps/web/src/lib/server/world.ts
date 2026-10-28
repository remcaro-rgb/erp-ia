import "server-only";
import { infra } from "@erp/infra";

// The Workflow World of this process (design §21, rule 6). On Vercel the runtime picks the Vercel World by itself. In
// Docker (`ERP_TARGET=docker`) it loads `@workflow/world-postgres`, named by `WORKFLOW_TARGET_WORLD`, through a
// runtime require from the app root: the import below keeps the package (an external, see next.config.ts) in the
// standalone output, and the check fails the boot when the Postgres World wiring is missing instead of failing the
// first run. The web process does not consume the queue: the worker container does (`world.start()`), delivering
// every workflow and step invocation to this app's /.well-known/workflow/v1/flow route.

/** Validates the Docker World wiring and loads the Postgres World package; nothing to do on Vercel. */
export async function checkWorkflowWorld(): Promise<void> {
  if (infra.target() !== "docker") return;
  infra.durableRunner();
  await import("@workflow/world-postgres");
}
