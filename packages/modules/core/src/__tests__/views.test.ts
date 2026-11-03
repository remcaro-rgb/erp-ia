import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defineEntity, maskedViewSql } from "@erp/kernel";
import { CORE_ENTITIES } from "../entities";

const read = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const masterData = read("0006_core_master_data.sql");
// The maestros' views were created again by 0042 with the lifecycle columns (entity types, Task 8a); the others are still 0006's.
const typedMasters = read("0042_core_masters_typed.sql");
const TYPED = new Set(["core.party", "core.product", "core.product_category", "core.price_list"]);

// The masked views are pasted into the migration from maskedViewSql (rule 14). This guards against
// drift between the entity definitions and the SQL: the generated column list must appear verbatim.
// Views that add a filter (party scope) keep the generated text up to their `from` line.
describe("core masked views", () => {
  for (const entity of CORE_ENTITIES.filter((e) => e.id !== "core.uom")) {
    const migration = TYPED.has(entity.id) ? typedMasters : masterData;
    it(`core.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const head = generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`));
      expect(migration).toContain(head);
      expect(migration).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }

  it("the maestros' views of 0042 hide soft-deleted records, and core.v_parties keeps the party scope", () => {
    for (const table of ["product_categories", "products", "price_lists"]) expect(typedMasters).toContain(`from core.${table}\nwhere deleted_at is null;`);
    expect(typedMasters).toContain("from core.parties\nwhere deleted_at is null and core.party_scope_allows((select kernel.party_scope()), kind);");
  });

  it("core.v_party_readiness (0042) needs a usable party for invoice_ready (rule 10)", () => {
    expect(typedMasters).toMatch(/create or replace view core\.v_party_readiness[\s\S]*"invoice_ready" and kernel\.record_usable\('core\.party', "id"\) as "invoice_ready"/);
  });
});
