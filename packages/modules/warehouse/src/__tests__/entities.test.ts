import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineEntity, kernelModule, loadModules, maskedViewSql, Registry, uncoveredMenuProcesses, uncoveredRecordWrites } from "@erp/kernel";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { warehouse, WAREHOUSE_ENTITIES } from "../index";

// The warehouse manifest (plan 2B.2 Task 29.1, PG §4.2–§4.3): the Parámetros de bodega, the alistamiento (documento numbered ALI- on save
// that never posts) and its lines, the events it consumes and emits, and the masked views of migration 0170 generated from the definitions;
// Task 29.3 adds the empaque (EMP-) with its packages, the reglas de ubicación and the put-away of a receipt (migration 0172).

const migration = ["0170_warehouse_core.sql", "0172_warehouse_packs_putaway.sql"]
  .map((file) => readFileSync(new URL(`../../../../../supabase/migrations/${file}`, import.meta.url), "utf8")).join("\n");

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, inventory, costing, warehouse]);
  return registry;
};

describe("warehouse manifest", () => {
  it("depends on core and inventory, declares the four menu sections and its four features", () => {
    expect(warehouse.id).toBe("warehouse");
    expect(warehouse.dependsOn).toEqual(["core", "inventory"]);
    expect(warehouse.navigation.map((n) => n.id)).toEqual(["warehouse.maestros", "warehouse.documentos", "warehouse.reportes", "warehouse.parametros"]);
    expect(warehouse.features.map((f) => f.id)).toEqual(["warehouse.picking", "warehouse.packing", "warehouse.putaway", "warehouse.settings"]);
    expect(warehouse.features.flatMap((f) => f.entities).sort()).toEqual(WAREHOUSE_ENTITIES.map((e) => e.id).sort());
  });

  it("consumes the pedido's confirmation and cancellation and inventory's answer, each with its line for the card; emits the confirmation", () => {
    expect(Object.keys(warehouse.events.consumes).sort()).toEqual(["inventory.movement.posted", "inventory.reservation.allocated", "sales.order.cancelled", "sales.order.confirmed"]);
    expect(warehouse.events.emits).toEqual(["warehouse.pick.confirmed", "warehouse.putaway.confirmed"]);
    for (const event of Object.keys(warehouse.events.consumes)) expect(warehouse.effects?.[event]?.length, event).toBeGreaterThan(0);
    // Inventory's card line for the confirmation: «Inventario: asigna ubicación y lote a la reserva».
    expect(inventory.effects?.["warehouse.pick.confirmed"]).toEqual(["inventory.effects.pick_allocate"]);
    expect(Object.keys(inventory.events.consumes)).toContain("warehouse.pick.confirmed");
    expect(inventory.events.emits).toContain("inventory.reservation.allocated");
    // Task 29.3: a receipt raises «por ubicar»; the confirmed put-away is relocated by inventory.
    expect(warehouse.effects?.["inventory.movement.posted"]).toEqual(["warehouse.effects.putaway_notify"]);
    expect(inventory.effects?.["warehouse.putaway.confirmed"]).toEqual(["inventory.effects.putaway_relocate"]);
  });

  it("types the settings as parámetro, the alistamiento as a documento numbered on save that neither waits nor posts, its lines as lines", () => {
    expect(Object.fromEntries(WAREHOUSE_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "warehouse.settings": "parametro",
      "warehouse.pick": "documento",
      "warehouse.pick_line": "lines",
      "warehouse.pack": "documento",
      "warehouse.pack_package": "lines",
      "warehouse.putaway_rule": "parametro",
    });
    const pack = WAREHOUSE_ENTITIES.find((e) => e.id === "warehouse.pack")!;
    expect(pack.typed).toMatchObject({ numbering: "on_save", lines: { entity: "warehouse.pack_package", parentField: "pack_id" } });
    expect(pack.processIds).toEqual({ create: "warehouse.pack.create" });
    const pick = WAREHOUSE_ENTITIES.find((e) => e.id === "warehouse.pick")!;
    expect(pick.typed).toMatchObject({ numbering: "on_save", lines: { entity: "warehouse.pick_line", parentField: "pick_id" } });
    expect(pick.processIds).toEqual({ create: "warehouse.pick.create" });
    expect(pick.recordPage).toBeUndefined();
  });

  it("loads with its processes, each in a feature and guarded; settings are step-up; record_allocation runs only from the event", () => {
    const registry = loaded();
    const ids = registry.processes({ module: "warehouse" }).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      "warehouse.pick.create", "warehouse.pick.update", "warehouse.pick.start", "warehouse.pick.confirm", "warehouse.pick.void",
      "warehouse.pick.consult", "warehouse.pick.record_allocation", "warehouse.pick_line.consult", "warehouse.settings.update", "warehouse.settings.consult",
    ]));
    const module = registry.module("warehouse");
    const listed = module.features.flatMap((f) => f.processes).sort();
    expect(listed).toEqual(module.processes.map((p) => p.id).sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    expect(uncoveredRecordWrites(registry).filter((id) => id.startsWith("warehouse."))).toEqual([]);
    expect(registry.process("warehouse.settings.update").sensitivity).toBe("step-up");
    expect(registry.process("warehouse.pick.record_allocation").origins).toEqual(["event"]);
    expect(registry.process("inventory.reservation.allocate").origins).toEqual(["event"]);
    expect(registry.process("warehouse.pick.confirm").emits).toEqual(["warehouse.pick.confirmed"]);
    expect(ids).toEqual(expect.arrayContaining([
      "warehouse.pack.create", "warehouse.pack.update", "warehouse.pack.close", "warehouse.pack.void", "warehouse.pack.consult", "warehouse.pack_package.consult",
      "warehouse.putaway_rule.create", "warehouse.putaway_rule.update", "warehouse.putaway_rule.delete", "warehouse.putaway_rule.consult",
      "warehouse.putaway.suggest", "warehouse.putaway.confirm", "warehouse.putaway.notify",
    ]));
    expect(registry.process("warehouse.putaway.notify").origins).toEqual(["event"]);
    expect(registry.process("warehouse.putaway.confirm").emits).toEqual(["warehouse.putaway.confirmed"]);
    expect(registry.process("inventory.relocation.post").emits).toEqual(["inventory.movement.posted"]);
  });

  it("the empaque prints titled «Lista de empaque» while the screen keeps «Empaque»", async () => {
    const { packRecordTemplate, PACK_PRINT_LINE_COLUMNS } = await import("../print");
    const read = (locale: string) => JSON.parse(readFileSync(new URL(`../../../../i18n/messages/${locale}.json`, import.meta.url), "utf8")) as { warehouse: { print: { pack_title: string } } };
    expect(read("es-419").warehouse.print.pack_title).toBe("Lista de empaque");
    expect(read("en").warehouse.print.pack_title).toBe("Packing list");
    const t = (key: string) => (key === "warehouse.print.pack_title" ? "Lista de empaque" : undefined);
    const pack = packRecordTemplate({ title: "Empaque", t });
    expect(pack.blocks.filter((b) => b.kind === "text" && b.font?.size === 14).map((b) => b.value)).toEqual(["Lista de empaque"]);
    expect(pack.blocks.find((b) => b.kind === "lines")).toMatchObject({ columns: PACK_PRINT_LINE_COLUMNS });
    expect(warehouse.printTemplates?.["warehouse.pack"]).toBeDefined();
  });

  for (const entity of WAREHOUSE_ENTITIES) {
    it(`warehouse.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      expect(migration).toContain(maskedViewSql(defineEntity(entity)));
    });
  }
});
