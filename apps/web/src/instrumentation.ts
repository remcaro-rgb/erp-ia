// Runs once when the server starts (Next.js instrumentation): the kernel registers the loaded modules' manifests in SQL
// at boot (design §5.2), before any request, so a confidential field a module brings for the first time is masked for
// the roles that exist at that moment and not later under a user's feet. A failure (database not up yet) is logged;
// the shell retries it on the first request (lib/server/runtime.ts `registrySynced`).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A production build never reaches a database.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Docker: the Postgres World wiring is checked before anything starts a run (lib/server/world.ts).
  const { checkWorkflowWorld } = await import("./lib/server/world");
  await checkWorkflowWorld();
  const { registrySynced } = await import("./lib/server/runtime");
  try {
    await registrySynced();
  } catch (error) {
    console.error("registry sync at boot failed; retrying on the first request", error);
  }
}
