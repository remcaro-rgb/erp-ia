import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defineEntity, maskedViewSql } from "@erp/kernel";
import { CORE_ENTITIES } from "../entities";

const migration = readFileSync(new URL("../../../../../supabase/migrations/0006_core_master_data.sql", import.meta.url), "utf8");

// The masked views are pasted into the migration from maskedViewSql (rule 14). This guards against
// drift between the entity definitions and the SQL: the generated column list must appear verbatim.
// Views that add a filter (party scope) keep the generated text up to their `from` line.
describe("core masked views", () => {
  for (const entity of CORE_ENTITIES.filter((e) => e.id !== "core.uom")) {
    it(`core.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const head = generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`));
      expect(migration).toContain(head);
      expect(migration).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }
});
