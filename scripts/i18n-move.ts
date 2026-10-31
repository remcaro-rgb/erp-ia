/**
 * Moves catalogue keys between paths in both locales and rewrites the literal keys in source.
 * Dry run by default; `--write` applies. Used once for OD-3 (accounting page copy under `accounting.*`, 2026-10-30).
 *   pnpm tsx scripts/i18n-move.ts [--write]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Tree = { [key: string]: string | Tree };

/** [from, to] key paths; a path moves with everything below it. */
export const MOVES: [string, string][] = [
  ["common.entry", "accounting.entry"],
  ["common.acc_record", "accounting.record"],
  ["common.acc_pages", "accounting.pages"],
  ["grid.master", "accounting.master"],
  ...["account_level", "nature", "account_access", "dimension_kind", "journal_kind", "entry_status", "entry_origin", "period_status", "close_check", "failure_code", "failure_status", "subject_kind", "niif_group"].map(
    (name): [string, string] => [`grid.values.${name}`, `accounting.values.${name}`],
  ),
];

const ROOT = join(import.meta.dirname, "..");
const MESSAGES = ["packages/i18n/messages/es-419.json", "packages/i18n/messages/en.json"];
const SOURCE_DIRS = ["apps/web/src", "packages/ui/src", "packages/modules/accounting/src", "packages/i18n/src", "packages/agent/src"];

function take(tree: Tree, path: string): string | Tree {
  const parts = path.split(".");
  let node: Tree = tree;
  for (const part of parts.slice(0, -1)) node = node[part] as Tree;
  const last = parts[parts.length - 1]!;
  const value = node[last];
  if (value === undefined) throw new Error(`missing key ${path}`);
  delete node[last];
  return value;
}

function put(tree: Tree, path: string, value: string | Tree): void {
  const parts = path.split(".");
  let node: Tree = tree;
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Tree;
  const last = parts[parts.length - 1]!;
  if (node[last] !== undefined) throw new Error(`target exists ${path}`);
  node[last] = value;
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

/** Rewrites `from` to `to` where it is a whole key path: followed by `.`, a quote, a backtick or `$`, not preceded by a key character. */
export function rewrite(source: string): string {
  let out = source;
  for (const [from, to] of MOVES) {
    const pattern = new RegExp(`(?<![\\w.])${from.replace(/\./g, "\\.")}(?=[.'"\`$])`, "g");
    out = out.replace(pattern, to);
  }
  return out;
}

const write = process.argv.includes("--write");

for (const rel of MESSAGES) {
  const path = join(ROOT, rel);
  const tree = JSON.parse(readFileSync(path, "utf8")) as Tree;
  for (const [from, to] of MOVES) put(tree, to, take(tree, from));
  console.log(`${write ? "wrote" : "would write"} ${rel}`);
  if (write) writeFileSync(path, `${JSON.stringify(tree, null, 2)}\n`);
}

let changed = 0;
for (const dir of SOURCE_DIRS) {
  for (const file of files(join(ROOT, dir))) {
    const before = readFileSync(file, "utf8");
    const after = rewrite(before);
    if (after === before) continue;
    changed++;
    console.log(`${write ? "rewrote" : "would rewrite"} ${file.slice(ROOT.length + 1)}`);
    if (write) writeFileSync(file, after);
  }
}
console.log(`${changed} source files`);
