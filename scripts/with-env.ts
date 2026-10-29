/**
 * Runs a command with apps/web/.env.local loaded: `pnpm with-env <command> [args…]`. For the suites and tools that do not
 * read the file themselves (vitest, playwright, the Supabase CLI) when developing against the hosted project.
 */
import { spawnSync } from "node:child_process";
import "./env";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: pnpm with-env <command> [args…]");
  process.exit(2);
}
const run = spawnSync(command, args, { stdio: "inherit", env: process.env });
process.exit(run.status ?? 1);
