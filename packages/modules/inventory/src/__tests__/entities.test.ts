import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ruleApplies, RuleTemplate, defineEntity, GENERIC_VERBS, isTypedEntity, kernelModule, loadModules, maskedViewSql, Registry, menuItemsOf, uncoveredMenuProcesses, uncoveredRecordWrites } from "@erp/kernel";
import { needStub } from "@erp/kernel/testing";
import { core } from "@erp/module-core";
import { inventory, INVENTORY_ENTITIES, INVENTORY_POSTING_RULES } from "../index";
import adjustmentFixture from "../defaults/inventory-adjustment.fixture.json" with { type: "json" };
import { savedMovementId } from "../processes/common";

// The inventory manifest (plan 2B Task 6, design §8): two maestros (bodegas, ubicaciones), one documento (movimiento) with its lines, the
// stock levels and the reservations (sistema). Every view of the migration is the generated masked view of its entity (rule 14).

// The views of the first six entities are in 0066, those of the traslados and conteos (Task 7) in 0069, those of the lots, serials,
// tracking and allocations (Task 28.1) in 0162.
const migration = ["0066_inventory_core.sql", "0069_inventory_transfers_counts.sql", "0162_inventory_lots_serials.sql"]
  .map((file) => readFileSync(new URL(`../../../../../supabase/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, inventory, needStub("costing")]);
  return registry;
};

describe("inventory manifest", () => {
  it("ships the inventory-adjustment posting rule (moved from accounting's defaults, Task 50.14), valid and applying to its fixture", () => {
    expect(inventory.postingRules).toBe(INVENTORY_POSTING_RULES);
    expect(INVENTORY_POSTING_RULES.map((r) => `${r.event} · ${r.name}`)).toEqual(["inventory.movement.posted · Ajuste de inventario"]);
    const rule = INVENTORY_POSTING_RULES[0]!;
    expect(RuleTemplate.safeParse(rule.template).success).toBe(true);
    expect(ruleApplies(rule.template as never, adjustmentFixture as never)).toBe(true);
    expect(ruleApplies(rule.template as never, { ...adjustmentFixture, kind: "receipt" } as never)).toBe(false);
  });

  it("depends on core, declares the four menu sections and the two features", () => {
    expect(inventory.id).toBe("inventory");
    expect(inventory.dependsOn).toEqual(["core"]);
    // Costing already depends on inventory, so inventory names it in `needs` (not a load-order edge; plan 2B Task 41, Ruling R41-1).
    expect(inventory.needs).toEqual(["costing"]);
    expect(inventory.navigation.map((n) => n.id)).toEqual(["inventory.maestros", "inventory.documentos", "inventory.reportes", "inventory.parametros"]);
    expect(inventory.features.map((f) => f.id)).toEqual(["inventory.warehouses", "inventory.stock"]);
    // Every entity belongs to exactly one feature.
    expect(inventory.features.flatMap((f) => f.entities).sort()).toEqual(INVENTORY_ENTITIES.map((e) => e.id).sort());
  });

  it("types every entity: bodega and ubicación maestros, movimiento documento numbered on save, its lines, stock and reservations sistema", () => {
    const byId = Object.fromEntries(INVENTORY_ENTITIES.map((e) => [e.id, e]));
    expect(Object.fromEntries(INVENTORY_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "inventory.warehouse": "maestro",
      "inventory.location": "maestro",
      "inventory.movement": "documento",
      "inventory.movement_line": "lines",
      "inventory.stock_level": "sistema",
      "inventory.reservation": "sistema",
      "inventory.transfer": "documento",
      "inventory.transfer_line": "lines",
      "inventory.count": "documento",
      "inventory.count_line": "lines",
      // Task 28.1 (PG §3.1): lots and serials are maestros, the tracking per product a parametro, the allocations of a reservation sistema.
      "inventory.lot": "maestro",
      "inventory.serial": "maestro",
      "inventory.product_tracking": "parametro",
      "inventory.reservation_allocation": "sistema",
    });
    const movement = byId["inventory.movement"]!;
    expect(movement.typed?.numbering).toBe("on_save");
    expect(movement.typed?.lines).toEqual({ entity: "inventory.movement_line", parentField: "movement_id" });
    // contabiliza false and no approval: the movement sets both flags itself (spec §5.4, ownFlags).
    expect(movement.typed?.ownFlags).toEqual({ requiresApproval: "inventory.movement.own_flags.requires_approval", posts: "inventory.movement.own_flags.posts" });
    // OD-8, Task 28.1: the line and stock tables name the lot and the serial as references to their maestros (a link, rule 21).
    for (const id of ["inventory.movement_line", "inventory.stock_level"]) {
      const fields = Object.fromEntries(byId[id]!.fields.map((f) => [f.name, f]));
      expect(fields.lot_id).toMatchObject({ type: "ref", ref: { entity: "inventory.lot", display: "code" } });
      expect(fields.serial_id).toMatchObject({ type: "ref", ref: { entity: "inventory.serial", display: "serial_no" } });
    }
    // The lot and serial keep their own state apart from the maestro lifecycle `status` (kernel.typed_columns owns that column).
    expect(byId["inventory.lot"]!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["product_id", "code", "expires_on", "produced_on", "lot_status", "note"]));
    expect(byId["inventory.lot"]!.importKey).toEqual(["product_id", "code"]);
    expect(byId["inventory.serial"]!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["product_id", "serial_no", "lot_id", "serial_status", "note"]));
    expect(byId["inventory.serial"]!.importKey).toEqual(["product_id", "serial_no"]);
    expect(byId["inventory.product_tracking"]!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["product_id", "tracking", "fefo", "expiry_required", "block_expired"]));
    expect(byId["inventory.reservation_allocation"]!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["reservation_id", "location_id", "lot_id", "serial_id", "qty"]));
    expect(byId["inventory.movement_line"]!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["product_id", "location_id", "qty", "uom"]));
    expect(byId["inventory.warehouse"]!.fields.map((f) => f.name)).toContain("allow_backorders");
  });

  it("loads with the brief processes and the generic lifecycle of the typed entities; the movement keeps its own Anular", () => {
    const registry = loaded();
    const generic = (entity: string, except: string[] = []) => GENERIC_VERBS.filter((v) => !except.includes(v)).map((v) => `${entity}.${v}`);
    expect(registry.processes({ module: "inventory" }).map((p) => p.id).sort()).toEqual(
      [
        "inventory.warehouse.create", "inventory.warehouse.update", "inventory.warehouse.consult",
        "inventory.location.create", "inventory.location.update", "inventory.location.consult",
        "inventory.movement.post", "inventory.movement.void", "inventory.movement.consult",
        "inventory.movement_line.consult", "inventory.stock_level.consult",
        "inventory.reservation.create", "inventory.reservation.release", "inventory.reservation.reserve_again", "inventory.reservation.consult",
        // What the entregas and devoluciones of sales move (Task 14 review): each event consumer runs a registered process.
        "inventory.sale.issue", "inventory.sale.void_issue", "inventory.sale.return", "inventory.sale.void_return",
        "inventory.transfer.create", "inventory.transfer.ship", "inventory.transfer.receive", "inventory.transfer.void", "inventory.transfer.consult", "inventory.transfer_line.consult",
        "inventory.adjustment.post",
        "inventory.count.create", "inventory.count.record", "inventory.count.apply", "inventory.count.void", "inventory.count.consult", "inventory.count_line.consult",
        // Task 28.1: the lot and serial maestros and the tracking parametro.
        "inventory.lot.create", "inventory.lot.update", "inventory.lot.consult",
        "inventory.serial.create", "inventory.serial.update", "inventory.serial.consult",
        "inventory.product_tracking.set", "inventory.product_tracking.consult",
        ...generic("inventory.lot"), ...generic("inventory.serial"),
        ...generic("inventory.warehouse"), ...generic("inventory.location"), ...generic("inventory.movement", ["void"]),
        ...generic("inventory.transfer", ["void"]), ...generic("inventory.count", ["void"]),
      ].sort(),
    );
    // A despacho, or the Anular of a devolución, inventory cannot apply is never dead-lettered silently: it says so to sales by event.
    expect(inventory.events.emits).toEqual(["inventory.movement.posted", "inventory.movement.voided", "inventory.sale_issue.refused", "inventory.sale_return_void.refused", "inventory.delivery_reservation.restored"]);
    // The importer, the clone and Nuevo create a movement through movement.post.
    expect(registry.entity("inventory.movement").processIds?.create).toBe("inventory.movement.post");
  });

  it("every process belongs to one feature, sits under a menu item or the shared list, and declares its record guard", () => {
    const registry = loaded();
    const module = registry.module("inventory");
    const listed = module.features.flatMap((f) => f.processes).sort();
    expect(listed).toEqual(module.processes.map((p) => p.id).sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    expect(uncoveredRecordWrites(registry).filter((id) => id.startsWith("inventory."))).toEqual([]);
  });

  it("menu (Task 10): Bodegas and Ubicaciones in Maestros, Movimientos, Transferencias and Conteos in Documentos, Existencias in Reportes; an ajuste runs under Movimientos", () => {
    const module = loaded().module("inventory");
    const rows = menuItemsOf(module).filter((r) => r.href);
    const at = (navKey: string) => rows.find((r) => r.navKey === navKey)!;
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["inventory.warehouses", "inventory.maestros", "/inventory/warehouses"],
      ["inventory.locations", "inventory.maestros", "/inventory/locations"],
      ["inventory.lots", "inventory.maestros", "/inventory/lots"],
      ["inventory.serials", "inventory.maestros", "/inventory/serials"],
      ["inventory.movements", "inventory.documentos", "/inventory/movements"],
      ["inventory.transfers", "inventory.documentos", "/inventory/transfers"],
      ["inventory.counts", "inventory.documentos", "/inventory/counts"],
      ["inventory.stock", "inventory.reportes", "/inventory/stock"],
      ["inventory.product_tracking", "inventory.parametros", "/inventory/product-tracking"],
      ...rows.filter((r) => r.href!.startsWith("/inventory/parametros/")).map((r) => [r.navKey, r.parentKey, r.href]),
    ]);
    expect(at("inventory.stock").entity).toBe("inventory.stock_level");
    expect(at("inventory.movements").processIds).toEqual(expect.arrayContaining(["inventory.movement.post", "inventory.adjustment.post", "inventory.movement.void"]));
    expect(at("inventory.counts").processIds).toEqual(expect.arrayContaining(["inventory.count.record", "inventory.count.apply"]));
    expect(at("inventory.transfers").processIds).toEqual(expect.arrayContaining(["inventory.transfer.ship", "inventory.transfer.receive"]));
  });

  it("consumes the pedidos, entregas and devoluciones of sales by event name (Tasks 13–14); it depends on no sales", () => {
    expect(Object.keys(inventory.events.consumes).sort()).toEqual([
      "sales.delivery.shipped", "sales.delivery.voided", "sales.order.cancelled", "sales.order.confirmed", "sales.return.received", "sales.return.voided",
    ]);
    expect(inventory.dependsOn).not.toContain("sales");
  });

  it("labels are i18n keys of their kind's namespace", () => {
    for (const entity of INVENTORY_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });
});

describe("inventory masked views, migrations 0066, 0069 and 0162", () => {
  for (const entity of INVENTORY_ENTITIES) {
    it(`inventory.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const head = generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`));
      expect(migration).toContain(head);
      expect(migration).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
      if (isTypedEntity(entity)) expect(migration).toContain(`select kernel.typed_columns('inventory', '${entity.table}'`);
    });
  }

  it("publishes inventory.v_stock for the other modules (on hand, reserved, available, and the kind of the ubicación)", () => {
    expect(migration).toContain("l.kind as location_kind");
    expect(migration).toMatch(/create or replace view inventory\.v_stock with \(security_invoker = true\) as/);
    expect(migration).toContain("grant select on inventory.v_stock to authenticated;");
  });
});

describe("sensitive processes and posted movements (Task 7)", () => {
  it("the adjustment and the count's apply declare the step-up (rule 15); the others do not", () => {
    const registry = loaded();
    const stepUp = registry.processes({ module: "inventory" }).filter((p) => p.sensitivity === "step-up").map((p) => p.id).sort();
    // Task 28.1: switching a product's tracking changes how every later movement is validated (PG §3.7).
    expect(stepUp).toEqual(["inventory.adjustment.post", "inventory.count.apply", "inventory.product_tracking.set"]);
  });

  it("a movement a process posted that is voided or skipped is refused, never reported as done (postedOutput.status)", () => {
    expect(savedMovementId({ id: "m-1", status: "saved" }, "La salida")).toBe("m-1");
    expect(() => savedMovementId({ id: "m-1", status: "voided" }, "La salida")).toThrow(/^movement_not_posted: La salida: el movimiento ya fue anulado/);
    expect(() => savedMovementId({ id: null, status: "skipped" }, "La salida")).toThrow(/^movement_not_posted: La salida: no movió existencias/);
  });
});
