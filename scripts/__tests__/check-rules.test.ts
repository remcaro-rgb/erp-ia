import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRules } from "../check-rules";

let root: string;

function put(rel: string, content = "") {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-rules-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-rules: migration names (rule 34)", () => {
  it("accepts NNNN_module_topic.sql", () => {
    put("supabase/migrations/.keep");
    put("supabase/migrations/0001_kernel_tenancy.sql");
    put("supabase/migrations/0006_kernel_attachments.sql");
    expect(checkRules(root)).toEqual([]);
  });

  it("flags a migration without module and topic", () => {
    put("supabase/migrations/0006_core.sql");
    const violations = checkRules(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: "migration-name",
      file: "supabase/migrations/0006_core.sql",
    });
  });

  it("flags a migration with a timestamp-style, letter-suffixed or uppercase name", () => {
    put("supabase/migrations/20261028010101_init.sql");
    put("supabase/migrations/0002_Kernel_audit.sql");
    put("supabase/migrations/0006b_kernel_attachments.sql");
    expect(checkRules(root).map((v) => v.rule)).toEqual([
      "migration-name",
      "migration-name",
      "migration-name",
    ]);
  });
});

describe("check-rules: Spanish literals in apps/web (rule 24)", () => {
  it("flags Spanish JSX text outside i18n", () => {
    put("apps/web/src/app/page.tsx", "export default function P() { return <h1>Configuración</h1>; }\n");
    const violations = checkRules(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: "spanish-literal",
      file: "apps/web/src/app/page.tsx",
      line: 1,
    });
  });

  it("flags Spanish string literals, including JSX attributes", () => {
    put("apps/web/src/a.tsx", 'export const A = () => <input placeholder="¿Cómo te llamas?" />;\n');
    expect(checkRules(root).map((v) => v.rule)).toEqual(["spanish-literal"]);
  });

  it("ignores accents in comments, English copy and non-web files", () => {
    put(
      "apps/web/src/ok.tsx",
      "// Configuración en comentario\nexport const Ok = () => <h1>{t('settings.title')}</h1>;\n",
    );
    put("packages/i18n/src/es-419.tsx", "export const es = { title: 'Configuración' };\n");
    expect(checkRules(root)).toEqual([]);
  });
});

describe("check-rules: cross-schema writes in module processes (rule 3)", () => {
  it("flags an insert into another module's schema", () => {
    put(
      "packages/modules/sales/src/processes/create.ts",
      "export const h = (tx) => tx`insert into core.parties(id) values (${1})`;\n",
    );
    const violations = checkRules(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: "cross-schema-write",
      file: "packages/modules/sales/src/processes/create.ts",
      line: 1,
    });
  });

  it("flags update, delete and supabase-style from(\"schema.table\") on another schema", () => {
    put(
      "packages/modules/core/src/processes/x.ts",
      [
        "tx`update support.tickets set status = 'x'`;",
        "tx`delete from kernel.roles`;",
        'db.from("support.tickets").insert({});',
      ].join("\n"),
    );
    expect(checkRules(root).map((v) => v.line)).toEqual([1, 2, 3]);
  });

  it("flags a statement split across lines", () => {
    put(
      "packages/modules/sales/src/processes/multi.ts",
      "const a = 1;\ntx`insert into\n  core.parties(id)\n  values (${1})`;\n",
    );
    const violations = checkRules(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "cross-schema-write", line: 2 });
  });

  it("flags a supabase-js write whose call is split across lines", () => {
    put(
      "packages/modules/sales/src/processes/multi2.ts",
      'await db\n  .from("core.parties")\n  .upsert({});\n',
    );
    expect(checkRules(root).map((v) => v.rule)).toEqual(["cross-schema-write"]);
  });

  it("allows reading another schema (published views)", () => {
    put(
      "packages/modules/sales/src/processes/read.ts",
      [
        "tx`select * from core.v_parties where id = ${1}`;",
        'await db.from("core.v_parties").select();',
        "tx`insert into sales.orders(party_id) select id from core.v_parties`;",
        "tx`insert into sales.orders(id) values (1)`; tx`select 1 from kernel.v_x`;",
      ].join("\n"),
    );
    expect(checkRules(root)).toEqual([]);
  });

  it("flags DDL on another schema", () => {
    put("packages/modules/sales/src/processes/ddl.ts", "tx`alter table core.parties add column x int`;\n");
    expect(checkRules(root).map((v) => v.rule)).toEqual(["cross-schema-write"]);
  });

  it("accepts writes to the module's own schema and writes outside processes/", () => {
    put(
      "packages/modules/core/src/processes/ok.ts",
      "tx`insert into core.parties(id) values (${1})`; tx`update core.parties set a = 1`;\n",
    );
    put("packages/modules/core/src/other.ts", "tx`insert into kernel.x(id) values (1)`;\n");
    expect(checkRules(root)).toEqual([]);
  });
});

describe("check-rules: reads through masked views in apps/web and packages/agent (rule 14)", () => {
  it("flags a select from a module table instead of its v_ view", () => {
    put("apps/web/src/lib/grid/read.ts", "export const q = (tx) => tx`select id, legal_name from core.parties where id = ${1}`;\n");
    put(
      "packages/agent/src/tools/products.ts",
      ["const rows = await tx`", "  select p.sku", "  from core.v_products v", "  join core.products p on p.id = v.id`;"].join("\n"),
    );
    const violations = checkRules(root);
    expect(violations.map((v) => [v.rule, v.file, v.line])).toEqual([
      ["masked-view-read", "packages/agent/src/tools/products.ts", 4],
      ["masked-view-read", "apps/web/src/lib/grid/read.ts", 1],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
    expect(violations[0]!.message).toMatch(/core\.parties directly; read core\.v_parties/);
    expect(violations[1]!.message).toMatch(/core\.products/);
  });

  it("accepts masked views, platform schemas, writes, tests and code outside the two packages", () => {
    put(
      "apps/web/src/lib/ok.ts",
      [
        "tx`select * from core.v_parties where id = ${1}`;",
        "tx`select storage_path from kernel.attachments where id = ${1}`;",
        "tx`select raw_app_meta_data from auth.users`;",
        "tx`delete from core.parties where id = ${1}`;",
        "// select legal_name from core.parties (a comment)",
      ].join("\n"),
    );
    put("apps/web/src/app/api/grid/__tests__/x.integration.test.ts", "sql`select * from core.parties`;\n");
    put("apps/web/e2e/grid.spec.ts", "sql`select * from core.parties`;\n");
    put("apps/web/test-support/fixtures.ts", "sql`select * from core.parties`;\n");
    put("packages/modules/core/src/processes/party.ts", "tx`select * from core.parties where id = ${1}`;\n");
    expect(checkRules(root)).toEqual([]);
  });
});

describe("check-rules: CLAUDE.md and AGENTS.md (project instructions)", () => {
  it("passes when the two files are byte-identical", () => {
    put("CLAUDE.md", "# rules\n");
    put("AGENTS.md", "# rules\n");
    expect(checkRules(root)).toEqual([]);
  });

  it("flags files that differ", () => {
    put("CLAUDE.md", "# rules\n");
    put("AGENTS.md", "# rules (copy)\n");
    const violations = checkRules(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "agents-claude-identical", file: "AGENTS.md" });
  });
});
