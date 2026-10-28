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
  it("accepts NNNN_module_topic.sql and NNNNx_module_topic.sql", () => {
    put("supabase/migrations/.keep");
    put("supabase/migrations/0001_kernel_tenancy.sql");
    put("supabase/migrations/0006b_kernel_attachments.sql");
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

  it("flags a migration with a timestamp-style or uppercase name", () => {
    put("supabase/migrations/20261028010101_init.sql");
    put("supabase/migrations/0002_Kernel_audit.sql");
    expect(checkRules(root).map((v) => v.rule)).toEqual(["migration-name", "migration-name"]);
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

  it("accepts writes to the module's own schema and writes outside processes/", () => {
    put(
      "packages/modules/core/src/processes/ok.ts",
      "tx`insert into core.parties(id) values (${1})`; tx`update core.parties set a = 1`;\n",
    );
    put("packages/modules/core/src/other.ts", "tx`insert into kernel.x(id) values (1)`;\n");
    expect(checkRules(root)).toEqual([]);
  });
});
