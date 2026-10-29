/**
 * Runs a command with apps/web/.env.local loaded: `pnpm with-env <command> [args…]`, or with another file:
 * `pnpm with-env --env apps/web/.env.hosted.local <command>` (what `pnpm hosted …` does). For the suites and tools that
 * do not read the file themselves (vitest, playwright, the Supabase CLI).
 */
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
if (argv[0] === "--env" && argv[1]) {
  process.env.ENV_FILE = argv[1];
  argv.splice(0, 2);
}
await import("./env");
const [command, ...args] = argv;
if (!command) {
  console.error("usage: pnpm with-env <command> [args…]");
  process.exit(2);
}
const run = spawnSync(command, args, { stdio: "inherit", env: process.env });
process.exit(run.status ?? 1);
