/**
 * Loads `apps/web/.env.local` into `process.env` for the CLI scripts (`db:seed`, `db:reset`, `help:index`), which Next
 * does not load it for. Variables already set in the environment win. Since 2026-10-29 development runs against a
 * hosted Supabase project (design §22, option 1): the file holds the project URL, the keys and the pooler connection
 * string, so the scripts reach the same database the app does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvLocal(root = join(fileURLToPath(import.meta.url), "..", "..")): void {
  const file = join(root, "apps", "web", ".env.local");
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
