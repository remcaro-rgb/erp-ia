/**
 * `pnpm db:reset`: rebuilds the development database from the migrations and supabase/seed.sql. With a hosted
 * DATABASE_URL in apps/web/.env.local (the owner's shared, wipeable development project since 2026-10-29) it resets
 * that database through the CLI's `--db-url`; with none, or a local one, it resets the CLI's Docker stack as before.
 * Then run `DEMO_SEED=1 pnpm db:seed` for the demo company.
 */
import { spawnSync } from "node:child_process";
import "./env";

const url = process.env.DATABASE_URL;
const host = url ? new URL(url).hostname : "localhost";
const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) || host.endsWith(".localhost");
const args = local ? ["db", "reset"] : ["db", "reset", "--db-url", url!, "--yes"];
console.log(local ? "Resetting the local Supabase stack…" : `Resetting the hosted database at ${host}…`);
const run = spawnSync("supabase", args, { stdio: "inherit" });
process.exit(run.status ?? 1);
