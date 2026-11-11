import { describe, it, expect } from "vitest";
import { GENERIC_VERBS, loadModules, menuItemsOf, Registry, uncoveredMenuProcesses } from "@erp/kernel";
import { core } from "../index";

describe("core manifest", () => {
  it("loads into a registry with every brief process, entity and feature", () => {
    const registry = new Registry();
    loadModules(registry, [core]);
    expect(registry.processes({ module: "core" }).map((p) => p.id).sort()).toEqual(
      [
        "core.party.create", "core.party.update", "core.party.deactivate", "core.party.consult",
        "core.contact.create", "core.contact.update", "core.contact.delete", "core.contact.list",
        "core.category.create", "core.category.update", "core.category.consult",
        "core.product.create", "core.product.update", "core.product.deactivate", "core.product.consult",
        "core.sequence.next",
        "core.document_sequence.register",
        "core.uom.consult", "core.price_list.consult", "core.price_list_item.consult", "core.price_list.create", "core.price_list_item.set", "core.price_list_item.remove", "core.party_contact.consult", "core.document_sequence.consult",
        // Tasas de cambio (plan 2B.2 Task 34.1).
        "core.exchange_rate.set", "core.exchange_rate.override_official", "core.exchange_rate.import_official", "core.exchange_rate.for_date",
        "core.exchange_rate.consult", "core.exchange_rate_import.consult",
        // The kernel's generic lifecycle processes of the four maestros (entity types spec §5).
        ...["core.party", "core.product_category", "core.product", "core.price_list"].flatMap((e) => GENERIC_VERBS.map((v) => `${e}.${v}`)),
      ].sort(),
    );
    expect(registry.entities("core").map((e) => e.id)).toEqual(
      expect.arrayContaining([
        "core.party", "core.product", "core.uom", "core.price_list", "core.party_contact", "core.product_category",
        "core.price_list_item", "core.document_sequence", "core.exchange_rate", "core.exchange_rate_import",
      ]),
    );
    expect(core.features.map((f) => f.id)).toEqual(["core.parties", "core.products", "core.settings"]);
    expect(core.events.emits).toEqual(["core.party.created", "core.party.updated", "core.product.created", "core.product.updated"]);
    expect(core.navigation.map((n) => n.href)).toEqual(["#", "#", "#", "#", "/parties", "/products", "/categories", "/exchange-rates", "/import"]);
    // Entity types spec §2.4: once loaded the level-1 items are the four sections; the maestros sit under Maestros, Importar stays.
    const loaded = registry.module("core").navigation;
    expect(loaded.map((n) => [n.id, n.children?.map((c) => c.href)])).toEqual([
      ["core.maestros", ["/parties", "/products", "/categories"]],
      ["core.documentos", []],
      ["core.reportes", []],
      // Tasas de cambio (Task 34.1, a parametro) and the kernel's Parámetros screens of the module's maestros (Task 16).
      ["core.parametros", ["/exchange-rates", "/core/parametros/tipos", "/core/parametros/destinatarios", "/core/parametros/plantillas"]],
      ["core.import", undefined],
    ]);
  });

  it("every entity has its own consult process (the grid and the record read through it)", () => {
    const consults = new Set(core.processes.filter((p) => p.kind === "consult").map((p) => p.id));
    for (const entity of core.entities) {
      const name = entity.id.slice(entity.id.indexOf(".") + 1);
      const own = [`${entity.id}.consult`, `core.${name.split("_").at(-1)}.consult`];
      expect(own.some((id) => consults.has(id)), entity.id).toBe(true);
    }
  });

  it("every process belongs to exactly one feature, and labels are i18n keys", () => {
    const listed = core.features.flatMap((f) => f.processes);
    expect(listed.sort()).toEqual(core.processes.map((p) => p.id).sort());
    for (const entity of core.entities) {
      expect(entity.label).toBe(`entity.${entity.id}`);
      for (const field of entity.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });

  it("every process sits under a menu item or is declared shared: hiding an item refuses what its screen runs (spec §9.2)", () => {
    const registry = new Registry();
    loadModules(registry, [core]);
    const module = registry.module("core");
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    const under = (navKey: string) => menuItemsOf(module).find((r) => r.navKey === navKey)!.processIds;
    expect(under("core.parties")).toEqual(expect.arrayContaining(["core.contact.create", "core.contact.update", "core.contact.delete", "core.contact.list"]));
    expect(under("core.categories")).toEqual(expect.arrayContaining(["core.category.consult", "core.category.create", "core.category.update"]));
    // Importar datos runs the kernel's shared import: hiding it hides that page only (an import is refused by its target's item).
    expect(under("core.import")).toEqual([]);
    // Shared: lookups and numbering every screen uses, and the price lists, which have no screen yet.
    // Task 34.1: the rate of a day every foreign-currency form reads, and the import log, which has no screen.
    expect(module.menuShared).toEqual([
      "core.sequence.next", "core.document_sequence.consult", "core.document_sequence.register", "core.uom.consult", "core.price_list.", "core.price_list_item.",
      "core.exchange_rate.for_date", "core.exchange_rate_import.consult",
    ]);
    expect(under("core.exchange_rates")).toEqual(expect.arrayContaining(["core.exchange_rate.set", "core.exchange_rate.override_official", "core.exchange_rate.import_official", "core.exchange_rate.consult"]));
  });
});
