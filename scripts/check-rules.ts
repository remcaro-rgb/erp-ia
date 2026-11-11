/**
 * Mechanical enforcement of docs/project-rules.md. Run with `pnpm check:rules`.
 *
 *  - rule 34: migration files are named NNNN_<module>_<topic>.sql
 *  - rule 24: no Spanish copy in apps/web .tsx outside packages/i18n catalogues
 *  - rule 3:  module processes only write to their own schema (reads of published views are allowed)
 *  - rule 14: apps/web and packages/agent read module tables only through their masked views `<schema>.v_<table>`
 *  - rule 5:  no PUC account code (a 4 to 8 digit string literal) in the posting engine or the accounting module source;
 *             codes live in packages/localization/<country>, the module names roles
 *  - rule 7/§22.23: every table entity declares an entityType (maestro | documento | lines | parametro | sistema, D13);
 *             a maestro or documento has extra / extra_free fields (Datos adicionales); a maestro an importKey, a documento
 *             a typed.lines (header + lines import, D14); a lines entity is named by some parent's typed.lines and every
 *             typed.lines names a lines entity. Export is the grid's generic export, available to every entity, so it
 *             needs no declaration (spec §2.5)
 *  - rule 7/§9.2: a module with menu items (objects with label, href and icon) declares the four menu sections Maestros, Documentos,
 *             Reportes and Parámetros: `menuSections("<module>")`, or the four groups `<module>.maestros|documentos|reportes|parametros`
 *             written out (the loader checks their shape at boot)
 *  - FX §7 (plan 2B.2 Task 34.7): every money column of a report definition (an object literal with `type: "money"` in a module's
 *             `src/reports/`) names its currency: `currency: "company"` or `currency: { field: "<row field>" }`
 *  - CLAUDE.md and AGENTS.md at the root are byte-identical
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type RuleId = "migration-name" | "spanish-literal" | "cross-schema-write" | "masked-view-read" | "unmasked-view-read" | "agents-claude-identical" | "puc-code-outside-pack" | "entity-type" | "menu-sections" | "report-currency";

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
const isTestFile = (path: string) => /\.test\.tsx?$/.test(path) || /(^|\/)(__tests__|e2e|guide-shots|test-support)\//.test(path);
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

/**
 * Module views published unmasked (rule 3 lets processes read them) and the process that reads one for a screen. A page, route handler
 * or apps/web/src/lib file that names one must also call a field-visibility helper, so the screen shows a figure only to who may see
 * its fields (rule 14, plan 2B Task 40). A comment is not a marker: there is no escape hatch.
 */
export const UNMASKED_VIEWS = ["crm.v_quote_offers", "crm.v_quote_offer_lines", "sales.v_invoice_order_lines", "invoicing.v_receivable_invoices", "invoicing.v_open_invoices", "invoicing.v_order_invoiced", "payments.v_invoice_allocations"] as const;
export const UNMASKED_PROCESSES = ["payments.payment.open_invoices"] as const;
/**
 * Views whose fields only one helper vouches for: a file reading them needs that helper's call, not any marker. v_open_invoices and
 * v_order_invoiced feed the pedido's credit «Disponible», which `creditVisibleTo` gates (review F-5.1).
 */
const VIEW_SPECIFIC_MARKER: Readonly<Record<string, RegExp>> = {
  "invoicing.v_open_invoices": /\bcreditVisibleTo\s*\(/,
  "invoicing.v_order_invoiced": /\bcreditVisibleTo\s*\(/,
};
const VISIBILITY_MARKER = /\b(?:gridPageAccess|creditVisibleTo|linkableEntities)\s*\(|\bkernel\.field_visible\s*\(/;

// Best effort and file-level: a marker anywhere in the file (even inside a string literal) satisfies the guard, and `linkableEntities(`
// only proves the entity's visibility, not each field's. Review still checks that the right fields are gated (rule 36).
function checkUnmaskedViewReads(root: string): Violation[] {
  const violations: Violation[] = [];
  const viewRead = new RegExp(`\\b(?:from|join)\\s+(${UNMASKED_VIEWS.map((v) => v.replace(".", "\\.")).join("|")})\\b`, "gi");
  const processCall = new RegExp(`["'\`](${UNMASKED_PROCESSES.map((p) => p.replace(/\./g, "\\.")).join("|")})["'\`]`, "g");
  for (const file of walk(join(root, "apps", "web", "src")).filter((f) => /\.tsx?$/.test(f))) {
    const path = rel(root, file);
    if (isTestFile(path)) continue;
    const text = withoutComments(readFileSync(file, "utf8"));
    const generic = VISIBILITY_MARKER.test(text);
    for (const m of [...text.matchAll(viewRead), ...text.matchAll(processCall)]) {
      const specific = VIEW_SPECIFIC_MARKER[m[1]!.toLowerCase()];
      if (specific ? specific.test(text) : generic) continue;
      violations.push({
        rule: "unmasked-view-read",
        file: path,
        line: text.slice(0, m.index).split("\n").length,
        message: `reads ${m[1]}, published unmasked; the file must check field visibility (gridPageAccess, creditVisibleTo, linkableEntities or kernel.field_visible) first (rule 14)`,
      });
    }
  }
  return violations.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
}

const PUC_CODE = /^[1-9]\d{3,7}$/;

function checkPucCodes(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const dir of [join(root, "packages", "kernel", "src", "posting"), join(root, "packages", "modules", "accounting", "src")]) {
    for (const file of walk(dir).filter((f) => /\.tsx?$/.test(f))) {
      const path = rel(root, file);
      if (isTestFile(path) || /(^|\/)rules\/fixtures\//.test(path)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PUC_CODE.test(node.text)) {
          violations.push({
            rule: "puc-code-outside-pack",
            file: path,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            message: `"${node.text}" looks like a PUC account code; account codes belong to packages/localization/<country>, name the role here (rule 5)`,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return violations.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
}

const ENTITY_ID_LITERAL = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Entity declarations are found statically: an object literal with a string `id` ("module.name"), `table` and `fields`
 * properties, or a call `entity("module.name", ...)` of a module's helper. A call to a local helper is checked together
 * with the helper's own body (the helper may set the type or the importKey for all its entities); `dimension(...)` style
 * helpers that build the id from a parameter are covered because their body holds the inner `entity(...)` call.
 */
export function checkEntityTypes(root: string): Violation[] {
  const violations: Violation[] = [];
  const ROLES = ["maestro", "documento", "lines", "parametro", "sistema"];
  const seen = new Map<string, { role: string; path: string; line: number }>();
  const linesRefs: { parent: string; target: string; path: string; line: number }[] = [];
  const dirs = [join(root, "packages", "kernel", "src"), ...(existsSync(join(root, "packages", "modules")) ? readdirSync(join(root, "packages", "modules")).sort().map((m) => join(root, "packages", "modules", m, "src")) : [])];
  for (const dir of dirs) {
    for (const file of walk(dir).filter((f) => /\.tsx?$/.test(f))) {
      const path = rel(root, file);
      if (isTestFile(path) || /(^|\/)db\/test-db\.ts$/.test(path)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const helpers = new Map<string, ts.Node>();
      const trailers = new Set<string>();
      const stringsIn = (node: ts.Node) => {
        const out = new Set<string>();
        const visit = (n: ts.Node) => {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.add(n.text);
          ts.forEachChild(n, visit);
        };
        visit(node);
        return out;
      };
      const propsIn = (node: ts.Node) => {
        const out = new Map<string, ts.Node>();
        const visit = (n: ts.Node) => {
          if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) out.set(n.name.text, n);
          ts.forEachChild(n, visit);
        };
        visit(node);
        return out;
      };
      const callees = (node: ts.Node) => {
        const out = new Set<string>();
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.add(n.expression.text);
          ts.forEachChild(n, visit);
        };
        visit(node);
        return out;
      };
      for (const stmt of source.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name) helpers.set(stmt.name.text, stmt);
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) helpers.set(d.name.text, d.initializer);
          }
        }
      }
      for (const [name, node] of helpers) {
        const s = stringsIn(node);
        if (s.has("extra") && s.has("extra_free")) trailers.add(name);
      }
      // A local helper builds entities when its body calls `entity(...)` or holds an entity-shaped literal (`table` and `fields`).
      const builders = new Set<string>(["entity"]);
      for (const [name, node] of helpers) {
        const p = propsIn(node);
        if (callees(node).has("entity") || (p.has("fields") && p.has("table"))) builders.add(name);
      }
      const declarations: { id: string; node: ts.Node; extraNodes: ts.Node[] }[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const own = new Map<string, ts.Expression>();
          for (const p of node.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) own.set(p.name.text, p.initializer);
          const id = own.get("id");
          if (id && ts.isStringLiteral(id) && ENTITY_ID_LITERAL.test(id.text) && own.has("table") && own.has("fields")) declarations.push({ id: id.text, node, extraNodes: [] });
        } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text !== "defineEntity") {
          const first = node.arguments[0];
                    if (first && ts.isStringLiteral(first) && ENTITY_ID_LITERAL.test(first.text) && node.arguments.length >= 2 && builders.has(node.expression.text)) {
            // The helpers it calls (transitively) set defaults for it; a spread `{ ...entity(...), importKey }` is checked with its literal.
            const closure: ts.Node[] = [];
            const visited = new Set<string>();
            const walkHelpers = (name: string) => {
              const h = helpers.get(name);
              if (!h || visited.has(name)) return;
              visited.add(name);
              for (const c of callees(h)) walkHelpers(c);
              closure.push(h);
            };
            walkHelpers(node.expression.text);
            const spread = node.parent && ts.isSpreadAssignment(node.parent) ? node.parent.parent : undefined;
            declarations.push({ id: first.text, node, extraNodes: spread ? [...closure, spread] : closure });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const { id, node, extraNodes } of declarations) {
        const scope = [...extraNodes, node]; // the call's own arguments override the helper's defaults
        const props = new Map<string, ts.Node>();
        for (const n of scope) for (const [k, v] of propsIn(n)) props.set(k, v);
        const strings = new Set<string>();
        for (const n of scope) for (const v of stringsIn(n)) strings.add(v);
        const called = new Set<string>();
        for (const n of scope) for (const c of callees(n)) called.add(c);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const add = (message: string) => violations.push({ rule: "entity-type", file: path, line, message: `rule 7/§22.23: ${id} ${message}` });
        const kind = props.get("kind");
        if (kind && ts.isPropertyAssignment(kind) && ts.isStringLiteral(kind.initializer) && kind.initializer.text === "query") continue;
        // The role: an `entityType: "<role>"` property (the call's own object wins over a helper's default), else the
        // second argument of the builder call (`entity("core.x", "maestro", ...)`), else the one a helper passes on.
        let role: string | undefined;
        for (const n of [...scope].reverse()) {
          const t = propsIn(n).get("entityType");
          if (t && ts.isPropertyAssignment(t) && ts.isStringLiteral(t.initializer) && ROLES.includes(t.initializer.text)) {
            role = t.initializer.text;
            break;
          }
        }
        const roleArg = (call: ts.Node): string | undefined => {
          if (!ts.isCallExpression(call)) return undefined;
          const a = call.arguments[1];
          return a && ts.isStringLiteral(a) && ROLES.includes(a.text) ? a.text : undefined;
        };
        if (!role) role = roleArg(node);
        if (!role) {
          const find = (n: ts.Node) => {
            if (role) return;
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && builders.has(n.expression.text)) role = roleArg(n);
            ts.forEachChild(n, find);
          };
          for (const n of extraNodes) find(n);
        }
        if (!role) {
          add("has no entityType");
          continue;
        }
        seen.set(id, { role, path, line });
        const lines = props.get("lines");
        if (lines && ts.isPropertyAssignment(lines) && ts.isObjectLiteralExpression(lines.initializer)) {
          const target = lines.initializer.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "entity");
          if (target && ts.isStringLiteral(target.initializer)) linesRefs.push({ parent: id, target: target.initializer.text, path, line });
        }
        if (role !== "maestro" && role !== "documento") continue; // lines, parametro and sistema carry no typed checks (D13)
        const hasExtra = (strings.has("extra") && strings.has("extra_free")) || [...called].some((c) => trailers.has(c));
        if (!hasExtra) add(`is ${role} and has no extra / extra_free fields (Datos adicionales)`);
        if (role === "maestro" && !props.has("importKey")) add(`is maestro and has no importKey (import and export are required, spec 2.5)`);
        if (role === "documento" && !lines) add(`is documento and has no typed.lines (header + lines import, D14)`);
      }
    }
  }
  const named = new Set(linesRefs.map((r) => r.target));
  for (const [id, { role, path, line }] of seen) {
    if (role === "lines" && !named.has(id)) violations.push({ rule: "entity-type", file: path, line, message: `rule 7/§22.23: ${id} is lines and no entity names it in typed.lines` });
  }
  for (const ref of linesRefs) {
    const target = seen.get(ref.target);
    if (!target || target.role !== "lines") violations.push({ rule: "entity-type", file: ref.path, line: ref.line, message: `rule 7/§22.23: ${ref.parent} typed.lines names ${ref.target}, which is not a lines entity` });
  }
  return violations.sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
}

/**
 * Rule 7 / entity types spec §9.2: the menu sections of every module. A module's id is the `id` of its `defineModule({ … })` call (else
 * its directory name); its menu items are object literals with `label`, `href` and `icon`; tests are skipped.
 */
export function checkMenuSections(root: string): Violation[] {
  const modulesDir = join(root, "packages", "modules");
  if (!existsSync(modulesDir)) return [];
  const violations: Violation[] = [];
  for (const name of readdirSync(modulesDir).sort()) {
    const files = walk(join(modulesDir, name, "src")).filter((f) => /\.tsx?$/.test(f) && !isTestFile(rel(root, f)));
    let moduleId = name;
    let firstMenuFile: string | null = null;
    const calls = new Set<string>();
    const strings = new Set<string>();
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.add(node.text);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const [first] = node.arguments;
          if (node.expression.text === "menuSections" && first && ts.isStringLiteral(first)) calls.add(first.text);
          if (node.expression.text === "defineModule" && first && ts.isObjectLiteralExpression(first)) {
            const id = first.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "id");
            if (id && ts.isStringLiteral(id.initializer)) moduleId = id.initializer.text;
          }
        }
        if (ts.isObjectLiteralExpression(node) && firstMenuFile === null) {
          const keys = new Set(node.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "")));
          if (keys.has("label") && keys.has("href") && keys.has("icon")) firstMenuFile = rel(root, file);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (firstMenuFile === null) continue;
    const sections = ["maestros", "documentos", "reportes", "parametros"];
    if (calls.has(moduleId) || sections.every((s) => strings.has(`${moduleId}.${s}`))) continue;
    violations.push({
      rule: "menu-sections",
      file: firstMenuFile,
      message: `rule 7/§9.2: module ${moduleId} has a menu but not the sections Maestros, Documentos, Reportes and Parámetros (menuSections("${moduleId}"))`,
    });
  }
  return violations;
}

/**
 * FX §7: no report sums two currencies into one figure, so every money column of a report says whose currency its figures are in: the
 * company's (`currency: "company"`) or the one a field of each row holds (`currency: { field: "currency" }`). Tests are skipped.
 */
export function checkReportCurrencies(root: string): Violation[] {
  const modulesDir = join(root, "packages", "modules");
  if (!existsSync(modulesDir)) return [];
  const violations: Violation[] = [];
  for (const name of readdirSync(modulesDir).sort()) {
    const dir = join(modulesDir, name, "src", "reports");
    if (!existsSync(dir)) continue;
    for (const file of walk(dir).filter((f) => /\.tsx?$/.test(f))) {
      const path = rel(root, file);
      if (isTestFile(path)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const own = new Map<string, ts.Expression>();
          // `"money" as const` is the same declaration as `"money"`.
          const bare = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? bare(e.expression) : e);
          for (const p of node.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) own.set(p.name.text, bare(p.initializer));
          const shorthand = node.properties.some((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === "field");
          const type = own.get("type");
          if (type && ts.isStringLiteral(type) && type.text === "money" && (own.has("field") || shorthand)) {
            const currency = own.get("currency");
            const fieldOf = (e: ts.Expression) => ts.isObjectLiteralExpression(e) && e.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "field" && ts.isStringLiteral(p.initializer));
            const ok = currency !== undefined && ((ts.isStringLiteral(currency) && currency.text === "company") || fieldOf(currency));
            if (!ok) {
              violations.push({
                rule: "report-currency", file: path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                message: 'FX §7: a report money column names its currency: currency: "company" or currency: { field: "<row field>" }',
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return violations;
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
  return [...checkMigrations(root), ...checkSpanishLiterals(root), ...checkCrossSchemaWrites(root), ...checkMaskedViewReads(root), ...checkUnmaskedViewReads(root), ...checkPucCodes(root), ...checkEntityTypes(root), ...checkMenuSections(root), ...checkReportCurrencies(root), ...checkInstructionFiles(root)];
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
