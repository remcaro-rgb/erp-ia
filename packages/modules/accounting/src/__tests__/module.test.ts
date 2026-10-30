import { describe, it, expect } from "vitest";
import { defineEntity, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { accounting, ACCOUNTING_ENTITIES, DIMENSIONS } from "../index";

describe("accounting manifest", () => {
  it("defineModule accepts the manifest: six bar items, the Maestros group with six children, three features, 20 entities", () => {
    expect(accounting.id).toBe("accounting");
    expect(accounting.dependsOn).toEqual(["core"]);
    expect(accounting.navigation.map((n) => n.id)).toEqual([
      "accounting.entries", "accounting.movements", "accounting.masters", "accounting.periods", "accounting.reports", "accounting.posting",
    ]);
    const masters = accounting.navigation.find((n) => n.id === "accounting.masters")!;
    expect(masters.href).toBe("#");
    expect(masters.children?.map((n) => n.href)).toEqual([
      "/accounting/accounts", "/accounting/cost-centers", "/accounting/open-auxiliaries", "/accounting/items",
      "/accounting/business-units", "/accounting/journals",
    ]);
    expect(accounting.features.map((f) => f.id)).toEqual(["accounting.ledger", "accounting.periods", "accounting.posting"]);
    expect(accounting.entities).toHaveLength(20);
    expect(new Set(accounting.entities.map((e) => e.id)).size).toBe(20);
    // Every entity belongs to exactly one feature.
    const listed = accounting.features.flatMap((f) => f.entities).sort();
    expect(listed).toEqual(accounting.entities.map((e) => e.id).sort());
  });

  it("emits the seven events of the design and consumes every event through the posting engine marker", () => {
    expect(accounting.events.emits).toEqual([
      "accounting.entry.submitted", "accounting.entry.posted", "accounting.entry.reversed", "accounting.period.closed",
      "accounting.period.reopened", "accounting.year.closed", "accounting.posting.failed",
    ]);
    expect(Object.keys(accounting.events.consumes)).toEqual(["*"]);
  });

  it("loads into a registry after core and registers every entity with i18n keys for labels", () => {
    const registry = new Registry();
    loadModules(registry, [core, accounting]);
    expect(registry.entities("accounting")).toHaveLength(20);
    for (const entity of ACCOUNTING_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });

  it("ledger_line is a query entity over v_ledger_lines whose grid consult is <entity>.list; the others are tables", () => {
    const line = ACCOUNTING_ENTITIES.find((e) => e.id === "accounting.ledger_line")!;
    expect(line.kind).toBe("query");
    expect(line.table).toBe("ledger_lines");
    expect(ACCOUNTING_ENTITIES.filter((e) => e.kind === "query")).toHaveLength(1);
  });

  it("the four dimensions are entities with the shared shape and their own table", () => {
    expect([...DIMENSIONS]).toEqual(["cost_center", "open_auxiliary", "item", "business_unit"]);
    for (const dimension of DIMENSIONS) {
      const entity = defineEntity(ACCOUNTING_ENTITIES.find((e) => e.id === `accounting.${dimension}`)!);
      expect(entity.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining(["code", "name", "parent_id", "kind", "is_active", "seq", "extra", "extra_free"]),
      );
      expect(entity.fields.find((f) => f.name === "parent_id")?.ref?.entity).toBe(entity.id);
    }
  });

  it("references point at accounting.account (code), core.party (legal_name) and the dimensions (name)", () => {
    const line = defineEntity(ACCOUNTING_ENTITIES.find((e) => e.id === "accounting.entry_line")!);
    const target = (name: string) => line.fields.find((f) => f.name === name)?.ref;
    expect(target("account_id")).toEqual({ entity: "accounting.account", display: "code" });
    expect(target("party_id")).toEqual({ entity: "core.party", display: "legal_name" });
    expect(target("cost_center_id")).toEqual({ entity: "accounting.cost_center", display: "name" });
    expect(target("business_unit_id")).toEqual({ entity: "accounting.business_unit", display: "name" });
  });

  it("contributes the Contabilidad tab to every record, the revenue account to categories and Cuentas to roles and users; four home cards", () => {
    const registry = new Registry();
    loadModules(registry, [core, accounting]);
    const ids = (entity: string) => registry.recordTabsFor(entity).map((t) => t.id);
    expect(ids("core.party")).toEqual(["accounting.entries"]);
    expect(ids("core.product_category")).toEqual(["accounting.entries", "accounting.category_revenue"]);
    expect(ids("kernel.role")).toEqual(["accounting.entries", "accounting.subject_accounts"]);
    expect(ids("kernel.user")).toEqual(["accounting.entries", "accounting.subject_accounts"]);
    const revenue = registry.recordTabsFor("core.product_category").find((t) => t.id === "accounting.category_revenue")!;
    expect(revenue).toMatchObject({ kind: "mapping", dimension: "category:{id}", roles: ["revenue"], lookupEntity: "accounting.account", saveProcess: "accounting.account_role_mapping.update" });
    // Every grid tab reads a registered entity.
    for (const tab of accounting.recordTabs ?? []) if (tab.kind === "grid") expect(registry.entity(tab.source!).id).toBe(tab.source);
    expect(accounting.homeKpis?.map((k) => k.id)).toEqual(["accounting.result_month", "accounting.pending_failures", "accounting.open_periods", "accounting.draft_entries"]);
  });
});
