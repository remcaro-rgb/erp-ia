/**
 * Loads `apps/web/.env.local` (or the file `ENV_FILE` names, repo-relative) into `process.env` for the CLI scripts
 * (`db:seed`, `db:reset`, `help:index`, `with-env`), which Next does not load it for. Variables already set in the
 * environment win. Decision 2026-10-29: development runs on the local stack (.env.local); the owner's hosted project is
 * the shared demo and the Vercel deployment, reached through `pnpm hosted …` (.env.hosted.local).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The file to load: `ENV_FILE` (repo-relative) when set, else apps/web/.env.local. `pnpm hosted …` sets it to .env.hosted.local. */
export function loadEnvLocal(root = join(fileURLToPath(import.meta.url), "..", "..")): void {
  const file = join(root, process.env.ENV_FILE ?? join("apps", "web", ".env.local"));
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();
