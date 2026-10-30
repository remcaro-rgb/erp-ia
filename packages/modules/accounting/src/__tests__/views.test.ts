import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defineEntity, maskedViewSql } from "@erp/kernel";
import { LEDGER_ENTITIES, MASTER_ENTITIES } from "../entities";

const read = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const masters = read("0031_accounting_masters.sql");
const ledger = read("0032_accounting_ledger.sql");

// The masked views are pasted into the migrations from maskedViewSql (rule 14). This guards against drift between the entity
// definitions and the SQL: the generated column list must appear verbatim. Views that add a filter (the account security of
// §5.13) keep the generated text up to their `from` line.
function check(migration: string, entities: typeof MASTER_ENTITIES) {
  for (const entity of entities) {
    it(`accounting.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      const generated = maskedViewSql(defineEntity(entity));
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
