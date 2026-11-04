import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defineEntity, isTypedEntity, maskedViewSql } from "@erp/kernel";
import { ACCOUNTING_ENTITIES, LEDGER_ENTITIES, MASTER_ENTITIES, ledgerLineEntity } from "../entities";

const read = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const masters = read("0031_accounting_masters.sql");
const ledger = read("0032_accounting_ledger.sql");
const views = read("0033_accounting_views.sql");
const accountView = read("0039_accounting_account_view_invoice_ready.sql");
const typedViews = read("0043_accounting_entries_typed.sql");
// 0055 re-creates the entry and template views with their later columns (template options): their generated text lives there.
const templateViews = read("0055_accounting_template_options.sql");
const RECREATED_IN_0055 = new Set(["accounting.entry", "accounting.entry_template"]);

// The masked views are pasted into the migrations from maskedViewSql (rule 14). This guards against drift between the entity
// definitions and the SQL: the generated column list must appear verbatim. Views that add a filter (the account security of
// §5.13) keep the generated text up to their `from` line.
function check(migration: string, entities: typeof MASTER_ENTITIES) {
  for (const entity of entities) {
    it(`accounting.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      // A computed column (`viewExpr`) is added by a later migration with `create or replace view`; this one has the stored ones.
      const generated = maskedViewSql(defineEntity({ ...entity, fields: entity.fields.filter((f) => !f.viewExpr), cloneReset: entity.cloneReset?.filter((n) => entity.fields.find((f) => f.name === n && !f.viewExpr)) }));
      const head = generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`));
      expect(migration).toContain(head);
      expect(migration).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }
}

// The maestros and the comprobante get their views again in 0043 (the lifecycle columns appended), so their generated text lives there.
const NOT_TYPED = MASTER_ENTITIES.filter((e) => !isTypedEntity(e));

describe("accounting masked views, migration 0031 (masters)", () => check(masters, NOT_TYPED));

describe("accounting masked views, migration 0032 (ledger)", () => check(ledger, LEDGER_ENTITIES.filter((e) => !isTypedEntity(e))));

describe("the accounts view", () => {
  it("adds the account security filter of design §5.13", () => {
    expect(masters).toMatch(/from accounting\.accounts\s+where accounting\.can_view_account\(id\);/);
  });
});

describe("accounting views, migration 0033 (published views)", () => {
  it("accounting.v_ledger_lines is the generated masked view of accounting.ledger_line over the base view", () => {
    const generated = maskedViewSql(defineEntity(ledgerLineEntity));
    expect(views).toContain(generated);
    expect(views).toMatch(/create or replace view accounting\.ledger_lines[\s\S]*where accounting\.can_view_account\(l\.account_id\);/);
  });

  it("v_entry_lines keeps the generated masking and masks a restricted line", () => {
    const start = views.indexOf("create or replace view accounting.v_entry_lines");
    const block = views.slice(start, views.indexOf("grant select on accounting.v_entry_lines", start));
    expect(block).toContain(`case when (select kernel.field_visible('accounting.entry_line', 'debit')) and "can_view" then "debit" else null end as "debit"`);
    expect(block).toContain(`not "can_view" as "is_restricted"`);
  });
});

describe("accounting masked views, migration 0039 (account view)", () => {
  it("v_accounts carried invoice readiness and the account security filter of design §5.13", () => {
    expect(accountView).toContain(`'requires_invoice_ready')) then "requires_invoice_ready"`);
    expect(accountView).toMatch(/from accounting\.accounts\s+where accounting\.can_view_account\(id\);/);
  });
});

describe("accounting masked views, migration 0043 (typed maestros and comprobante)", () => {
  const typed = ACCOUNTING_ENTITIES.filter(isTypedEntity);
  it("covers the seven maestros and the comprobante", () => expect(typed).toHaveLength(8));
  for (const entity of typed) {
    it(`accounting.v_${entity.table} is the generated masked view of ${entity.id}, with the lifecycle columns`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const head = generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`));
      // A view re-created in 0055 can only append columns, so its columns follow the migration's order: each generated column line must appear.
      if (RECREATED_IN_0055.has(entity.id)) for (const line of head.split("\n").filter((l) => l.trim().startsWith("case when") || l.trim().startsWith('"'))) expect(templateViews).toContain(line.replace(/,$/, ""));
      else expect(typedViews).toContain(head);
      expect(typedViews).toContain(`case when (select kernel.field_visible('${entity.id}', 'status')) then "status" else null end as "status"`);
      expect(typedViews).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }

  it("a soft-deleted maestro leaves its view; v_accounts keeps the account security filter of design §5.13", () => {
    expect(typedViews).toMatch(/from accounting\.accounts\s+where deleted_at is null and accounting\.can_view_account\(id\);/);
    for (const table of ["journals", "cost_centers", "open_auxiliaries", "items", "business_units", "entry_templates"]) {
      expect(typedViews).toMatch(new RegExp(`from accounting\\.${table}\\s+where deleted_at is null;`));
    }
  });
});
