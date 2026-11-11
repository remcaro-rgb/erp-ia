import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, menuItemsOf, Registry, uncoveredMenuProcesses } from "@erp/kernel";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { warehouse } from "../index";

// The screens of Bodega (plan 2B.2 Task 29.4, PG §4.4, RG-9): the menu Bodega › Documentos (Alistamientos, Empaques, Ubicar recibidos),
// Reportes (Pendientes por alistar), Parámetros (Reglas de ubicación, Configuración); the «Alistamientos» tab the module adds to the pedido,
// with «Crear alistamiento»; the report «Pendientes por alistar».

const items = () => warehouse.navigation.flatMap((n) => (n.children ?? []).map((c) => ({ section: n.id, ...c })));

describe("warehouse screens (Task 29.4)", () => {
  it("places its screens in the four sections, each guarded by its feature", () => {
    expect(items().map((i) => [i.section, i.id, i.href, i.feature, i.entity ?? null])).toEqual([
      ["warehouse.documentos", "warehouse.picks", "/warehouse/picks", "warehouse.picking", "warehouse.pick"],
      ["warehouse.documentos", "warehouse.packs", "/warehouse/packs", "warehouse.packing", "warehouse.pack"],
      ["warehouse.documentos", "warehouse.putaway", "/warehouse/putaway", "warehouse.putaway", null],
      ["warehouse.reportes", "warehouse.pending_picks", "/warehouse/pending-picks", "warehouse.picking", null],
      ["warehouse.parametros", "warehouse.putaway_rules", "/warehouse/putaway-rules", "warehouse.putaway", "warehouse.putaway_rule"],
      ["warehouse.parametros", "warehouse.settings", "/warehouse/settings", "warehouse.settings", null],
    ]);
    for (const feature of warehouse.features) {
      expect(feature.nav?.map((n) => n.id), feature.id).toEqual(items().filter((i) => i.feature === feature.id).map((i) => i.id));
    }
    expect(warehouse.icon).toBe("package");
  });

  it("guards every process by a menu item but the two the events run alone", () => {
    expect(warehouse.menuShared).toEqual(["warehouse.pick.record_allocation", "warehouse.putaway.notify"]);
    expect(uncoveredMenuProcesses(warehouse)).toEqual([]);
    const guards = Object.fromEntries(menuItemsOf(warehouse).map((r) => [r.navKey, r.processIds]));
    expect(guards["warehouse.picks"]).toEqual(expect.arrayContaining(["warehouse.pick.create", "warehouse.pick.confirm", "warehouse.pick_line.consult"]));
    expect(guards["warehouse.putaway"]).toEqual(["warehouse.putaway.confirm", "warehouse.putaway.notify", "warehouse.putaway.suggest"]);
    expect(guards["warehouse.pending_picks"]).toEqual(["warehouse.report.pending_picks"]);
    expect(guards["warehouse.settings"]).toEqual(["warehouse.settings.consult", "warehouse.settings.update"]);
  });

  it("adds «Alistamientos» to the pedido: its alistamientos by order_id, with «Crear alistamiento» running warehouse.pick.create (RG-9)", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, inventory, costing, warehouse]);
    expect(registry.recordTabsFor("sales.order")).toEqual([
      {
        id: "warehouse.order_picks",
        label: "warehouse.record_tab.picks",
        forEntities: ["sales.order"],
        kind: "grid",
        feature: "warehouse.picking",
        source: "warehouse.pick",
        recordField: "order_id",
        action: { label: "warehouse.record_tab.create_pick", process: "warehouse.pick.create", inputField: "orderId" },
      },
    ]);
    // «Crear alistamiento» is a tool the assistant may call too, behind its card (owner item 212): no origins list.
    expect(registry.process("warehouse.pick.create").origins).toBeUndefined();
  });

  it("registers «Pendientes por alistar» as a report of the alistamientos, read by its consult", () => {
    expect(warehouse.reports?.map((r) => [r.id, r.feature, r.consult])).toEqual([["warehouse.pending_picks", "warehouse.picking", "warehouse.report.pending_picks"]]);
    const report = warehouse.reports![0]!;
    expect(report.columns.map((c) => c.field)).toEqual(["confirmed_at", "order_number", "party_name", "warehouse_name", "lines", "qty_pending", "pick_number", "pick_stage"]);
    expect(warehouse.processes.find((p) => p.id === "warehouse.report.pending_picks")?.kind).toBe("consult");
  });
});
