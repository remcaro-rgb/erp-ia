/**
 * Mechanical enforcement of docs/project-rules.md. Run with `pnpm check:rules`.
 *
 *  - rule 34: migration files are named NNNN_<module>_<topic>.sql
 *  - rule 24: no Spanish copy in apps/web .tsx outside packages/i18n catalogues
 *  - rule 3:  module processes only write to their own schema
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type RuleId = "migration-name" | "spanish-literal" | "cross-schema-write";

export interface Violation {
  rule: RuleId;
  file: string; // repo-relative, forward slashes
  line?: number;
  message: string;
}

export const MIGRATION_NAME = /^\d{4}[a-z]?_[a-z]+_[a-z0-9_]+\.sql$/;
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

function checkCrossSchemaWrites(root: string): Violation[] {
  const violations: Violation[] = [];
  const modulesDir = join(root, "packages", "modules");
  if (!existsSync(modulesDir)) return violations;
  for (const mod of readdirSync(modulesDir).sort()) {
    const processesDir = join(modulesDir, mod, "src", "processes");
    // Raw SQL writes, and supabase-js style `from("<schema>.<table>")`.
    const writesTo = (schema: string) =>
      new RegExp(
        `(?:\\binsert\\s+into|\\bupdate|\\bdelete\\s+from|\\btruncate(?:\\s+table)?|\\bfrom\\s*\\(?\\s*)\\s*["'\`]?${schema}\\.`,
        "i",
      );
    for (const file of walk(processesDir).filter((f) => /\.(ts|tsx|sql)$/.test(f))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, index) => {
          const match = /\b([a-z_][a-z0-9_]*)\.[a-z_]/gi;
          for (const m of text.matchAll(match)) {
            const schema = m[1]!.toLowerCase();
            if (schema === mod || !writesTo(schema).test(text)) continue;
            violations.push({
              rule: "cross-schema-write",
              file: rel(root, file),
              line: index + 1,
              message: `module "${mod}" writes to schema "${schema}"; use a published process or an outbox event`,
            });
            break;
          }
        });
    }
  }
  return violations;
}

export function checkRules(root: string): Violation[] {
  return [...checkMigrations(root), ...checkSpanishLiterals(root), ...checkCrossSchemaWrites(root)];
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
