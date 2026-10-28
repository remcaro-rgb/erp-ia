/**
 * Mechanical enforcement of docs/project-rules.md. Run with `pnpm check:rules`.
 *
 *  - rule 34: migration files are named NNNN_<module>_<topic>.sql
 *  - rule 24: no Spanish copy in apps/web .tsx outside packages/i18n catalogues
 *  - rule 3:  module processes only write to their own schema (reads of published views are allowed)
 *  - rule 14: apps/web and packages/agent read module tables only through their masked views `<schema>.v_<table>`
 *  - CLAUDE.md and AGENTS.md at the root are byte-identical
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type RuleId = "migration-name" | "spanish-literal" | "cross-schema-write" | "masked-view-read" | "agents-claude-identical";

export interface Violation {
  rule: RuleId;
  file: string; // repo-relative, forward slashes
  line?: number;
  message: string;
}

export const MIGRATION_NAME = /^\d{4}_[a-z]+_[a-z0-9_]+\.sql$/;
const SPANISH_CHARS = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/;
const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist", "coverage"]);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (root: string, file: string) => relative(root, file).split(sep).join("/");

function checkMigrations(root: string): Violation[] {
  const dir = join(root, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((name) => name !== ".keep" && !MIGRATION_NAME.test(name))
    .map((name) => ({
      rule: "migration-name" as const,
      file: `supabase/migrations/${name}`,
      message: `migration "${name}" must match ${MIGRATION_NAME} (NNNN_<module>_<topic>.sql)`,
    }));
}

function checkSpanishLiterals(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(join(root, "apps", "web")).filter((f) => f.endsWith(".tsx"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const isText =
        ts.isJsxText(node) ||
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (isText && SPANISH_CHARS.test(node.getText(source))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
          rule: "spanish-literal",
          file: rel(root, file),
          line: line + 1,
          message: "Spanish copy must come from packages/i18n, not from a literal in apps/web",
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

// Write verbs followed by `<schema>.`: insert into / update / delete from / truncate / alter table / create ...
const SQL_WRITE =
  /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?|create\s+(?:or\s+replace\s+)?(?:table|view|function|trigger|index|policy))\s+"?([a-z_][a-z0-9_]*)\./gi;
// supabase-js style: from("<schema>.<table>") followed by a write call.
const CLIENT_WRITE = /\bfrom\s*\(\s*["'`]([a-z_][a-z0-9_]*)\.[^"'`]*["'`]\s*\)\s*\.(?:insert|update|upsert|delete)\b/gi;

function checkCrossSchemaWrites(root: string): Violation[] {
  const violations: Violation[] = [];
  const modulesDir = join(root, "packages", "modules");
  if (!existsSync(modulesDir)) return violations;
  for (const mod of readdirSync(modulesDir).sort()) {
    const processesDir = join(modulesDir, mod, "src", "processes");
    for (const file of walk(processesDir).filter((f) => /\.(ts|tsx|sql)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [SQL_WRITE, CLIENT_WRITE]) {
        for (const m of text.matchAll(pattern)) {
          const schema = m[1]!.toLowerCase();
          if (schema === mod) continue;
          violations.push({
            rule: "cross-schema-write",
            file: rel(root, file),
            line: text.slice(0, m.index).split("\n").length,
            message: `module "${mod}" writes to schema "${schema}"; use a published process or an outbox event`,
          });
        }
      }
    }
  }
  return violations.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
}

// `from <schema>.<table>` / `join <schema>.<table>` in a select. Platform schemas (kernel, auth…) hold no registry
// entities and have no masked views; module schemas do, and grids, exports and the assistant must read those.
const TABLE_READ = /\b(from|join)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
const PLATFORM_SCHEMAS = new Set(["kernel", "auth", "storage", "extensions", "public", "pg_catalog", "information_schema", "realtime", "vault", "cron"]);
const isTestFile = (path: string) => /\.test\.tsx?$/.test(path) || /(^|\/)(__tests__|e2e|test-support)\//.test(path);
/** Blanks comments, keeping line breaks so line numbers stay right. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));

function checkMaskedViewReads(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const dir of [join(root, "apps", "web"), join(root, "packages", "agent")]) {
    for (const file of walk(dir).filter((f) => /\.tsx?$/.test(f))) {
      const path = rel(root, file);
      if (isTestFile(path)) continue;
      const text = withoutComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(TABLE_READ)) {
        const [, verb, schema, table] = m as unknown as [string, string, string, string];
        if (PLATFORM_SCHEMAS.has(schema.toLowerCase()) || table.toLowerCase().startsWith("v_")) continue;
        const before = text.slice(Math.max(0, m.index - 500), m.index);
        if (verb.toLowerCase() === "from" && /\bdelete\s+$/i.test(before)) continue;
        if (!/\bselect\b/i.test(before)) continue;
        violations.push({
          rule: "masked-view-read",
          file: path,
          line: text.slice(0, m.index).split("\n").length,
          message: `reads ${schema}.${table} directly; read ${schema}.v_${table} so field visibility applies (rule 14)`,
        });
      }
    }
  }
  return violations.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
}

function checkInstructionFiles(root: string): Violation[] {
  const claude = join(root, "CLAUDE.md");
  const agents = join(root, "AGENTS.md");
  if (!existsSync(claude) || !existsSync(agents)) return [];
  if (readFileSync(claude).equals(readFileSync(agents))) return [];
  return [
    {
      rule: "agents-claude-identical",
      file: "AGENTS.md",
      message: "AGENTS.md must be byte-identical to CLAUDE.md",
    },
  ];
}

export function checkRules(root: string): Violation[] {
  return [...checkMigrations(root), ...checkSpanishLiterals(root), ...checkCrossSchemaWrites(root), ...checkMaskedViewReads(root), ...checkInstructionFiles(root)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const violations = checkRules(root);
  for (const v of violations) {
    console.error(`${v.file}${v.line ? `:${v.line}` : ""}  [${v.rule}]  ${v.message}`);
  }
  if (violations.length > 0) {
    console.error(`\ncheck:rules failed with ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("check:rules passed");
}
