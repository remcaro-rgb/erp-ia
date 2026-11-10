import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineEntity, kernelModule, loadModules, maskedViewSql, menuItemsOf, Registry, uncoveredMenuProcesses } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { inventory } from "@erp/module-inventory";
import cogsFixture from "../defaults/cogs-posted.fixture.json" with { type: "json" };
import { costing, COSTING_ENTITIES } from "../index";
import { COST_SOURCES, EVENT_KINDS, UNKNOWN_COST_MODES } from "../entities";
import { cogsPayload } from "../processes/cost";

// The costing manifest (plan 2B Task 8, design §8): three sistema entities, the consumer of inventory.movement.posted, the COGS event the
// 2A rule `cogs-posted` posts, and the masked views of migration 0073 generated from the entity definitions (rule 14).

const migration = readFileSync(new URL("../../../../../supabase/migrations/0073_costing_core.sql", import.meta.url), "utf8");
// Task 9 adds the landed cost, its lines and the settings view (migration 0077).
const landedMigration = readFileSync(new URL("../../../../../supabase/migrations/0077_costing_landed.sql", import.meta.url), "utf8");

// Task 44 adds unknown_cost_mode to the settings (migration 0130), which regenerates the settings view and widens the cost source check.
const unknownMigration = readFileSync(new URL("../../../../../supabase/migrations/0130_costing_unknown_cost_mode.sql", import.meta.url), "utf8");

// Fix round 1 adds the estimated marker to the cost_missing rows (migration 0131), which regenerates their view.
const estimatedMigration = readFileSync(new URL("../../../../../supabase/migrations/0131_costing_cost_missing_estimated.sql", import.meta.url), "utf8");
// Task 45 (R45-2, R45-7) adds the cost of sales part of a late landed cost: the event kind and cost source, the line split and the header's
// cost center; it regenerates both landed cost views (migration 0155).
const lateMigration = readFileSync(new URL("../../../../../supabase/migrations/0155_costing_landed_cogs.sql", import.meta.url), "utf8");

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, inventory, costing]);
  return registry;
};

describe("costing manifest", () => {
  it("depends on core and inventory, declares the four menu sections and its features, emits its events and consumes inventory movements", () => {
    expect(costing.id).toBe("costing");
    expect(costing.dependsOn).toEqual(["core", "inventory"]);
    expect(costing.navigation.map((n) => n.id)).toEqual(["costing.maestros", "costing.documentos", "costing.reportes", "costing.parametros"]);
    expect(costing.features.map((f) => f.id)).toEqual(["costing.costs", "costing.landed_costs", "costing.settings"]);
    expect(costing.features.flatMap((f) => f.entities).sort()).toEqual(COSTING_ENTITIES.map((e) => e.id).sort());
    expect(costing.events.emits).toEqual([
      "costing.cogs.posted", "costing.cogs.returned", "costing.cogs.voided", "costing.cogs.return_voided", "costing.landed_cost.allocated", "costing.landed_cost.voided",
    ]);
    // Every void of a movement takes its cost back (Task 14).
    expect(Object.keys(costing.events.consumes)).toEqual(["inventory.movement.posted", "inventory.movement.voided"]);
  });

  it("types the layers, events and missing costs as sistema, the landed cost as a documento that posts, and labels every entity in its kind's namespace", () => {
    expect(Object.fromEntries(COSTING_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "costing.cost_layer": "sistema",
      "costing.cost_event": "sistema",
      "costing.cost_missing": "sistema",
      "costing.landed_cost": "documento",
      "costing.landed_cost_line": "lines",
      "costing.settings": "parametro",
    });
    const landed = COSTING_ENTITIES.find((e) => e.id === "costing.landed_cost")!;
    expect(landed.typed).toMatchObject({ numbering: "on_save", lines: { entity: "costing.landed_cost_line", parentField: "landed_cost_id" } });
    expect(landed.processIds).toEqual({ create: "costing.landed_cost.allocate" });
    for (const entity of COSTING_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });

  it("loads with its processes, each in its feature and under the shared menu list", () => {
    const registry = loaded();
    const declared = ["costing.cost_event.consult", "costing.cost_layer.consult", "costing.cost_missing.consult", "costing.movement.cost", "costing.movement.void_cost"];
    const landedCost = ["allocate", "void", "consult"].map((v) => `costing.landed_cost.${v}`);
    const rest = ["costing.landed_cost_line.consult", "costing.settings.update", "costing.unknown_cost.set", "costing.settings.consult"];
    const ids = registry.processes({ module: "costing" }).map((p) => p.id);
    // The loader adds the generic lifecycle verbs of the landed cost (Grabar and the rest) that the module does not declare.
    expect(ids).toEqual(expect.arrayContaining([...declared, ...landedCost, ...rest]));
    expect(ids.filter((id) => !declared.includes(id) && !landedCost.includes(id) && !rest.includes(id)).every((id) => id.startsWith("costing.landed_cost."))).toBe(true);
    const module = registry.module("costing");
    expect(module.features.flatMap((f) => f.processes).sort()).toEqual(module.processes.map((p) => p.id).sort());
    expect(uncoveredMenuProcesses(module)).toEqual([]);
  });

  it("menu (Task 10): Costos en destino in Documentos, Capas de costo and Costos pendientes in Reportes, Costeo in Parámetros", () => {
    const module = loaded().module("costing");
    const rows = menuItemsOf(module).filter((r) => r.href && !r.href.startsWith("/costing/parametros/"));
    const at = (navKey: string) => rows.find((r) => r.navKey === navKey)!;
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["costing.landed_costs", "costing.documentos", "/costing/landed-costs"],
      ["costing.layers", "costing.reportes", "/costing/layers"],
      ["costing.missing", "costing.reportes", "/costing/missing"],
      ["costing.settings", "costing.parametros", "/costing/settings"],
    ]);
    expect(at("costing.landed_costs").processIds).toEqual(expect.arrayContaining(["costing.landed_cost.allocate", "costing.landed_cost.void"]));
    expect(at("costing.settings").processIds).toEqual(expect.arrayContaining(["costing.settings.update", "costing.unknown_cost.set"]));
  });

  it("the COGS payload carries every field the 2A fixture of cogs-posted has (cogsId, number, date, lines[].cost, lines[].costCenterId) and the brief's", () => {
    const payload = cogsPayload({
      movementId: "0192b4c0-0000-7000-8000-00000000f003", number: "SV-77", date: "2026-10-30", sourceEntity: "sales.delivery", sourceId: "0192b4c0-0000-7000-8000-00000000f004",
      costCenterId: "0192b4c0-0000-7000-8000-00000000d001",
      lines: [{ lineId: "l1", productId: "p1", categoryId: "c1", warehouseId: "w1", qty: 2, unitCost: 210000, amount: 420000 }],
    });
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(payload)).toEqual(expect.arrayContaining(keys(cogsFixture)));
    expect(keys(payload.lines[0]!)).toEqual(expect.arrayContaining(keys(cogsFixture.lines[0]!)));
    expect(payload).toMatchObject({ cogsId: "0192b4c0-0000-7000-8000-00000000f003", number: "SV-77", date: "2026-10-30", sourceRef: { entity: "sales.delivery", id: "0192b4c0-0000-7000-8000-00000000f004" } });
    expect(payload.lines[0]).toMatchObject({ productId: "p1", categoryId: "c1", qty: 2, unitCost: 210000, amount: 420000, cost: 420000, costCenterId: "0192b4c0-0000-7000-8000-00000000d001" });
  });
});

describe("costing masked views, migrations 0073 and 0077", () => {
  for (const entity of COSTING_ENTITIES) {
    it(`costing.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      // The settings view is the one 0130 recreates (the older text no longer matches the entity).
      const source = entity.id === "costing.settings" ? unknownMigration : entity.id === "costing.cost_missing" ? estimatedMigration
        : entity.id === "costing.landed_cost" || entity.id === "costing.landed_cost_line" ? lateMigration : migration + landedMigration;
      expect(source).toContain(maskedViewSql(defineEntity(entity)));
    });
  }

  it("Task 45, migration 0155: the kind and cost source checks equal EVENT_KINDS and COST_SOURCES; a landed cost's events (both kinds) carry qty 0", () => {
    const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
    expect(lateMigration).toContain(`check (kind in (${list(EVENT_KINDS)}))`);
    expect(lateMigration).toContain(`check (cost_source in (${list(COST_SOURCES)}))`);
    expect(lateMigration).toContain("check ((kind in ('landed_cost', 'landed_cost_cogs')) = (qty = 0))");
    expect(lateMigration).toContain("check (amount_stock >= 0 and amount_cogs >= 0 and amount_stock + amount_cogs = amount)");
  });

  it("settings accept only the average method; the layers carry the method and the FIFO columns", () => {
    expect(migration).toMatch(/create table costing\.settings[\s\S]*method\s+text not null default 'average' check \(method in \('average'\)\)/);
    expect(migration).toMatch(/create table costing\.cost_layers[\s\S]*method\s+text not null default 'average'[\s\S]*source_line_id\s+uuid,[\s\S]*opened_on\s+date,/);
  });

  it("Task 44, migration 0130: the unknown cost mode column and its check equal UNKNOWN_COST_MODES, the cost source check equals COST_SOURCES, the guard names the process", () => {
    const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
    expect(unknownMigration).toContain(`check (unknown_cost_mode in (${list(UNKNOWN_COST_MODES)}))`);
    expect(unknownMigration).toContain(`default 'zero'`);
    expect(unknownMigration).toContain(`check (cost_source in (${list(COST_SOURCES.filter((c) => c !== "landed_cost_cogs"))}))`);
    expect(unknownMigration).toContain("'costing.unknown_cost.set'");
    const settings = COSTING_ENTITIES.find((e) => e.id === "costing.settings")!;
    expect(settings.fields.map((f) => f.name).slice(0, 4)).toEqual(["seq", "method", "unknown_cost_mode", "extra"]);
    expect(settings.fields.find((f) => f.name === "unknown_cost_mode")).toMatchObject({ type: "enum", enumValues: ["zero", "last_known"], valuesKey: "costing.values.unknown_cost_mode" });
  });

  it("fix round 1, migration 0131: the estimated marker is on the row and the entity, and average_costs hides estimated layers", () => {
    expect(estimatedMigration).toContain("add column if not exists estimated boolean not null default false");
    expect(estimatedMigration).toMatch(/m\.status = 'open' and m\.estimated/);
    expect(COSTING_ENTITIES.find((e) => e.id === "costing.cost_missing")!.fields.find((f) => f.name === "estimated")).toMatchObject({ type: "boolean", required: true });
  });
});
