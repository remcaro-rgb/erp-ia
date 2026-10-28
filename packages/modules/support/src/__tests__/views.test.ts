import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineEntity, maskedViewSql } from "@erp/kernel";
import { support } from "../index";

const migration = readFileSync(new URL("../../../../../supabase/migrations/0017_support_tickets.sql", import.meta.url), "utf8");

// The masked views are pasted into the migration from maskedViewSql (rule 14); this fails when the entity
// definitions and the SQL drift apart. The views add no filter: the row policies of the tables do the scoping.
describe("support masked views", () => {
  for (const entity of support.entities) {
    it(`support.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      expect(migration).toContain(maskedViewSql(defineEntity(entity)));
    });
  }
});
