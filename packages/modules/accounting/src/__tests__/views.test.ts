import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defineEntity, maskedViewSql } from "@erp/kernel";
import { LEDGER_ENTITIES, MASTER_ENTITIES, ledgerLineEntity } from "../entities";

const read = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const masters = read("0031_accounting_masters.sql");
const ledger = read("0032_accounting_ledger.sql");
const views = read("0033_accounting_views.sql");
const figures = read("0036_accounting_period_figures.sql");

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

describe("accounting masked views, migration 0031 (masters)", () => check(masters, MASTER_ENTITIES));

describe("accounting masked views, migration 0032 (ledger)", () => check(ledger, LEDGER_ENTITIES));

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

describe("accounting masked views, migration 0036 (period figures)", () => {
  for (const entity of MASTER_ENTITIES.filter((e) => e.fields.some((f) => f.viewExpr))) {
    it(`accounting.v_${entity.table} gains the period_figure column of ${entity.id}`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      expect(figures).toContain(generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`)));
      expect(figures).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }

  it("keeps the account security filter of design §5.13 on v_accounts", () => {
    expect(figures).toMatch(/from accounting\.accounts\s+where accounting\.can_view_account\(id\);/);
  });
});
