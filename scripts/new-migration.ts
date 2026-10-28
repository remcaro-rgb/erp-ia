/**
 * Creates the next forward-only migration: `pnpm db:migrate:new <module> <topic>`.
 * Rule 34: names are NNNN_<module>_<topic>.sql with a purely numeric 4-digit prefix,
 * the only form the Supabase CLI applies in order.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATION_NAME } from "./check-rules";

/** Creates the file and returns its repo-relative path. Throws when the name breaks rule 34. */
export function createMigration(root: string, module: string, topic: string): string {
  const dir = join(root, "supabase", "migrations");
  const existing = existsSync(dir) ? readdirSync(dir) : [];
  const last = existing.reduce((max, name) => {
    const n = /^(\d{4})/.exec(name);
    return n ? Math.max(max, Number(n[1])) : max;
  }, 0);
  const base = `${String(last + 1).padStart(4, "0")}_${module}_${topic}`;
  const name = `${base}.sql`;
  if (!/^[a-z]+$/.test(module) || !MIGRATION_NAME.test(name)) {
    throw new Error(`migration name "${name}" must match ${MIGRATION_NAME} (NNNN_<module>_<topic>.sql)`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `-- ${base}\n-- Forward-only migration (rule 34). Cover it with an integration test.\n`, { flag: "wx" });
  return `supabase/migrations/${name}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [module = "", topic = ""] = process.argv.slice(2);
  try {
    console.log(createMigration(join(fileURLToPath(import.meta.url), "..", ".."), module, topic));
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: pnpm db:migrate:new <module> <topic>`);
    process.exit(1);
  }
}
