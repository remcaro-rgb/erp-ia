import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { messages, type Messages } from "../index";

const ROOT = join(import.meta.dirname, "../../../..");
const SOURCE_DIRS = ["apps/web/src", "packages/ui/src", "packages/modules/accounting/src", "packages/agent/src"];

/** Template prefixes the code builds keys from; every key below one counts as used. */
const TEMPLATE_PREFIXES = ["accounting.values.", "accounting.master.", "accounting.pages.reports.desc."];

function leaves(tree: Messages, prefix: string): string[] {
  return Object.entries(tree).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`)));
}

// Tracked and new (untracked, not ignored) files of the working tree; a tracked file deleted in the tree is left out.
const sourceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...SOURCE_DIRS.map((d) => `${d}/*.ts`), ...SOURCE_DIRS.map((d) => `${d}/*.tsx`)], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.includes(".test.") && existsSync(join(ROOT, f)));
const source = sourceFiles.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

const es = messages("es-419");
const en = messages("en");
const accounting = (tree: Messages) => (typeof tree.accounting === "object" ? leaves(tree.accounting, "accounting.") : []);

/**
 * A key is used when its full path appears in source, when it lies under a listed template prefix that appears in source,
 * or when its parent namespace is passed to `useTranslations`/`getTranslations` and the key (or its template stem, `niif_1` → `niif_`) is named there.
 */
function used(key: string): boolean {
  const prefix = TEMPLATE_PREFIXES.find((p) => key.startsWith(p));
  if (prefix) return source.includes(prefix);
  if (source.includes(key)) return true;
  const parts = key.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const namespace = parts.slice(0, i).join(".");
    if (!source.includes(`Translations("${namespace}")`)) continue;
    const rest = parts.slice(i).join(".");
    const stem = rest.replace(/_[a-z0-9]+$/, "_");
    const segments = rest.split(".");
    // the key itself, its template stem, or an ancestor group built into a template (`col.${name}`)
    const names = [rest, stem, ...segments.slice(0, -1).map((_, n) => `${segments.slice(0, n + 1).join(".")}.`)];
    if (names.some((name) => source.includes(`"${name}`) || source.includes(`\`${name}`))) return true;
  }
  return false;
}

describe("accounting.* copy", () => {
  it("exists in both catalogues", () => {
    expect(accounting(es).length).toBeGreaterThan(100);
    expect(accounting(en).sort()).toEqual(accounting(es).sort());
  });

  it("has no key that no source file names", () => {
    const orphans = accounting(es).filter((key) => !used(key));
    expect(orphans).toEqual([]);
  });

  it("every literal accounting.* key in source resolves in both catalogues", () => {
    const keys = new Set(accounting(es));
    const prefixes = new Set(accounting(es).flatMap((k) => k.split(".").map((_, i, parts) => parts.slice(0, i + 1).join("."))));
    const literals = [...source.matchAll(/\bt\(\s*["'`](accounting\.[a-z0-9_.]+)["'`]/g)].map((m) => m[1]!);
    const missing = literals.filter((key) => !keys.has(key) && !prefixes.has(key));
    expect(missing).toEqual([]);
  });
});
